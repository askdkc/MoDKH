import test from 'node:test';
import assert from 'node:assert/strict';
import { FixedModel } from '../src/model/fixed.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import type { AgentMessage } from '../src/agent/types.ts';

const gate = { approve: async () => false };

test('transient context keeps the byte-identical cached prefix and never enters the journal', async () => {
  const model = new FixedModel([
    [
      { type: 'tool-call', call: { id: 'c1', name: 'list_files', args: {} } },
      { type: 'finish', stopReason: 'tool-calls' },
    ],
    [{ type: 'text-delta', text: 'done' }, { type: 'finish', stopReason: 'stop' }],
  ]);
  const messages: AgentMessage[] = [{ role: 'user', content: 'go' }];
  const outcome = await runAgentLoop(messages, {
    model, registry: new ToolRegistry([]), root: process.cwd(),
    system: 'STABLE_POLICY', transientContext: 'MEMORY_SENTINEL',
    signal: new AbortController().signal, approval: gate, skills: false,
  });
  assert.equal(outcome.outcome, 'complete');
  const [first, second] = model.requests;
  assert.equal(first!.system, 'STABLE_POLICY');
  assert.equal(second!.system, 'STABLE_POLICY');
  assert.deepEqual(second!.messages.slice(0, first!.messages.length), first!.messages);
  assert.deepEqual(first!.messages, [{ role: 'user', content: 'go\n\nMEMORY_SENTINEL' }]);
  assert.equal(second!.messages.at(-1)?.role, 'tool');
  assert.equal(JSON.stringify(messages).includes('MEMORY_SENTINEL'), false, 'the journal never stores it');
  assert.deepEqual(messages.at(-1), { role: 'assistant', content: 'done' });
});

test('a blank transient context adds no message', async () => {
  const model = new FixedModel([[{ type: 'finish', stopReason: 'stop' }]]);
  const messages: AgentMessage[] = [{ role: 'user', content: 'go' }];
  await runAgentLoop(messages, {
    model, registry: new ToolRegistry([]), root: process.cwd(),
    system: 'STABLE_POLICY', transientContext: '   \n',
    signal: new AbortController().signal, approval: gate, skills: false,
  });
  assert.deepEqual(model.requests[0].messages, [{ role: 'user', content: 'go' }]);
});

test('workspace hints stay on the initiating request as tool evidence arrives', async () => {
  const model = new FixedModel([
    [{ type: 'tool-call', call: { id: 'ci', name: 'inspect', args: {} } }, { type: 'finish', stopReason: 'tool-calls' }],
    [{ type: 'finish', stopReason: 'stop' }],
  ]);
  const messages: AgentMessage[] = [{ role: 'user', content: 'ci fails. why?' }];
  await runAgentLoop(messages, {
    model, registry: new ToolRegistry([]), root: process.cwd(), taskContext: 'CI_HINT',
    signal: new AbortController().signal, approval: gate, skills: false,
  });
  assert.deepEqual(model.requests[0].messages[0], { role: 'user', content: 'ci fails. why?\n\nCI_HINT' });
  assert.deepEqual(model.requests[1].messages[0], model.requests[0].messages[0]);
  assert.equal(model.requests[1].messages.at(-1)?.role, 'tool');
  assert.doesNotMatch(JSON.stringify(messages), /CI_HINT/);
});

test('reasoning without an answer requests a visible result once and never persists reasoning', async () => {
  const hidden = [{ type: 'reasoning-delta', text: 'PRIVATE' }, { type: 'finish', stopReason: 'stop' }] as const;
  for (const answered of [true, false]) {
    const model = new FixedModel([[...hidden], answered
      ? [{ type: 'text-delta', text: 'failed assertion' }, { type: 'finish', stopReason: 'stop' }]
      : [...hidden]]);
    const messages: AgentMessage[] = [{ role: 'user', content: 'ci fails. why?' }];
    const result = await runAgentLoop(messages, { model, registry: new ToolRegistry([]), root: process.cwd(),
      signal: new AbortController().signal, approval: gate, skills: false });
    assert.equal(model.requests.length, 2);
    assert.equal(result.outcome, answered ? 'complete' : 'error');
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE/);
  }
});
