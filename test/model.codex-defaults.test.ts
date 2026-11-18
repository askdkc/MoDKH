import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponsesApiModel } from '../src/model/chatgpt/responses.ts';

for (const model of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-sol']) {
  test(`Codex request defaults and explicit overrides: ${model}`, async () => {
    let body: { reasoning?: { effort: string }; text?: { verbosity: string } } = {};
    const adapter = new ResponsesApiModel({ model, accessToken: 'test', fetchImpl: async (_, init) => {
      body = JSON.parse(String(init?.body));
      return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
    for (const reasoning of [undefined, 'high', 'off'] as const) {
      for await (const _ of adapter.stream({ messages: [], tools: [], reasoning }, new AbortController().signal)) { /* drain */ }
      const profile = model.startsWith('gpt-6.2-');
      assert.equal(body.reasoning?.effort, reasoning === 'off' ? undefined : reasoning ?? (profile ? 'low' : undefined));
      assert.equal(body.text?.verbosity, profile ? 'low' : undefined);
    }
  });
}
