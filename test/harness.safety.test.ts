import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentLoop } from '../src/agent/loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { SessionStore } from '../src/session/store.ts';
import { createFileTool, editFileTool } from '../src/tools/edit.ts';
import type { AgentMessage, Model, ModelEvent, ToolCall } from '../src/agent/types.ts';

const call: ToolCall = { id: 'owned-1', name: 'effect', args: { value: 1 } };
const yes = { approve: async () => true };
function model(events: ModelEvent[], failure?: Error): Model {
  return { id: 'test', async *stream() { yield* events; if (failure) throw failure; } };
}
function options(m: Model, execute = async () => 'observed', signal = new AbortController().signal) {
  return { model: m, registry: new ToolRegistry([{ name: 'effect', description: '', parameters: {}, execute }]),
    root: process.cwd(), approval: yes, signal, maxTurns: 1 };
}

test('EOF without a terminal event preserves partial text but is not completion', async () => {
  const messages: AgentMessage[] = [{ role: 'user', content: 'original request' }];
  const result = await runAgentLoop(messages, options(model([{ type: 'text-delta', text: 'partial' }])));
  assert.equal(result.outcome, 'error');
  assert.deepEqual(messages[1], { role: 'assistant', content: 'partial' });
});

test('a thrown stream preserves partial evidence and closes unexecuted calls', async () => {
  const messages: AgentMessage[] = [];
  let executions = 0;
  const result = await runAgentLoop(messages, options(model([
    { type: 'text-delta', text: 'partial' }, { type: 'tool-call', call },
  ], new Error('transport lost')), async () => { executions++; return ''; }));
  assert.equal(result.outcome, 'error');
  assert.equal(executions, 0);
  assert.equal(messages[0]?.role, 'assistant');
  const last = messages.at(-1);
  assert.ok(last?.role === 'tool');
  assert.equal(last.results[0].status, 'not-executed');
});

test('Stop wins over a model that reports normal completion', async () => {
  const ac = new AbortController();
  ac.abort();
  let requests = 0;
  const m: Model = { id: 'ignores-stop', async *stream() { requests++; yield { type: 'finish', stopReason: 'stop' }; } };
  const result = await runAgentLoop([], options(m, undefined, ac.signal));
  assert.equal(result.outcome, 'interrupted');
  assert.equal(requests, 0);
});

for (const status of ['ok', 'unknown'] as const) {
  test(`replayed ${status} call returns evidence without repeating effects`, async () => {
    const messages: AgentMessage[] = [
      { role: 'assistant', content: '', toolCalls: [call] },
      { role: 'tool', results: [{ callId: call.id, name: call.name, status, output: 'saved evidence' }] },
    ];
    let executions = 0;
    await runAgentLoop(messages, options(model([{ type: 'tool-call', call }, { type: 'finish', stopReason: 'tool-calls' }]),
      async () => { executions++; return 'duplicated'; }));
    assert.equal(executions, 0);
    const last = messages.at(-1);
    assert.ok(last?.role === 'tool');
    assert.equal(last.results[0].output, 'saved evidence');
  });
}

for (const readOnly of [false, true]) {
  test(`an unknown operation under a new ID is retried only when readOnly=${readOnly}`, async () => {
    const messages: AgentMessage[] = [
      { role: 'assistant', content: '', toolCalls: [call] },
      { role: 'tool', results: [{ callId: call.id, name: call.name, status: 'unknown', output: 'lost receipt' }] },
    ];
    let executions = 0;
    const opts = options(model([{ type: 'tool-call', call: { ...call, id: 'new-id' } }, { type: 'finish', stopReason: 'tool-calls' }]));
    opts.registry = new ToolRegistry([{ name: 'effect', description: '', parameters: {}, readOnly,
      execute: async () => { executions++; return 'current evidence'; } }]);
    await runAgentLoop(messages, opts);
    assert.equal(executions, readOnly ? 1 : 0);
  });
}

