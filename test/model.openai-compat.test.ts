import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { resolveModel, parseModelRef, MissingKeyError, knownProviders } from '../src/model/factory.ts';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import type { AgentMessage } from '../src/agent/types.ts';

interface Chunk {
  delta: Record<string, unknown>;
  finishReason: string | null;
}

function sse(res: http.ServerResponse, chunks: Chunk[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let i = 0;
  for (const c of chunks) {
    const body = {
      id: `chatcmpl-${i}`,
      object: 'chat.completion.chunk',
      created: 1700000000 + i,
      model: 'fake-1',
      choices: [{ index: 0, delta: c.delta, finish_reason: c.finishReason }],
    };
    res.write(`data: ${JSON.stringify(body)}\n\n`);
    i++;
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

interface RecordedRequest {
  body: Record<string, unknown>;
  url?: string;
  authorization?: string;
}

/** OpenAI互換の最小偽サーバ。1回目はツール要求、2回目は最終テキストを返す。 */
async function startFakeServer(): Promise<{ url: string; close(): Promise<void>; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => {
      raw += d.toString('utf8');
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ body, url: req.url, authorization: req.headers.authorization });
      const messages = (body['messages'] ?? []) as { role: string }[];
      const hasToolResult = messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        sse(res, [
          { delta: { role: 'assistant', content: 'ファ' }, finishReason: null },
          { delta: { content: 'イルを読みます' }, finishReason: null },
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
                },
              ],
            },
            finishReason: null,
          },
          { delta: {}, finishReason: 'tool_calls' },
        ]);
      } else {
        sse(res, [
          { delta: { role: 'assistant', content: 'hello world を確認した' }, finishReason: null },
          { delta: {}, finishReason: 'stop' },
        ]);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test('OpenAI互換アダプターが偽SSEサーバでストリーミング+ツール往復を完走する', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-compat-'));
  const fake = await startFakeServer();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n');
    const model = resolveModel({
      provider: 'compatible',
      model: 'fake-1',
      baseUrl: fake.url,
    });
    const deltas: string[] = [];
    const executed: string[] = [];
    const messages: AgentMessage[] = [{ role: 'user', content: 'a.txt を読んで' }];
    const r = await runAgentLoop(messages, {
      model,
      registry: new ToolRegistry(defaultTools()),
      root,
      signal: new AbortController().signal,
      approval: { approve: async () => true },
      hooks: {
        onText: (d) => deltas.push(d),
        onToolResult: (tr) => executed.push(`${tr.name}:${tr.status}`),
      },
    });
    assert.equal(r.outcome, 'complete');
    assert.deepEqual(deltas, ['ファ', 'イルを読みます', 'hello world を確認した']);
    assert.deepEqual(executed, ['read_file:ok']);
    // モデル要求の2往復が実際にサーバへ届いている
    assert.equal(fake.requests.length, 2);
    const firstTools = (fake.requests[0].body['tools'] ?? []) as { function: { name: string } }[];
    assert.ok(firstTools.some((t) => t.function?.name === 'read_file'));
    const secondMessages = (fake.requests[1].body['messages'] ?? []) as { role: string }[];
    assert.ok(secondMessages.some((m) => m.role === 'tool'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    await fake.close();
  }
});

for (const [provider, keyName, baseName] of [
  ['opencode', 'OPENCODE_API_KEY', 'OPENCODE_BASE_URL'],
  ['infron', 'INFRON_API_KEY', 'INFRON_BASE_URL'],
  ['hermes', 'HERMES_API_KEY', 'HERMES_BASE_URL'],
  ['ollama', '', 'OLLAMA_BASE_URL'],
  ['ollama-cloud', 'OLLAMA_API_KEY', 'OLLAMA_CLOUD_BASE_URL'],
]) {
  test(`${provider} reaches its configured OpenAI-compatible endpoint with the exact model/key`, async () => {
    const fake = await startFakeServer();
    try {
      const env = { [baseName]: fake.url, ...(keyName ? { [keyName]: 'test-key' } : {}) };
      const model = resolveModel({ provider, model: 'org/model' }, env);
      const events = [];
      for await (const event of model.stream({ messages: [{ role: 'user', content: 'test' }], tools: [] }, new AbortController().signal)) events.push(event);
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].url, '/v1/chat/completions');
      assert.equal(fake.requests[0].body.model, 'org/model');
      assert.equal(fake.requests[0].authorization, keyName ? 'Bearer test-key' : undefined);
      assert.ok(events.some(event => event.type === 'text-delta'));
    } finally { await fake.close(); }
  });
}

test('APIキー未設定は明示エラーとなり、別の接続先へ切り替えない', () => {
  const env: NodeJS.ProcessEnv = {};
  assert.throws(
    () => resolveModel({ provider: 'openai', model: 'gpt-4o' }, env),
    (e: unknown) => e instanceof MissingKeyError && /OPENAI_API_KEY/.test((e as Error).message) && /切り替えない/.test((e as Error).message),
  );
  assert.throws(
    () => resolveModel({ provider: 'anthropic', model: 'claude-x' }, env),
    /ANTHROPIC_API_KEY/,
  );
  // キーがあれば構築できる(通信は発生しない)
  const m = resolveModel({ provider: 'openai', model: 'gpt-4o' }, { OPENAI_API_KEY: 'k' });
  assert.equal(m.id, 'openai/gpt-4o');
});

test('model 参照の解釈と対応プロバイダー', () => {
  assert.deepEqual(parseModelRef('openai/gpt-4o'), { provider: 'openai', model: 'gpt-4o' });
  assert.deepEqual(parseModelRef('openrouter/meta-llama/llama-3'), {
    provider: 'openrouter',
    model: 'meta-llama/llama-3',
  });
  assert.throws(() => parseModelRef('gpt-4o'), /provider/);
  assert.ok(knownProviders().includes('compatible'));
  assert.ok(knownProviders().includes('ollama'));
});

test('compatible に --base-url がない場合は明示エラー', () => {
  assert.throws(() => resolveModel({ provider: 'compatible', model: 'x' }, {}), /--base-url/);
});

test('image input reaches the OpenAI-compatible API as an image, not a text placeholder', async () => {
  const fake = await startFakeServer();
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
  try {
    const model = resolveModel({ provider: 'compatible', model: 'vision', baseUrl: fake.url });
    for await (const _event of model.stream({ messages: [{ role: 'user', content: '画像\n説明して', images: [{ mediaType: 'image/png', data }] }], tools: [] }, new AbortController().signal)) { /* consume the stream */ }
    const messages = fake.requests[0].body.messages as { role: string; content: unknown }[];
    assert.deepEqual(messages.find(m => m.role === 'user')?.content, [
      { type: 'text', text: '画像\n説明して' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
    ]);
  } finally { await fake.close(); }
});
