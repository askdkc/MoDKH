import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFetchUrlTool, createWebSearchTool, htmlToText, parseBraveResults } from '../src/tools/web.ts';
import { defaultTools, ToolRegistry } from '../src/tools/registry.ts';
import { keysPath, resolveApiKey, saveKey } from '../src/cli/keys.ts';
import { ToolError, type ApprovalGate, type ApprovalRequest, type ToolContext, type ToolResult } from '../src/agent/types.ts';

class RecordingGate implements ApprovalGate {
  decision: boolean;
  requests: ApprovalRequest[] = [];
  constructor(decision = true) { this.decision = decision; }
  async approve(req: ApprovalRequest): Promise<boolean> {
    this.requests.push(req);
    return this.decision;
  }
}

interface Route {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** 応答を返さずに保持し、タイムアウトを試すため。 */
  hang?: boolean;
}

interface Server { origin: string; close(): Promise<void>; hits: string[] }

async function serve(routes: Record<string, Route | ((req: http.IncomingMessage) => Route)>): Promise<Server> {
  const hits: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const path = req.url ?? '/';
    hits.push(path);
    const route = routes[path.split('?')[0] ?? '/'];
    const spec = typeof route === 'function' ? route(req) : route;
    if (!spec) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (spec.hang) return;
    res.writeHead(spec.status ?? 200, spec.headers ?? { 'content-type': 'text/plain; charset=utf-8' });
    res.end(spec.body ?? '');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function ctx(gate: ApprovalGate, signal?: AbortSignal): ToolContext {
  return { root: process.cwd(), approval: gate, ...(signal ? { signal } : {}) };
}

async function call(tool: { execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string | Pick<ToolResult, 'status' | 'output'>> }, args: Record<string, unknown>, context: ToolContext): Promise<string> {
  const out = await tool.execute(args, context);
  return typeof out === 'string' ? out : out.output;
}

/** ToolError のコードは message ではなく code に入る。 */
async function rejectsWithCode(p: Promise<unknown>, code: string, note?: string): Promise<void> {
  await assert.rejects(p, (error: unknown) => {
    assert.ok(error instanceof ToolError, `ToolError を期待: ${String(error)}`);
    assert.equal(error.code, code, note ?? error.message);
    return true;
  });
}

test('fetch_url は毎回 outsideWorkspace で承認を求め、拒否されたら取得しない', async () => {
  const server = await serve({ '/page': { body: 'hello' } });
  try {
    const denied = new RecordingGate(false);
    await rejectsWithCode(call(createFetchUrlTool(), { url: `${server.origin}/page` }, ctx(denied)), 'DENIED');
    assert.equal(denied.requests.length, 1);
    assert.equal(denied.requests[0]!.outsideWorkspace, true, 'ワークスペース外として承認を求める');
    assert.deepEqual(server.hits, [], '拒否後は通信しない');
  } finally {
    await server.close();
  }
});

test('fetch_url はHTMLを本文テキストにして返す', async () => {
  const server = await serve({
    '/doc': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html><head><style>p{}</style></head><body><h1>見出し</h1><p>本文 &amp; 続き</p><script>bad()</script></body></html>' },
  });
  try {
    const gate = new RecordingGate(true);
    const out = await call(createFetchUrlTool(), { url: `${server.origin}/doc` }, ctx(gate));
    assert.match(out, /状態: 200/);
    assert.match(out, /本文\(HTML→テキスト\)/);
    assert.match(out, /見出し/);
    assert.match(out, /本文 & 続き/);
    assert.doesNotMatch(out, /bad\(\)/, 'script の中身は落とす');
    assert.doesNotMatch(out, /p\{\}/, 'style の中身は落とす');
    assert.doesNotMatch(out, /<p>/, 'タグは残さない');
    assert.equal(gate.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('fetch_url は転送先ごとに承認を求め、拒否すれば転送先へは行かない', async () => {
  const other = await serve({ '/secret': { body: 'secret' } });
  const server = await serve({
    '/start': { status: 302, headers: { location: `${other.origin}/secret` }, body: '' },
  });
  try {
    const gate = new RecordingGate(true);
    let calls = 0;
    const firstOnly: ApprovalGate = {
      async approve(req) {
        calls++;
        gate.requests.push(req);
        return calls === 1;
      },
    };
    await rejectsWithCode(call(createFetchUrlTool(), { url: `${server.origin}/start` }, ctx(firstOnly)), 'DENIED');
    assert.equal(calls, 2, '転送のたびに承認を求める');
    assert.match(gate.requests[1]!.detail, /\/secret/);
    assert.deepEqual(other.hits, [], '拒否された転送先は取得しない');
  } finally {
    await server.close();
    await other.close();
  }
});

test('fetch_url はバイト上限で打ち切り、打ち切ったことを明示する', async () => {
  const server = await serve({ '/big': { body: 'a'.repeat(5000) } });
  try {
    const out = await call(createFetchUrlTool(), { url: `${server.origin}/big`, maxBytes: 100 }, ctx(new RecordingGate(true)));
    assert.match(out, /上限 100 バイトで打ち切り/);
    assert.match(out, /受信は上記のバイト上限で打ち切り/);
    assert.ok(!out.includes('a'.repeat(101)), '上限を超えた本文を返さない');
  } finally {
    await server.close();
  }
});

test('fetch_url は制限時間を超えたら TIMEOUT として返す', async () => {
  const server = await serve({ '/slow': { hang: true } });
  try {
    await rejectsWithCode(call(createFetchUrlTool({ timeoutMs: 150 }), { url: `${server.origin}/slow` }, ctx(new RecordingGate(true))), 'TIMEOUT');
  } finally {
    await server.close();
  }
});

test('fetch_url はhttp/https以外と資格情報つきURLを拒否する', async () => {
  const gate = new RecordingGate(true);
  const tool = createFetchUrlTool();
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'https://user:secret@example.com/']) {
    await rejectsWithCode(call(tool, { url }, ctx(gate)), 'INVALID_ARGS', url);
  }
  assert.deepEqual(gate.requests, [], '不正なURLでは承認も求めない');
});

test('fetch_url はテキストでない応答を本文として表示しない', async () => {
  const server = await serve({ '/bin': { headers: { 'content-type': 'application/octet-stream' }, body: '\u0000\u0001binary' } });
  try {
    const out = await call(createFetchUrlTool(), { url: `${server.origin}/bin` }, ctx(new RecordingGate(true)));
    assert.match(out, /本文はテキストではないため表示しない/);
    assert.doesNotMatch(out, /binary/);
  } finally {
    await server.close();
  }
});

test('web_search はキーが無ければ通信せずに理由を返す', async () => {
  const server = await serve({ '/search': { headers: { 'content-type': 'application/json' }, body: '{"web":{"results":[]}}' } });
  try {
    const gate = new RecordingGate(true);
    const tool = createWebSearchTool({ searchEndpoint: `${server.origin}/search`, keyLookup: () => undefined });
    await rejectsWithCode(call(tool, { query: 'node test' }, ctx(gate)), 'NO_KEY');
    assert.deepEqual(gate.requests, [], 'キーが無ければ承認も求めない');
    assert.deepEqual(server.hits, [], '通信しない');
  } finally {
    await server.close();
  }
});

test('web_search は承認後にだけクエリを送り、タイトルとURLだけを返す', async () => {
  let seen: { url?: string; token?: string | undefined } = {};
  const server = await serve({
    '/search': (req) => {
      seen = { url: req.url, token: req.headers['x-subscription-token'] as string | undefined };
      return {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ web: { results: [
          { title: 'Alpha &amp; Beta', url: 'https://example.com/a', description: '要約 <b>1</b>' },
          { title: 'no url' },
          { title: 'Gamma', url: 'https://example.com/g', description: '' },
        ] } }),
      };
    },
  });
  try {
    const gate = new RecordingGate(true);
    const tool = createWebSearchTool({ searchEndpoint: `${server.origin}/search`, keyLookup: () => 'test-key' });
    const out = await call(tool, { query: 'modkh web', count: 2 }, ctx(gate));
    assert.equal(gate.requests.length, 1);
    assert.equal(gate.requests[0]!.outsideWorkspace, true);
    assert.match(seen.url ?? '', /q=modkh\+web/);
    assert.equal(seen.token, 'test-key');
    assert.match(out, /2 件/);
    assert.match(out, /Alpha & Beta/);
    assert.match(out, /https:\/\/example\.com\/a/);
    assert.match(out, /要約 1/);
    assert.doesNotMatch(out, /test-key/, 'キーを結果へ出さない');
  } finally {
    await server.close();
  }
});

test('web_search は承認を拒否されたら通信しない', async () => {
  const server = await serve({ '/search': { headers: { 'content-type': 'application/json' }, body: '{"web":{"results":[]}}' } });
  try {
    const tool = createWebSearchTool({ searchEndpoint: `${server.origin}/search`, keyLookup: () => 'k' });
    await rejectsWithCode(call(tool, { query: 'x' }, ctx(new RecordingGate(false))), 'DENIED');
    assert.deepEqual(server.hits, []);
  } finally {
    await server.close();
  }
});

test('htmlToText はエンティティを復号し、script/style を落とす', () => {
  const text = htmlToText('<div>a&nbsp;b &#x41; &#66; &unknown;</div><script>1</script><p>c<br>d</p>');
  assert.match(text, /a b A B &unknown;/);
  assert.doesNotMatch(text, /<div>/);
  assert.match(text, /c\nd/);
});

test('parseBraveResults はURLが無い行を捨て、件数で打ち切る', () => {
  const hits = parseBraveResults({ web: { results: [
    { title: 'a', url: 'https://a.example', description: 'x' },
    { title: 'b' },
    { title: 'c', url: 'https://c.example', description: 'y' },
  ] } }, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.url, 'https://a.example');
  assert.deepEqual(parseBraveResults({ web: {} }, 5), []);
  assert.deepEqual(parseBraveResults(null, 5), []);
});

test('defaultTools() は web_search と fetch_url を含み、両方 readOnly である', () => {
  const registry = new ToolRegistry(defaultTools());
  for (const name of ['web_search', 'fetch_url']) {
    const tool = registry.get(name);
    assert.ok(tool, `${name} が登録されている`);
    assert.equal(tool!.readOnly, true, `${name} は読み取り専用として扱う`);
  }
  assert.equal(registry.get('web_search')!.name, 'web_search');
});

test('registry 経由の fetch_url は承認拒否を error として返し、未知の引数を弾く', async () => {
  const registry = new ToolRegistry(defaultTools());
  const denied = await registry.executeOne(
    { id: 'c1', name: 'fetch_url', args: { url: 'http://127.0.0.1:1/x' } },
    ctx(new RecordingGate(false)),
  );
  assert.equal(denied.status, 'error');
  assert.match(denied.output, /DENIED/);

  const invalid = await registry.executeOne(
    { id: 'c2', name: 'fetch_url', args: { url: 'http://example.com', nope: 1 } },
    ctx(new RecordingGate(true)),
  );
  assert.equal(invalid.status, 'error');
  assert.match(invalid.output, /未知の引数/);
});

test('web_search の未登録キーは環境変数と保存済みキーのどちらかから解決される', async () => {
  const gate = new RecordingGate(true);
  const tool = createWebSearchTool({
    searchEndpoint: 'http://127.0.0.1:1/search',
    keyLookup: (env: NodeJS.ProcessEnv) => (env['PROBE'] === 'x' ? 'k' : undefined),
  });
  const before = process.env['PROBE'];
  try {
    delete process.env['PROBE'];
    await rejectsWithCode(call(tool, { query: 'q' }, ctx(gate)), 'NO_KEY');
    process.env['PROBE'] = 'x';
    // キーは解決できたが到達できないホストなので、承認後に取得失敗として返る。
    await rejectsWithCode(call(tool, { query: 'q' }, ctx(gate)), 'FETCH_FAILED');
    assert.equal(gate.requests.length, 1, 'キーがある場合だけ承認を求めて通信する');
  } finally {
    if (before === undefined) delete process.env['PROBE'];
    else process.env['PROBE'] = before;
  }
});

test('保存済みキーの解決は brave-search の名前を使う(既定の解決経路)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-web-'));
  const before = process.env['MODKH_HOME'], beforeKey = process.env['BRAVE_SEARCH_API_KEY'];
  process.env['MODKH_HOME'] = home;
  delete process.env['BRAVE_SEARCH_API_KEY'];
  try {
    assert.equal(resolveApiKey('brave-search', process.env, 'BRAVE_SEARCH_API_KEY'), undefined);
    saveKey('brave-search', 'saved-key');
    assert.equal(resolveApiKey('brave-search', process.env, 'BRAVE_SEARCH_API_KEY'), 'saved-key');
    assert.equal(fs.statSync(keysPath()).mode & 0o777, 0o600, 'キーは本人だけが読める');
    process.env['BRAVE_SEARCH_API_KEY'] = 'env-key';
    assert.equal(resolveApiKey('brave-search', process.env, 'BRAVE_SEARCH_API_KEY'), 'env-key', '環境変数が優先される');
  } finally {
    if (before === undefined) delete process.env['MODKH_HOME']; else process.env['MODKH_HOME'] = before;
    if (beforeKey === undefined) delete process.env['BRAVE_SEARCH_API_KEY']; else process.env['BRAVE_SEARCH_API_KEY'] = beforeKey;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
