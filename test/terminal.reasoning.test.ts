import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AiSdkModel } from '../src/model/ai-sdk.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { AgentMessage, ModelEvent } from '../src/agent/types.ts';

/** One SSE chunk carrying a provider reasoning delta, then a normal answer. */
async function reasoningStream(chunk: object): Promise<ModelEvent[]> {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model = new AiSdkModel({ id: 'fixture', languageModel: createOpenAICompatible({ name: 'fixture', baseURL })('fixture') });
  const events: ModelEvent[] = [];
  try {
    for await (const event of model.stream({ messages: [{ role: 'user', content: 'work' }], tools: [] }, new AbortController().signal)) {
      events.push(event);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return events;
}

test('provider reasoning is forwarded as its own event, separate from the answer text', async () => {
  const events = await reasoningStream({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta: { reasoning_content: 'REASONING_FIXTURE' }, finish_reason: null }] });
  const reasoning = events.filter(e => e.type === 'reasoning-delta');
  assert.ok(reasoning.length > 0, 'reasoning must reach the caller');
  assert.equal(reasoning.map(e => e.type === 'reasoning-delta' ? e.text : '').join(''), 'REASONING_FIXTURE');
  // The visible answer stays clean: reasoning must never be merged into assistant text.
  const text = events.filter(e => e.type === 'text-delta').map(e => e.type === 'text-delta' ? e.text : '').join('');
  assert.equal(text, 'answer');
  assert.doesNotMatch(text, /REASONING_FIXTURE/);
});

test('the loop reports reasoning to the display hook but keeps it out of the messages', async () => {
  const shown: string[] = [];
  const messages: AgentMessage[] = [{ role: 'user', content: 'hello' }];
  // model.stream yields reasoning then a plain answer
  const model = {
    id: 'fixture',
    async *stream(): AsyncIterable<ModelEvent> {
      yield { type: 'reasoning-delta', text: 'CHAIN_OF_THOUGHT' };
      yield { type: 'text-delta', text: 'final answer' };
      yield { type: 'finish', stopReason: 'stop' as const };
    },
  };
  const result = await runAgentLoop(messages, {
    model, registry: new ToolRegistry([]), root: '/tmp',
    signal: new AbortController().signal,
    approval: { approve: async () => false },
    hooks: { onReasoning: delta => shown.push(delta) },
  });
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(shown, ['CHAIN_OF_THOUGHT']);
  const assistant = messages.find(m => m.role === 'assistant');
  assert.ok(assistant && assistant.role === 'assistant');
  assert.equal(assistant.content, 'final answer');
  assert.doesNotMatch(assistant.content, /CHAIN_OF_THOUGHT/, 'reasoning is display-only');
});
