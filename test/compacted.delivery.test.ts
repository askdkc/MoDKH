import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactLocally, planCompaction } from '../src/agent/compaction.ts';
import { lastRequestIndex, savedResults, savedText } from '../src/agent/saved-results.ts';
import type { AgentMessage, Model, ModelEvent } from '../src/agent/types.ts';
import { finishCompactedTurn } from '../src/cli/compacted-turn.ts';
import { prepareReport, publishReport, readReport, reportExcerpt, reportFile, reviseReport } from '../src/session/report-file.ts';
import { SessionStore } from '../src/session/store.ts';

const allowed = { approve: async () => true };
const neverAbort = new AbortController().signal;

test('publication preserves an existing draft, handles approval races, and reconciles both sides of a crash', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'draft.md');
  const store = new SessionStore(path.join(root, 'sessions'));
  const session = store.create(root, 'test');
  session.append({ role: 'user', content: 'Finish draft.md' });
  session.append({ role: 'tool', results: [{ name: 'read_file', callId: 'e', status: 'ok', output: 'Maple' }] });
  session.recordCompaction(compactLocally(session.messages, undefined, 0)!, 0);
  fs.writeFileSync(file, 'Original text', { mode: 0o640 });
  session.recordReportDraft(prepareReport('draft.md', readReport(file), '## Findings\nMaple'));
  const model: Model = { id: 'unused', async *stream() { throw new Error('must not regenerate a recorded draft'); } };
  const deliver = (write = (_text: string) => {}) => finishCompactedTurn({
    session: store.load(session.id), model, approval: allowed, signal: neverAbort, reasoning: null, onEvent() {}, write,
  });
  assert.equal((await deliver()).outcome, 'complete');
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o640);
  assert.equal(readReport(file), 'Original text\n\n## Findings\nMaple\n');
  // The durable answer can also precede the status event when a process exits.
  assert.equal((await deliver()).outcome, 'complete');
  assert.equal(fs.statSync(file).ino, stat.ino);
  assert.equal(store.load(session.id).messages.filter(m => m.role === 'assistant').length, 1);
  const pending = prepareReport('draft.md', readReport(file), 'New paragraph');
  assert.equal(await publishReport(root, pending, { approve: async () => false }, neverAbort), false);
  const controller = new AbortController();
  assert.equal(await publishReport(root, pending, { approve: async () => { controller.abort(); return true; } }, controller.signal), false);
  await assert.rejects(publishReport(root, pending, { approve: async () => { fs.writeFileSync(file, 'Human edit'); return true; } }, neverAbort), /変更/);
  assert.equal(readReport(file), 'Human edit');
  assert.equal((await deliver()).outcome, 'error');
  assert.equal(readReport(file), 'Human edit');
});

test('automatic report publication confines files, including absent and empty files', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-report-root-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'project');
  fs.mkdirSync(root);
  fs.symlinkSync(tmp, path.join(root, 'outside'));
  fs.symlinkSync(path.join(tmp, 'missing'), path.join(root, 'dangling.md'));
  for (const name of ['../file.md', 'outside/file.md', 'dangling.md', '.git/file.md', 'file.js']) assert.throws(() => reportFile(root, name));
  fs.writeFileSync(path.join(root, 'empty.md'), '');
  for (const [name, before] of [['empty.md', ''], ['reports/new.md', null]] as const) {
    const draft = prepareReport(name, before, 'Maple');
    assert.equal(await publishReport(root, draft, allowed, neverAbort), true);
    assert.equal(await publishReport(root, draft, { approve: async () => { throw new Error('already on disk'); } }, neverAbort), true);
    assert.equal(readReport(path.join(root, name)), 'Maple\n');
  }
});

