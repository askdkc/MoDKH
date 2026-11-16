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
  for (const request of model.requests) {
    // The policy stays the whole system value, so a provider caching the prefix still hits it.
    assert.equal(request.system, 'STABLE_POLICY');
    const last = request.messages.at(-1)!;
    assert.equal(last.role, 'user');
    assert.equal(last.role === 'user' && last.content, 'MEMORY_SENTINEL');
    // The turn-local data is appended, so every earlier message keeps its position and bytes.
    assert.deepEqual(request.messages.slice(0, -1), messages.slice(0, request.messages.length - 1));
  }
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
