import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseProviderModel } from '../src/cli/providers.ts';
import { selectModel } from '../src/cli/models.ts';
import { chatGptFixture } from './fixtures/chatgpt-sign-in.ts';
import type { ChatTerminal, Choice } from '../src/cli/terminal.ts';

async function isolated(fn: () => Promise<void>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-models-'));
  const previous = process.env.MODKH_HOME, key = process.env.OPENAI_API_KEY, originalFetch = globalThis.fetch;
  process.env.MODKH_HOME = home;
  delete process.env.OPENAI_API_KEY;
  try { await fn(); } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = previous;
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
function terminal(select: (choices: readonly Choice[]) => string | null) {
  let output = '';
  const ui = { interactive: true, write: (text: string) => { output += text; },
    choose: async (_title: string, choices: readonly Choice[]) => select(choices),
  } as unknown as ChatTerminal;
  return { ui, output: () => output };
}

test('OpenAI picker obtains exact model IDs from the official API with the API key', () => isolated(async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://api.openai.com/v1/models');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-key');
    assert.equal(options?.redirect, 'error');
    return Response.json({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }] });
  };
  const { ui } = terminal(choices => {
    assert.ok(choices.some(c => c.value === 'openai/gpt-6.1-sol'));
    assert.ok(choices.some(c => c.value === 'openai/gpt-6-astra'));
    assert.ok(!choices.some(c => c.value === 'openai/gpt-5.2'));
    return 'openai/gpt-6.1-sol';
  });
  assert.equal(await chooseProviderModel(ui, 'openai'), 'openai/gpt-6.1-sol');
  assert.equal(calls, 1);
}));

test('/models chatgpt uses the authenticated ChatGPT plan catalogue and hides non-list entries', t => isolated(async () => {
  let calls = 0;
  const fixture = await chatGptFixture(new URL('../src/model/chatgpt/login.ts', import.meta.url).href, async (raw, options) => {
    calls++;
    const url = new URL(String(raw));
    assert.equal(url.origin + url.pathname, 'https://api.openai.com/v1/models');
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer oauth-fixture');
    return Response.json({ models: [{ slug: 'gpt-6-astra', visibility: 'list' },
      { slug: 'gpt-6.1-sol', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hide' }] });
  });
  t.after(fixture.restore);
  await fixture.signIn();
  const { ui } = terminal(choices => {
    assert.ok(choices.some(c => c.value === 'chatgpt/gpt-6-astra'));
    assert.ok(choices.some(c => c.value === 'chatgpt/gpt-6.1-sol'));
    assert.ok(!choices.some(c => c.value === 'chatgpt/hidden-model'));
    return 'chatgpt/gpt-6-astra';
  });
  assert.equal(await selectModel(ui, 'chatgpt', null), 'chatgpt/gpt-6-astra');
  assert.equal(calls, 1);
}));

test('catalogue failure is visible, preserves manual input, and never falls back to stale IDs', () => isolated(async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  globalThis.fetch = async () => new Response('secret-body', { status: 401 });
  const { ui, output } = terminal(choices => {
    assert.ok(choices.some(c => c.value === 'custom'));
    assert.ok(!choices.some(c => c.value.startsWith('openai/')));
    return null;
  });
  assert.equal(await chooseProviderModel(ui, 'openai'), null);
  assert.match(output(), /401/);
  assert.doesNotMatch(output(), /secret-body|test-key/);
}));

test('reopening fetches new IDs, including models unknown when the application was built', () => isolated(async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  let generation = 0;
  globalThis.fetch = async () => Response.json({ data: [{ id: `future-model-${++generation}` }] });
  const { ui } = terminal(choices => {
    const models = choices.filter(c => c.value.startsWith('openai/'));
    assert.deepEqual(models.map(c => c.value), [`openai/future-model-${generation}`]);
    return models[0].value;
  });
  assert.equal(await chooseProviderModel(ui, 'openai'), 'openai/future-model-1');
  assert.equal(await chooseProviderModel(ui, 'openai'), 'openai/future-model-2');
}));

test('empty and malformed catalogues are distinct and do not invent models', () => isolated(async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  const { ui, output } = terminal(choices => {
    assert.ok(!choices.some(c => c.value.startsWith('openai/')));
    return null;
  });
  globalThis.fetch = async () => Response.json({ data: [] });
  await chooseProviderModel(ui, 'openai');
  assert.match(output(), /公式モデル一覧 0件/);
  globalThis.fetch = async () => Response.json({ data: [{ id: 'bad\u001b[31m' }] });
  await chooseProviderModel(ui, 'openai');
  assert.match(output(), /モデルIDが不正/);
}));

test('cancelling catalogue retrieval aborts fetch and returns without opening the picker', () => isolated(async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  const before = process.listenerCount('SIGINT');
  globalThis.fetch = async (_url, options) => {
    process.emit('SIGINT');
    options!.signal!.throwIfAborted();
    throw new Error('expected an aborted signal');
  };
  const { ui, output } = terminal(() => { assert.fail('cancel must not open a picker'); });
  assert.equal(await chooseProviderModel(ui, 'openai'), null);
  assert.match(output(), /中止/);
  assert.equal(process.listenerCount('SIGINT'), before);
}));