test('edits to a numbered draft preserve other paragraphs and line endings and refuse omitted ranges and process prose', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-revise-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'report.md');
  const original = 'Title  \r\nA finding\r\nAnother finding\r\nTODO: save this file';
  fs.writeFileSync(file, original);
  const { visible } = reportExcerpt(original, 500);
  const plan = JSON.stringify({ edits: [{ first: 2, last: 2, text: 'Verified finding' }, { first: 4, last: 4, text: '' }] });
  const draft = reviseReport('report.md', original, plan, visible);
  assert.throws(() => reviseReport('report.md', original, plan, new Set([1, 4])));
  assert.throws(() => reviseReport('report.md', original, 'Next I will edit the report.', visible));
  assert.throws(() => reviseReport('report.md', original, '{"edits":[{"first":1,"last":4,"text":""}]}', visible));
  assert.throws(() => reviseReport('report.md', original, '{"edits":[{"first":1,"last":2,"text":"a"},{"first":2,"last":3,"text":"b"}]}', visible));
  await publishReport(root, draft, allowed, neverAbort);
  assert.equal(readReport(file), 'Title  \r\nVerified finding\r\nAnother finding\r\n');
});

test('a publisher killed while holding the file lease does not leave a report permanently blocked', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-abandoned-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'report.md');
  fs.mkdirSync(file + '.lock');
  await publishReport(root, prepareReport('report.md', null, 'Recovered draft'), allowed, neverAbort);
  assert.equal(readReport(file), 'Recovered draft\n');
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('a second resume cannot replace a delivery completed by the first terminal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-concurrent-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(path.join(root, 'sessions'));
  const first = store.create(root, 'test');
  first.append({ role: 'user', content: 'Save report.md' });
  first.recordCompaction(compactLocally(first.messages, undefined, 0)!, 0);
  const second = store.load(first.id);
  const release = await first.claimReportWriter();
  const competing = assert.rejects(second.claimReportWriter(), /別のMoDKH/);
  first.append({ role: 'assistant', content: 'Delivered' });
  first.setStatus('complete');
  await release();
  await competing;
  assert.equal(store.load(first.id).status, 'complete');
});

test('saved observations retain receipt status, signalled failures and the user task without shell arguments or environment secrets', () => {
  const history: AgentMessage[] = [{ role: 'user', content: 'Finish the editorial report.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'run_command', args: { command: 'PRIVATE_ARGUMENT' } }] },
    { role: 'tool', results: [{ callId: 'a', name: 'run_command', status: 'ok',
      output: '[exit code: 0]\n' + 'x'.repeat(1500) + '\n[CRITICAL] source unavailable\nAPI_KEY=PRIVATE_KEY\nAuthorization: Bearer PRIVATE_KEY\n' + 'y'.repeat(1500) }] },
    { role: 'user', content: '(バックグラウンドジョブの完了通知)\nDone.' }];
  const saved = savedResults(history, 0);
  assert.match(saved.requests, /editorial report/);
  assert.doesNotMatch(saved.requests, /ジョブ/);
  assert.match(saved.observations, /\[ok\].*exit code: 0/s);
  assert.match(saved.observations, /CRITICAL.*source unavailable/);
  assert.doesNotMatch(saved.observations, /PRIVATE_/);
});

test('host notices do not start a new task and later follow-ups retain the initial request', () => {
  const history: AgentMessage[] = [{ role: 'user', content: 'Prepare the report in minutes.md' }];
  const notice = { role: 'user', origin: 'host', content: 'Internal follow-up' } as const;
  history.push(notice);
  assert.equal(planCompaction(history, 1), null);
  for (let i = 0; i < 8; i++) history.push({ role: 'user', content: 'Continue with the saved evidence.' }, notice);
  history.push({ role: 'user', content: '(バックグラウンドジョブの完了通知)\nDone.' });
  const start = lastRequestIndex(history);
  assert.equal(start, history.length - 3);
  const saved = savedResults(history, start);
  assert.match(saved.requests, /minutes\.md/);
  assert.doesNotMatch(saved.requests, /Internal follow-up|ジョブ/);
});

test('an inline answer recovers once from a second input overflow without executing tools or writing a file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-inline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new SessionStore(path.join(root, 'sessions')).create(root, 'test');
  session.append({ role: 'user', content: 'Summarize the saved minutes here.' });
  session.recordCompaction(compactLocally(session.messages, undefined, 0)!, 0);
  let calls = 0;
  const model: Model = { id: 'test', async *stream(req): AsyncGenerator<ModelEvent> {
    assert.deepEqual(req.tools, []);
    if (++calls === 2) { yield { type: 'finish', stopReason: 'error', errorMessage: 'context_length_exceeded' }; return; }
    yield { type: 'text-delta', text: calls === 1 ? '-' : 'The minutes record a postponement.' };
    yield { type: 'finish', stopReason: 'stop' };
  } };
  const result = await finishCompactedTurn({ session, model, approval: allowed, signal: neverAbort, reasoning: null, onEvent() {},
    write(text) { assert.equal(text, 'The minutes record a postponement.'); } });
  assert.equal(result.outcome, 'complete');
  assert.equal(calls, 3);
  assert.deepEqual(fs.readdirSync(root), ['sessions']);
});

