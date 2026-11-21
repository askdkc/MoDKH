import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  createPkcePair,
  buildAuthorizeUrl,
  exchangeCode,
  loginChatGpt,
} from '../src/model/chatgpt/login.ts';
import {
  loadChatGptTokens,
  saveChatGptTokens,
  clearChatGptTokens,
  chatGptAuthPath,
} from '../src/model/chatgpt/tokens.ts';
import { ResponsesApiModel } from '../src/model/chatgpt/responses.ts';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { MODKH_SKILL_BINDING, readBundledSkill } from '../src/agent/bundled-skills.ts';
import type { AgentMessage } from '../src/agent/types.ts';

function withHome<T>(fn: () => T): T {
  const prev = process.env['MODKH_HOME'];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-auth-'));
  process.env['MODKH_HOME'] = home;
  try {
    return fn();
  } finally {
    process.env['MODKH_HOME'] = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function withHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env['MODKH_HOME'];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-auth-'));
  process.env['MODKH_HOME'] = home;
  try {
    return await fn();
  } finally {
    process.env['MODKH_HOME'] = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('PKCE ペアと認可URLがS256で作られる', () => {
  const { verifier, challenge } = createPkcePair();
  const recomputed = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, recomputed);
  assert.ok(verifier.length >= 43);
  const url = new URL(
    buildAuthorizeUrl({
      issuer: 'https://auth.example.test',
      clientId: 'client-x',
      redirectUri: 'http://127.0.0.1:1455/callback',
      verifier,
      state: 'st-1',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://auth.example.test/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-x');
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'st-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/callback');
});

test('トークン交換は認可コードと code_verifier を送る', async () => {
  let seen: Record<string, string> = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')));
    req.on('end', () => {
      seen = Object.fromEntries(new URLSearchParams(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, account_id: 'acct' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const tokens = await exchangeCode({
      issuer: `http://127.0.0.1:${port}`,
      clientId: 'client-x',
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri: 'http://127.0.0.1:1455/callback',
    });
    assert.equal(tokens.accessToken, 'at-1');
    assert.equal(tokens.refreshToken, 'rt-1');
    assert.ok(tokens.expiresAt !== undefined);
    assert.equal(seen['grant_type'], 'authorization_code');
    assert.equal(seen['code'], 'code-1');
    assert.equal(seen['code_verifier'], 'verifier-1');
    assert.equal(seen['client_id'], 'client-x');
    assert.equal(seen['redirect_uri'], 'http://127.0.0.1:1455/callback');
  } finally {
    server.close();
  }
});

test('auth login chatgpt は認可URL→ローカル受信→交換→保存まで通る', async () => {
  await withHomeAsync(async () => {
    const tokenRequests: Record<string, string>[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === '/oauth/token') {
        let raw = '';
        req.on('data', (d: Buffer) => (raw += d.toString('utf8')));
        req.on('end', () => {
          tokenRequests.push(Object.fromEntries(new URLSearchParams(raw)));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'at-login', expires_in: 3600 }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    // リダイレクト受信用の空きポートを確保する
    const redirectServer = http.createServer(() => {});
    await new Promise<void>((r) => redirectServer.listen(0, '127.0.0.1', r));
    const redirectPort = (redirectServer.address() as AddressInfo).port;
    redirectServer.close();

    try {
      const tokens = await loginChatGpt({
        config: { issuer: `http://127.0.0.1:${port}`, clientId: 'client-x', redirectPort },
        openUrl: async (url) => {
          // 検証ではブラウザの代わりに、認可URLから state を取ってリダイレクトを再現する
          const u = new URL(url);
          await fetch(
            `${u.searchParams.get('redirect_uri')}?code=code-9&state=${u.searchParams.get('state')}`,
          );
        },
      });
      assert.equal(tokens.accessToken, 'at-login');
      assert.equal(loadChatGptTokens()?.accessToken, 'at-login');
      assert.equal(tokenRequests[0]['code'], 'code-9');
      assert.ok(tokenRequests[0]['code_verifier']?.length >= 43);
      // 保存先はハーネス専用で、権限は本人のみ
      const stat = fs.statSync(chatGptAuthPath());
      assert.equal(stat.mode & 0o777, 0o600);
    } finally {
      server.close();
    }
  });
});

test('トークン保存は復元・消去でき、未保存は null', () => {
  withHome(() => {
    assert.equal(loadChatGptTokens(), null);
    saveChatGptTokens({ accessToken: 'at-2', refreshToken: 'rt-2' });
    const loaded = loadChatGptTokens();
    assert.equal(loaded?.accessToken, 'at-2');
    assert.equal(loaded?.refreshToken, 'rt-2');
    clearChatGptTokens();
    assert.equal(loadChatGptTokens(), null);
  });
});

test('Responses API アダプターが偽SSEでストリーミング+関数往復を完走する', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const input = body['input'] as { type?: string }[];
      const hasOutput = input.some((i) => i.type === 'function_call_output');
      const send = (ev: Record<string, unknown>) => {
        res.write(`event: ${ev['type']}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      if (!hasOutput) {
        send({ type: 'response.output_text.delta', delta: 'ファ' });
        send({ type: 'response.output_text.delta', delta: 'イルを読みます' });
        send({
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: 'fc1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        });
        send({ type: 'response.completed' });
      } else {
        send({ type: 'response.output_text.delta', delta: 'hello world を確認した' });
        send({ type: 'response.completed' });
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-responses-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n');
    const model = new ResponsesApiModel({
      accessToken: 'sk-test',
      model: 'gpt-fake',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const deltas: string[] = [];
    const executed: string[] = [];
    const messages: AgentMessage[] = [{ role: 'user', content: 'a.txt を読んで' }];
    const r = await runAgentLoop(messages, {
      model,
      registry: new ToolRegistry(defaultTools()),
      root,
      system: 'テスト用指示',
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
    // 要求は公式契約どおり: フラットな function ツール、store:false、会話状態はCLI保持
    const first = requests[0];
    assert.equal(first['store'], false);
    // 日本語の依頼ではホスト指示にルーター、常時注入のUI指針、日本語スキルが追加される。
    const instructions = 'テスト用指示\n\n' + MODKH_SKILL_BINDING
      + `\n[kiokuko-soul]\n${readBundledSkill('kiokuko-soul')}\n`
      + `\n[kiokuko-ui-design-soul]\n${readBundledSkill('kiokuko-ui-design-soul')}\n`
      + `\n[natural-japanese-output]\n${readBundledSkill('natural-japanese-output')}\n`;
    assert.equal(first['instructions'], instructions);
    const tools = first['tools'] as { type: string; name: string; strict: boolean }[];
    assert.ok(tools.some((t) => t.type === 'function' && t.name === 'read_file'));
    assert.equal(tools[0].strict, false);
    const second = requests[1];
    assert.equal(second['instructions'], instructions);
    assert.doesNotMatch(JSON.stringify(second['input']), /MODKH host binding|\[natural-japanese-output\]/);
    const input2 = second['input'] as { type?: string; output?: string }[];
    const outItem = input2.find((i) => i.type === 'function_call_output');
    assert.ok(outItem);
    assert.match(outItem.output ?? '', /hello world/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    server.close();
  }
});

test('Responses API のHTTPエラーは error としてループに伝わる', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const model = new ResponsesApiModel({
      accessToken: 'sk-test',
      model: 'gpt-fake',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const messages: AgentMessage[] = [{ role: 'user', content: 'hi' }];
    const r = await runAgentLoop(messages, {
      model,
      registry: new ToolRegistry(defaultTools()),
      root: os.tmpdir(),
      signal: new AbortController().signal,
      approval: { approve: async () => true },
    });
    assert.equal(r.outcome, 'error');
    assert.match(r.errorMessage ?? '', /500/);
  } finally {
    server.close();
  }
});
