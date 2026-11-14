import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../src/agent/loop.ts';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import type { AgentMessage, Model, ToolCall } from '../src/agent/types.ts';

const prior: ToolCall = { id: 'old-command', name: 'run_command', args: { command: 'printf OBSERVED' } };
function request(call: ToolCall): Model {
  return { id: 'identity-test', async *stream() {
    yield { type: 'tool-call', call };
    yield { type: 'finish', stopReason: 'tool-calls' };
  } };
}
async function resume(next: ToolCall, registry = new ToolRegistry(defaultTools())) {
  const messages: AgentMessage[] = [
    { role: 'assistant', content: '', toolCalls: [prior] },
    { role: 'tool', results: [{ callId: prior.id, name: prior.name, status: 'unknown', output: 'lost receipt' }] },
  ];
  let approvals = 0;
  const outcome = await runAgentLoop(messages, {
    model: request(next), registry, root: process.cwd(), maxTurns: 1,
    signal: new AbortController().signal,
    approval: { approve: async () => { approvals++; return true; } },
  });
  const last = messages[messages.length - 1];
  assert.ok(last.role === 'tool');
  return { outcome, result: last.results[0], approvals };
}

for (const cwd of ['.', './', 'unused/..', process.cwd()]) {
  test(`unknown command cannot be replayed by spelling the same cwd as ${cwd}`, async () => {
    const { outcome, result, approvals } = await resume({ ...prior, id: 'new-command', args: { ...prior.args, cwd } });
    assert.equal(outcome.outcome, 'interrupted');
    assert.equal(result.status, 'unknown');
    assert.equal(approvals, 0);
    assert.doesNotMatch(result.output, /exit code/);
  });
}

test('same call ID still requires byte-for-byte input structure, not effective identity', async () => {
  const { result, approvals } = await resume({ ...prior, args: { ...prior.args, cwd: '.' } });
  assert.equal(result.status, 'error');
  assert.match(result.output, /CALL_ID_CONFLICT/);
  assert.equal(approvals, 0);
});

test('command text is never normalized to merge similar commands', async () => {
  const { result, approvals } = await resume({ ...prior, id: 'new-command', args: { command: 'printf OBSERVED ' } });
  assert.equal(result.status, 'ok');
  assert.equal(approvals, 1);
});

for (const key of ['unused', '__proto__']) {
  test(`declared tool arguments reject an unknown own field ${key} before approval`, async () => {
    let approvals = 0;
    const result = await new ToolRegistry(defaultTools()).executeOne({
      ...prior, args: { ...prior.args, [key]: true },
    }, { root: process.cwd(), approval: { approve: async () => { approvals++; return true; } } });
    assert.equal(result.status, 'error');
    assert.match(result.output, /INVALID_ARGS/);
    assert.equal(approvals, 0);
  });
}

test('a failed trusted identity calculation cannot authorize an uncertain replay', async () => {
  let executions = 0;
  const registry = new ToolRegistry([{
    name: 'run_command', description: '', parameters: {},
    operationIdentity() { throw new Error('identity unavailable'); },
    async execute() { executions++; return 'unexpected effect'; },
  }]);
  const { result } = await resume({ ...prior, id: 'new-command', args: { ...prior.args, cwd: '.' } }, registry);
  assert.equal(result.status, 'unknown');
  assert.equal(executions, 0);
});