test('a header timeout retries only once and only before the model has produced output', async () => {
  for (const mode of ['recovered', 'persistent', 'partial']) {
    let calls = 0;
    const model: Model = { id: 'test', async *stream(req): AsyncGenerator<ModelEvent> {
      assert.deepEqual(req.tools, []);
      calls++;
      if (mode === 'partial') yield { type: 'text-delta', text: 'Partial' };
      if (calls === 1 || mode === 'persistent') throw new Error('Cannot connect to API: Headers Timeout Error');
      yield { type: 'text-delta', text: 'Complete' };
      yield { type: 'finish', stopReason: 'stop' };
    } };
    const answer = savedText(model, () => ({ messages: [{ role: 'user', content: 'Summarize' }], tools: [] }), neverAbort, () => {});
    if (mode === 'recovered') assert.equal(await answer, 'Complete');
    else await assert.rejects(answer, /Headers Timeout Error/);
    assert.equal(calls, mode === 'partial' ? 1 : 2);
  }
});

for (const failure of ['tool call', 'length', 'missing finish', 'empty', 'transport', 'outside path', 'abort'] as const) {
  test('incomplete or invalid delivery does not publish: ' + failure, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-undelivered-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const session = new SessionStore(path.join(root, 'sessions')).create(root, 'test');
    session.append({ role: 'user', content: 'Save report.md' });
    session.recordCompaction(compactLocally(session.messages, undefined, 0)!, 0);
    const controller = new AbortController();
    const model: Model = { id: 'unit', async *stream(req): AsyncGenerator<ModelEvent> {
      assert.deepEqual(req.tools, []);
      if (req.system?.includes('delivery destination')) {
        yield { type: 'text-delta', text: failure === 'outside path' ? '../report.md' : 'report.md' };
        yield { type: 'finish', stopReason: 'stop' };
        return;
      }
      if (failure !== 'empty') yield { type: 'text-delta', text: 'Partial' };
      if (failure === 'tool call') yield { type: 'tool-call', call: { id: 'x', name: 'run_command', args: {} } };
      if (failure === 'abort') controller.abort();
      if (failure === 'transport') throw new Error('network disconnected');
      if (failure !== 'missing finish') yield { type: 'finish', stopReason: failure === 'length' ? 'length' : 'stop' };
    } };
    const got = await finishCompactedTurn({ session, model, approval: allowed, signal: controller.signal, reasoning: null,
      onEvent() {}, write() { assert.fail('no success message'); } });
    assert.equal(got.outcome, failure === 'abort' ? 'interrupted' : 'error');
    assert.equal(fs.existsSync(path.join(root, 'report.md')), false);
    assert.equal(session.reportDraft, undefined);
  });
}
