import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentMessage, Model, ModelEvent, ToolCall, ToolResult } from '../src/agent/types.ts';
import { SessionStore } from '../src/session/store.ts';
import { collectWorkProgress, currentChecks, groundReview, readyToReport, reportChecks } from '../src/agent/work-progress.ts';
import { reviewToolWork } from '../src/agent/compaction.ts';
import { readWrittenVersions } from '../src/cli/workspace-verification.ts';

const { runChat }: typeof import('../src/cli/chat.ts') = await import(process.env.MODKH_TEST_CHAT ?? '../src/cli/chat.ts');

const modelId = 'compatible/work-progress';
const html = '<canvas></canvas>';

function workspace(t: TestContext, browser: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-progress-'));
  const root = path.join(dir, 'game');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'browse'), '#!/bin/sh\n' + browser, { mode: 0o755 });
  const home = process.env.MODKH_HOME, previousPath = process.env.PATH;
  process.env.MODKH_HOME = dir;
  process.env.PATH = bin + path.delimiter + previousPath;
  t.after(() => {
    if (home === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = home;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    memory: { enabled: false }, language: { autoInstall: false }, modelContextWindows: { [modelId]: 10000 },
  }));
  return { root, store: new SessionStore() };
}

async function chat(root: string, model: Model, task?: string, resume?: string) {
  const inputs = task ? [task, '/exit'] : ['/exit'];
  let output = '';
  await runChat({ args: { model: model.id, cwd: root, resume }, modelFactory: () => model, terminal: {
    interactive: false, next: async () => inputs.shift() ?? null, write(text) { output += text; }, unread() {},
    ask: async () => null, confirm: async () => 'y', choose: async () => null, showPage: async () => {},
    setModel() {}, close() {},
  } });
  return output;
}

const create: ToolCall = { id: 'write', name: 'create_file', args: { path: 'game.html', content: html } };
const start: ToolCall = { id: 'start', name: 'browse', args: { action: 'click', tab: 7, ref: 'e1' } };
const navigate: ToolCall = { id: 'open', name: 'browse', args: { action: 'navigate', url: 'http://localhost/' } };
const score = { id: 'score', name: 'browse', args: { action: 'snapshot', tab: 7 } };

for (const extraEdit of [false, true]) test('CLI carries verified and pending checks across compactions, then reports the verified revision' +
  (extraEdit ? ' even if the model requests another edit' : ''), { skip: process.platform === 'win32' }, async t => {
  const { root, store } = workspace(t, `case "$1" in
click) case "$3" in
  '{"tab":7,"x":108,"y":68}') echo 1 > score; echo '{"clicked":{"x":108,"y":68}}' ;;
  *) echo '{"clicked":"Start button"}' ;;
  esac ;;
navigate) echo '{"tab":7}' ;;
tabs) echo '{"tabs":[]}' ;;
snapshot) printf 'Score is '; cat score; cat notes ;;
esac\n`);
  fs.writeFileSync(path.join(root, 'notes'), Array.from({ length: 900 }, (_, i) => 'unrelated line ' + i).join('\n'));
  const plan: ToolCall[] = [create, navigate, start, ...Array.from({ length: 5 }, (_, i) =>
    ({ id: 'read-' + i, name: 'read_file', args: { path: 'notes' } }))];
  let step = 0, reviews = 0, reportOnly = false;
  const model: Model = { id: modelId, async *stream(request): AsyncIterable<ModelEvent> {
    const view = request.messages.map(m => m.role === 'tool' ? '' : m.content).join('\n');
    if (!request.tools.length && request.messages.length === 1) {
      reviews++;
      const checked = reviews === 2;
      yield { type: 'text-delta', text: JSON.stringify({
        confirmed: [{ item: checked ? 'Score increases' : 'Game starts', receipt: checked ? 'score' : 'start' }],
        remaining: checked ? [] : ['Verify the score counter'],
      }) };
      yield { type: 'finish', stopReason: 'stop' };
      return;
    }
    let call = plan[step++];
    if (step === plan.length + 1 && view.includes('Start button') && view.includes('Verify the score counter')) {
      call = { id: 'hit', name: 'browse', args: { action: 'click', tab: 7, x: 108, y: 68 } };
    }
    if (step === plan.length + 2 && fs.existsSync(path.join(root, 'score'))) call = score;
    if (!call) {
      reportOnly = request.tools.length === 0 && view.includes('Score is 1');
      if (extraEdit && reportOnly) {
        yield { type: 'tool-call', call: { id: 'extra', name: 'create_file', args: { path: 'polish.html', content: 'not requested' } } };
        yield { type: 'finish', stopReason: 'tool-calls' };
        return;
      }
      yield { type: 'text-delta', text: reportOnly ? 'Game and score confirmed.' : 'Missing work evidence.' };
      yield { type: 'finish', stopReason: 'stop' };
      return;
    }
    yield { type: 'tool-call', call };
    yield { type: 'usage', input: step === plan.length || call.id === score.id ? 8000 : 100, output: 20 };
    yield { type: 'finish', stopReason: 'tool-calls' };
  } };
  const output = await chat(root, model, 'Create game.html, check that the game starts and the score increases.');
  const [summary] = store.list();
  const session = store.load(summary!.id);
  assert.equal(reviews, 2);
  assert.equal(reportOnly, true);
  assert.deepEqual(session.compaction!.review?.confirmed.map(c => c.receipt), ['start', 'score']);
  assert.match(output, extraEdit ? /Score increases/ : /Game and score confirmed/);
  assert.equal(fs.existsSync(path.join(root, 'polish.html')), false);
  assert.match(session.compaction!.summary, new RegExp(createHash('sha256').update(html).digest('hex').slice(0, 12)));
  assert.equal(session.status, 'complete');
});

