import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentMessage, Model, ModelEvent, ToolCall, ToolResult } from '../src/agent/types.ts';
import { SessionStore } from '../src/session/store.ts';
import { collectWorkProgress, currentChecks, groundReview, readyToReport } from '../src/agent/work-progress.ts';
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
