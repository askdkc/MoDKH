import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesApiModel } from '../src/model/chatgpt/responses.ts';

test('ChatGPT plan tokens use the public Responses endpoint', async () => {
  let endpoint = '';
  const model = new ResponsesApiModel({ accessToken: 'test', model: 'gpt-test', fetchImpl: async (url) => {
    endpoint = String(url);
    return new Response('data: {"type":"response.completed"}\n\n');
  } });
  for await (const event of model.stream({ messages: [], tools: [], system: 'test' }, new AbortController().signal)) {
    if (event.type === 'finish') assert.equal(event.stopReason, 'stop');
  }
  assert.equal(endpoint, 'https://api.openai.com/v1/responses');
});
