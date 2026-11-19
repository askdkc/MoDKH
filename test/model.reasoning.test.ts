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
  assert.deepEqual(reasoningProviderOptions('deepseek', 'medium', 'deepseek-v4-pro'), { deepseek: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } });
  assert.deepEqual(reasoningProviderOptions('openai', 'max', 'gpt-6.2-astra'), { openai: { reasoningEffort: 'max' } });
  assert.deepEqual(reasoningProviderOptions('openai', 'minimal', 'gpt-6.2-sol'), { openai: { reasoningEffort: 'low' } });
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
    for (const provider of ['openai', 'ollama-cloud'] as const) {
      const model = resolveModel({ provider, model: 'gpt-5', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' });
      for (const promptCacheKey of ['session-a', undefined]) {
        const count = bodies.length;
        for await (const _ of model.stream({ ...REQ(), promptCacheKey }, new AbortController().signal)) { /* capture request */ }
        assert.equal(bodies.length, count + 1);
        const body = bodies[count] as Record<string, unknown>;
        assert.equal(body.prompt_cache_key, provider === 'openai' ? promptCacheKey : undefined);
        assert.equal(body.promptCacheKey, undefined);
      }
    }
    for (const [id, level, expected, thinking] of [
      ['generic', 'low', 'low', undefined], ['generic', 'off', undefined, undefined],
      ['generic', 'max', 'high', undefined],
      ['deepseek-v4-pro:0813', 'max', 'max', 'enabled'], ['deepseek-v4-pro:0813', 'off', undefined, 'disabled'],
      ['glm-5.3', 'max', undefined, 'enabled'], ['glm-5.3', 'off', undefined, 'disabled'],
    ] as const) {
      const model = resolveModel({ provider: 'ollama-cloud', model: id, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k' });
      const result: ModelEvent[] = [];
      for await (const ev of model.stream(REQ(level), new AbortController().signal)) result.push(ev);
      assert.equal((result.at(-1) as { stopReason: string }).stopReason, 'stop');
      const body = bodies.at(-1)! as { reasoning_effort?: string; thinking?: { type: string } };
      assert.equal(body.reasoning_effort, expected, `${id} effort for ${level}`);
      assert.equal(body.thinking?.type, thinking, `${id} thinking for ${level}`);
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
    const promptCacheKey = level === 'high' ? 'session-a' : undefined;
    for await (const ev of model.stream({ ...REQ(level), promptCacheKey }, new AbortController().signal)) out.push(ev);
    assert.equal(received?.prompt_cache_key, promptCacheKey);
    assert.equal((out.at(-1) as { stopReason: string }).stopReason, 'stop');
    const expected = level === 'off' ? undefined : level;
    const body = received as { reasoning?: { effort?: string } } | undefined;
    assert.equal(body?.reasoning?.effort, expected, `effort for ${level}`);
  }
});
