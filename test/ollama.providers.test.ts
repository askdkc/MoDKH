import test from 'node:test';
import assert from 'node:assert/strict';
import { CONNECT_PROVIDERS } from '../src/cli/providers.ts';
import { MODEL_SUGGESTIONS } from '../src/cli/models.ts';
import { resolveModel, MissingKeyError } from '../src/model/factory.ts';

// Ollama's direct-cloud contract: https://docs.ollama.com/api/openai-compatibility
// Local Ollama remains a different, unauthenticated endpoint.
test('Ollama Local and Ollama Cloud have distinct picker identities and model lists', () => {
  assert.equal(CONNECT_PROVIDERS.find(p => p.value === 'ollama')?.label, 'Ollama Local');
  assert.equal(CONNECT_PROVIDERS.find(p => p.value === 'ollama-cloud')?.label, 'Ollama Cloud');
  assert.ok(MODEL_SUGGESTIONS.includes('ollama/llama3.2'));
  assert.ok(MODEL_SUGGESTIONS.includes('ollama-cloud/gemma4:31b'));
  assert.ok(MODEL_SUGGESTIONS.includes('ollama-cloud/gpt-oss:120b'));
  assert.ok(MODEL_SUGGESTIONS.filter(ref => ref.startsWith('ollama-cloud/')).every(ref => !ref.endsWith(':cloud')));
});

test('cloud requires OLLAMA_API_KEY; local does not require or inherit it', () => {
  assert.throws(() => resolveModel({ provider: 'ollama-cloud', model: 'gemma4:31b' }, {}),
    error => error instanceof MissingKeyError && /OLLAMA_API_KEY/.test(error.message));
  assert.equal(resolveModel({ provider: 'ollama', model: 'llama3.2' }, {}).id, 'ollama/llama3.2');
});

test('cloud uses the official host and bearer key without inheriting the local endpoint', async () => {
  const original = globalThis.fetch;
  const seen: { url: string; auth: string | null; model: string }[] = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'),
      model: JSON.parse(String(init?.body)).model });
    return new Response('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const env = { OLLAMA_API_KEY: 'cloud-test-key', OLLAMA_BASE_URL: 'http://127.0.0.1:12345/v1' };
  try {
    for (const spec of [{ provider: 'ollama-cloud', model: 'gemma4:31b' }, { provider: 'ollama', model: 'llama3.2' }]) {
      const model = resolveModel(spec, env);
      const events = [];
      for await (const event of model.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [] }, new AbortController().signal)) events.push(event);
      assert.ok(events.some(e => e.type === 'finish' && e.stopReason === 'stop'));
    }
    assert.deepEqual(seen, [
      { url: 'https://ollama.com/v1/chat/completions', auth: 'Bearer cloud-test-key', model: 'gemma4:31b' },
      { url: 'http://127.0.0.1:12345/v1/chat/completions', auth: null, model: 'llama3.2' },
    ]);
  } finally { globalThis.fetch = original; }
});