function exchange(messages: AgentMessage[], call: ToolCall, output: string, extra: Partial<ToolResult> = {}) {
  messages.push({ role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', results: [{ callId: call.id, name: call.name, status: 'ok', output, ...extra }] });
}

test('a retained tab, a reused receipt, and a nonzero command cannot verify a newer file', () => {
  const messages: AgentMessage[] = [{ role: 'user', content: 'Create and verify game.html' }];
  exchange(messages, create, 'saved', { fileDigest: 'a'.repeat(64) });
  exchange(messages, navigate, '{"tab":7}');
  exchange(messages, { ...navigate, id: 'other-tab' }, '{"tab":8}');
  exchange(messages, { ...score, id: 'old-score' }, 'Score is 1');
  const edit = { id: 'edit', name: 'edit_file', args: { path: 'game.html' } };
  exchange(messages, edit, 'edited', { fileDigest: 'b'.repeat(64) });
  exchange(messages, score, 'Score is 1');
  exchange(messages, { id: 'stale-tab', name: 'browse', args: { action: 'snapshot', tab: 8 } }, 'Score is 1');
  exchange(messages, { ...score, id: 'old-score' }, 'Score is 1');
  exchange(messages, { id: 'failed', name: 'run_command', args: {} }, '[exit code: 1]\n--- stdout ---\nerror');
  const progress = collectWorkProgress(messages, 0);
  assert.deepEqual(currentChecks(progress), []);
  const verdict = { confirmed: [{ item: 'Score increases', receipt: 'old-score' }], remaining: [] };
  assert.equal(groundReview(JSON.stringify(verdict), progress), undefined);
  assert.equal(readyToReport(progress, verdict), false);
  exchange(messages, { id: 'reload', name: 'browse', args: { action: 'reload', tab: 7 } }, '{"tab":7}');
  exchange(messages, { ...score, id: 'fresh' }, 'Score is 1');
  const fresh = collectWorkProgress(messages, 0);
  assert.equal(groundReview('invalid JSON', fresh), undefined);
  assert.equal(groundReview(JSON.stringify(verdict), fresh), undefined);
  assert.equal(readyToReport(fresh, { confirmed: [{ item: 'Score increases', receipt: 'fresh' }], remaining: [] }), true);
});

test('a change outside native edits leaves verification open and the session records the historical revision', async t => {
  const { root } = workspace(t, 'exit 0');
  const messages: AgentMessage[] = [{ role: 'user', content: 'Check game.html' }];
  const digest = createHash('sha256').update(html).digest('hex');
  exchange(messages, create, 'saved', { fileDigest: digest });
  exchange(messages, navigate, '{"tab":7}');
  exchange(messages, score, 'Score is 1\n' + 'data0123456789'.repeat(600));
  fs.writeFileSync(path.join(root, 'game.html'), 'changed externally');
  const model: Model = { id: modelId, async *stream() { assert.fail('unmatched revision cannot trigger final review'); } };
  const result = await reviewToolWork(model, messages, undefined, 0, new AbortController().signal, 'test',
    files => readWrittenVersions(root, files), () => {});
  assert.equal(result?.ready, false);
  assert.match(result!.state.summary, /historical/);
  const pinned = createHash('sha256').update('changed externally').digest('hex');
  assert.deepEqual(result!.state.revision?.files, [['game.html', pinned]]);
  const saved = new SessionStore().create(root, modelId);
  for (const message of messages) saved.append(message);
  saved.recordCompaction(result!.state, 0);
  const restored = new SessionStore().load(saved.id).compaction!;
  exchange(messages, { ...score, id: 'before-reload' }, 'Score is 1');
  exchange(messages, { id: 'reload', name: 'browse', args: { action: 'reload', tab: 7 } }, '{"tab":7}');
  exchange(messages, { ...score, id: 'after-reload' }, 'Score is 1\n' + 'large snapshot data'.repeat(600));
  const verify: Model = { id: modelId, async *stream() {
    yield { type: 'text-delta', text: '{"confirmed":[{"item":"Score is 1","receipt":"after-reload"}],"remaining":[]}' };
    yield { type: 'finish', stopReason: 'stop' };
  } };
  const checked = await reviewToolWork(verify, messages, restored, 0, new AbortController().signal, 'test',
    files => readWrittenVersions(root, files), () => {});
  assert.equal(checked?.ready, true);
  assert.equal(checked?.state.revision?.files[0][1], pinned);
});

test('resuming a legacy interrupted journal shows the recorded cause and artifact without any tool or model request', async t => {
  const { root, store } = workspace(t, 'exit 9');
  const session = store.create(root, modelId);
  const messages: AgentMessage[] = [{ role: 'user', content: 'Build and check game.html' }];
  exchange(messages, create, 'game.html saved');
  exchange(messages, start, 'click did not finish within 20 s', { status: 'unknown' });
  for (const message of messages) session.append(message);
  session.setStatus('interrupted');
  const model: Model = { id: modelId, async *stream() { assert.fail('resume must not send a request'); } };
  const out = await chat(root, model, undefined, session.id);
  assert.match(out, /browse click/);
  assert.match(out, /20 s/);
  assert.match(out, /保存済み: game\.html/);
});

test('a lost click acknowledgement reports saved work and its cause without repeating the click', { skip: process.platform === 'win32' }, async t => {
  const { root, store } = workspace(t, `if [ "$1" = click ]; then
  echo click >> attempts
  echo 'click did not finish within 20 s'
  exit 1
fi\n`);
  let step = 0;
  const model: Model = { id: modelId, async *stream(): AsyncIterable<ModelEvent> {
    yield { type: 'tool-call', call: [create, start][step++]! };
    yield { type: 'finish', stopReason: 'tool-calls' };
  } };
  const output = await chat(root, model, 'Build game.html and check that clicking Start opens it.');
  const [summary] = store.list();
  const session = store.load(summary!.id);
  assert.equal(session.status, 'interrupted');
  assert.match(session.lastError ?? '', /browse.*click/);
  assert.match(session.lastError!, /20 s/);
  assert.match(session.lastError!, /game\.html/);
  assert.match(session.lastError!, /未確認/);
  assert.ok(output.includes(session.lastError!));
  assert.equal(fs.readFileSync(path.join(root, 'game.html'), 'utf8'), html);
  assert.ok((await chat(root, model, undefined, session.id)).includes(session.lastError!));
  assert.equal(fs.readFileSync(path.join(root, 'attempts'), 'utf8'), 'click\n');
  assert.equal(step, 2);
  const retry: Model = { id: modelId, async *stream() {
    yield { type: 'tool-call', call: { ...start, id: 'different-id', args: { ...start.args, tab: '7', force: true } } };
    yield { type: 'finish', stopReason: 'tool-calls' };
  } };
  await chat(root, retry, 'Continue the same task.', session.id);
  assert.equal(fs.readFileSync(path.join(root, 'attempts'), 'utf8'), 'click\n', 'equivalent click must not be dispatched');
});

test('CLI pauses before a fourth repair and accepts a new direction in the same session', async t => {
  const { root } = workspace(t, '');
  fs.writeFileSync(path.join(root, 'value.txt'), '0');
  const edit = (i: number): ToolCall => ({ id: 'edit-' + i, name: 'edit_file',
    args: { path: 'value.txt', old_string: String(i - 1), new_string: String(i) } });
  const calls = [1, 2, 3].flatMap(i => [edit(i), { id: 'check-' + i, name: 'run_command',
    args: { command: 'echo mismatch && exit 1' } }]).concat(edit(4));
  let resumed = false;
  const model: Model = { id: modelId, async *stream(request): AsyncIterable<ModelEvent> {
    resumed = request.messages.some(m => m.role === 'user' && m.content === 'Keep the current value.');
    const call = calls.shift();
    if (call) yield { type: 'tool-call', call };
    else yield { type: 'text-delta', text: 'Done.' };
    yield { type: 'finish', stopReason: call ? 'tool-calls' : 'stop' };
  } };
  const inputs = ['Fix the mismatch.', 'Keep the current value.', '/exit'];
  let output = '';
  await runChat({ args: { model: model.id, cwd: root }, modelFactory: () => model, terminal: {
    interactive: false, next: async () => inputs.shift() ?? null, write(text) { output += text; }, unread() {},
    ask: async () => null, confirm: async () => 'y', choose: async () => null, showPage: async () => {},
    setModel() {}, close() {},
  } });
  assert.equal(fs.readFileSync(path.join(root, 'value.txt'), 'utf8'), '3', output);
  assert.match(output, /修正を続けますか/);
  assert.equal(resumed, true);
});

test('visual retries pause only after three edited revisions of the same view', async t => {
  const { root } = workspace(t, 'echo unchanged');
  fs.writeFileSync(path.join(root, 'value.txt'), '0');
  fs.writeFileSync(path.join(root, 'preview.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTioAAAAASUVORK5CYII=', 'base64'));
  const calls: ToolCall[] = [];
  for (let i = 1; i <= 4; i++) {
    calls.push({ id: 'edit-' + i, name: 'edit_file',
      args: { path: 'value.txt', old_string: String(i - 1), new_string: String(i) } });
    for (let j = 0; j < 3; j++) calls.push({
      id: 'view-' + i + '-' + j, name: 'view_image', args: { path: 'preview.png' },
    });
  }
  const model: Model = { id: modelId, async *stream(): AsyncIterable<ModelEvent> {
    const call = calls.shift();
    if (call) yield { type: 'tool-call', call };
    else yield { type: 'text-delta', text: 'Done.' };
    yield { type: 'finish', stopReason: call ? 'tool-calls' : 'stop' };
  } };
  const output = await chat(root, model, 'Improve the preview.');
  assert.match(output, /修正を続けますか/);
  assert.equal(fs.readFileSync(path.join(root, 'value.txt'), 'utf8'), '3');
});

test('changing failure counts and a passing check allow the next edit', async t => {
  const { root } = workspace(t, '');
  fs.writeFileSync(path.join(root, 'remaining'), '5');
  const calls: ToolCall[] = [];
  for (let i = 4; i >= 0; i--) {
    calls.push({ id: 'repair-' + i, name: 'edit_file',
      args: { path: 'remaining', old_string: String(i + 1), new_string: String(i) } },
    { id: 'verify-' + i, name: 'run_command', args: { command: 'cat remaining && test "$(cat remaining)" = 0' } });
  }
  const model: Model = { id: modelId, async *stream(): AsyncIterable<ModelEvent> {
    const call = calls.shift();
    if (call) yield { type: 'tool-call', call };
    else yield { type: 'text-delta', text: 'Finished.' };
    yield { type: 'finish', stopReason: call ? 'tool-calls' : 'stop' };
  } };
  const output = await chat(root, model, 'Resolve the remaining failures.');
  assert.doesNotMatch(output, /修正を続けますか/);
  assert.match(output, /Finished\./);
  assert.equal(fs.readFileSync(path.join(root, 'remaining'), 'utf8'), '0');
});

test('a visual review receives the current screenshot pixels and can finish without reopening a file', async () => {
  const messages: AgentMessage[] = [{ role: 'user', content: 'Verify the fish appearance' }];
  const digest = 'a'.repeat(64);
  exchange(messages, create, 'saved' + 'x'.repeat(9000), { fileDigest: digest });
  exchange(messages, navigate, '{"tab":7}');
  const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' };
  exchange(messages, { id: 'fish', name: 'browse', args: { action: 'screenshot', tab: 7 } }, 'captured', { image });
  const model: Model = { id: modelId, async *stream(req) {
    assert.ok(req.messages.some(m => m.role === 'tool' && m.results.some(r => r.callId === 'fish' && r.image?.data === image.data)));
    yield { type: 'text-delta', text: '{"confirmed":[{"item":"appearance inspected","receipt":"fish"}],"remaining":[]}' };
    yield { type: 'finish', stopReason: 'stop' };
  } };
  const result = await reviewToolWork(model, messages, undefined, 0, new AbortController().signal, 'test',
    () => [['game.html', digest]], () => {});
  assert.equal(result?.ready, true);
});

test('a text-only review can finish with a verified text check and an explicit visual limitation', async () => {
  const messages: AgentMessage[] = [{ role: 'user', content: 'Check the score and the appearance' }];
  const digest = 'a'.repeat(64);
  exchange(messages, create, 'saved' + 'x'.repeat(9000), { fileDigest: digest });
  exchange(messages, navigate, '{"tab":7}');
  exchange(messages, score, 'Score is 1');
  exchange(messages, { id: 'shot', name: 'browse', args: { action: 'screenshot', tab: 7 } }, 'Screenshot attached.',
    { image: { mediaType: 'image/png', data: 'unused' } });
  const model: Model = { id: modelId, toolImagesUnsupported: true, async *stream(req) {
    assert.match(JSON.stringify(req.messages), /host will report appearance as unverified/);
    assert.equal(req.messages.length, 1);
    yield { type: 'text-delta', text: '{"confirmed":[{"item":"Score is 1","receipt":"score"}],"remaining":[]}' };
    yield { type: 'finish', stopReason: 'stop' };
  } };
  const checked = await reviewToolWork(model, messages, undefined, 0, new AbortController().signal, 'test',
    () => [['game.html', digest]], () => {});
  assert.equal(checked?.ready, true);
  assert.match(reportChecks(collectWorkProgress(messages, 0), checked!.state.review!), /未確認.*見た目/);
});

test('CLI carries read intent across automatic compaction and delivers a subsequent line change', async t => {
  const { root } = workspace(t, 'exit 1');
  const file = 'notes.ts';
  const line = 'const detail = "' + 'X'.repeat(256) + '";';
  const source = Array.from({ length: 32 }, (_, i) => line + ' // ' + i).join('\n');
  fs.writeFileSync(path.join(root, file), source);
  let step = 0;
  const model: Model = { id: modelId, async *stream(req) {
    step++;
    if (step === 2) {
      assert.match(JSON.stringify(req.messages[0]), /notes.ts:1-32.*inspect rendering/);
      fs.writeFileSync(path.join(root, file), source.replace(line + ' // 1\n', 'changed\n'));
    }
    if (step <= 2) {
      yield { type: 'tool-call', call: { id: 'read-' + step, name: 'read_file', args: { path: file, purpose: 'inspect rendering' } } };
      yield { type: 'usage', input: step === 1 ? 8000 : 100, output: 20 };
      yield { type: 'finish', stopReason: 'tool-calls' };
    } else {
      const last = req.messages.at(-1);
      assert.ok(last?.role === 'tool');
      assert.match(last.results[0].output, /2: changed/);
      assert.ok(!last.results[0].output.includes(line));
      yield { type: 'text-delta', text: 'Reviewed the changed line.' };
      yield { type: 'finish', stopReason: 'stop' };
    }
  } };
  const output = await chat(root, model, 'Check how rendering works.');
  assert.match(output, /Reviewed the changed line/);
  assert.equal(step, 3);
});