test('same call identity with changed input is rejected', async () => {
  const messages: AgentMessage[] = [
    { role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', results: [{ callId: call.id, name: call.name, status: 'ok', output: 'saved' }] },
  ];
  let executions = 0;
  await runAgentLoop(messages, options(model([
    { type: 'tool-call', call: { ...call, args: { value: 2 } } }, { type: 'finish', stopReason: 'tool-calls' },
  ]), async () => { executions++; return ''; }));
  assert.equal(executions, 0);
  const last = messages.at(-1);
  assert.ok(last?.role === 'tool');
  assert.match(last.results[0].output, /CALL_ID_CONFLICT/);
});

test('request is persisted before an effect and its receipt before the next effect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-journal-'));
  try {
    const store = new SessionStore(dir);
    const session = store.create(process.cwd(), 'test');
    session.append({ role: 'user', content: 'keep this exact request' });
    let persisted = session.messages.length;
    let executions = 0;
    const opts = options(model([
      { type: 'tool-call', call }, { type: 'tool-call', call: { ...call, id: 'owned-2' } },
      { type: 'finish', stopReason: 'tool-calls' },
    ]), async () => {
      const disk = store.load(session.id);
      assert.ok(disk.messages.some(m => m.role === 'assistant' && m.toolCalls?.length === 2));
      if (executions++) assert.ok(disk.messages.some(m => m.role === 'tool' && m.results.some(r => r.status === 'ok')));
      return 'effect receipt';
    });
    await runAgentLoop(session.messages, { ...opts, checkpoint: () => {
      session.persistFrom(persisted); persisted = session.messages.length;
    } });
    assert.equal(executions, 2);
    assert.equal(store.load(session.id).messages.filter(m => m.role === 'tool').length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a persisted request without a receipt resumes as unknown, never silently forgotten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-orphan-'));
  try {
    const store = new SessionStore(dir);
    const session = store.create(process.cwd(), 'test');
    session.append({ role: 'assistant', content: 'started', toolCalls: [call] });
    const loaded = store.load(session.id);
    assert.equal(loaded.unknownToolResults().length, 1);
    assert.equal(loaded.unknownToolResults()[0].callId, call.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const tool of [createFileTool, editFileTool]) {
  test(`${tool.name} does not write when Stop arrives during approval`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-stop-edit-'));
    try {
      if (tool === editFileTool) fs.writeFileSync(path.join(root, 'a'), 'before');
      const ac = new AbortController();
      await assert.rejects(tool.execute({ path: 'a', content: 'new', old_string: 'before', new_string: 'after' }, {
        root, signal: ac.signal, approval: { approve: async () => { ac.abort(); return true; } },
      }));
      if (tool === editFileTool) assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'before');
      else assert.equal(fs.existsSync(path.join(root, 'a')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('editing rechecks the approved base rather than overwriting a concurrent change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-stale-edit-'));
  try {
    const file = path.join(root, 'a');
    fs.writeFileSync(file, 'before');
    await assert.rejects(editFileTool.execute({ path: 'a', old_string: 'before', new_string: 'after' }, {
      root, approval: { approve: async () => { fs.writeFileSync(file, 'concurrent work'); return true; } },
    }), /変更/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'concurrent work');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unexpected tool failure after an effect remains unknown and stops later effects', async () => {
  let executions = 0;
  const messages: AgentMessage[] = [];
  const result = await runAgentLoop(messages, options(model([
    { type: 'tool-call', call }, { type: 'tool-call', call: { ...call, id: 'later' } },
    { type: 'finish', stopReason: 'tool-calls' },
  ]), async () => { executions++; throw new Error('lost receipt after effect'); }));
  assert.equal(result.outcome, 'interrupted');
  assert.equal(executions, 1);
  const results = messages.flatMap(m => m.role === 'tool' ? m.results : []);
  assert.deepEqual(results.map(r => r.status), ['unknown', 'not-executed']);
});

test('declining creation does not create parent directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-denied-'));
  try {
    await assert.rejects(createFileTool.execute({ path: 'new/a', content: 'x' }, {
      root, approval: { approve: async () => false },
    }));
    assert.equal(fs.existsSync(path.join(root, 'new')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
