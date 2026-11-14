import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { reasoningProviderOptions } from '../src/model/reasoning.ts';
import { resolveModel } from '../src/model/factory.ts';
import { ResponsesApiModel } from '../src/model/chatgpt/responses.ts';
import type { ModelEvent, ModelRequest, ReasoningLevel } from '../src/agent/types.ts';

const REQ = (reasoning?: ReasoningLevel): ModelRequest =>
  ({ messages: [{ role: 'user', content: 'hello' }], tools: [], ...(reasoning === undefined ? {} : { reasoning }) });

test('reasoning options are provider specific and off sends nothing', () => {
  assert.deepEqual(reasoningProviderOptions('openai', 'off'), undefined);
  assert.deepEqual(reasoningProviderOptions('deepseek', 'high'), undefined);
  assert.deepEqual(reasoningProviderOptions('openai', 'low'), { openai: { reasoningEffort: 'low' } });
  assert.deepEqual(reasoningProviderOptions('openai', 'xhigh' as 'medium'), undefined, 'unlisted level is refused');
  const anthropic = reasoningProviderOptions('anthropic', 'medium');
  assert.equal((anthropic?.anthropic as { thinking: { type: string } }).thinking.type, 'enabled');
  assert.ok((anthropic!.anthropic as { thinking: { budgetTokens: number } }).thinking.budgetTokens >= 1024,
    'anthropic budgets start at 1024');
  const google = reasoningProviderOptions('google', 'off');
  assert.equal((google?.google as { thinkingConfig: { thinkingBudget: number } }).thinkingConfig.thinkingBudget, 0);
  // OpenAI互換系はプロバイダー名自身をキーにして server 側 reasoning_effort へ渡る。
  assert.deepEqual(reasoningProviderOptions('ollama-cloud', 'high'), { 'ollama-cloud': { reasoningEffort: 'high' } });
  assert.deepEqual(reasoningProviderOptions('fixed', 'low'), undefined);
});

test('compatible providers carry reasoning_effort on the wire', async () => {
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    for (const [level, expected] of [['low', 'low'], ['off', undefined]] as const) {
      const model = resolveModel({ provider: 'ollama-cloud', model: 'glm-test', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' });
      const result: ModelEvent[] = [];
      for await (const ev of model.stream(REQ(level), new AbortController().signal)) result.push(ev);
      assert.equal((result.at(-1) as { stopReason: string }).stopReason, 'stop');
      assert.equal((bodies.at(-1)! as { reasoning_effort?: string }).reasoning_effort, expected, `level=${level}`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ChatGPT Responses forwards reasoning effort', async () => {
  let received: Record<string, unknown> | undefined;
  const model = new ResponsesApiModel({
    accessToken: 'test',
    model: 'gpt-5.3',
    fetchImpl: async (_url, init) => {
      received = JSON.parse(String(init?.body));
      return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`
        + `data: ${JSON.stringify({ type: 'response.completed' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  for (const level of ['high', 'off'] as const) {
    const out: ModelEvent[] = [];
    for await (const ev of model.stream(REQ(level), new AbortController().signal)) out.push(ev);
    assert.equal((out.at(-1) as { stopReason: string }).stopReason, 'stop');
    const expected = level === 'off' ? undefined : level;
    const body = received as { reasoning?: { effort?: string } } | undefined;
    assert.equal(body?.reasoning?.effort, expected, `effort for ${level}`);
  }
});
