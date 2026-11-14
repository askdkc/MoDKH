import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginChatGpt, currentChatGptTokens } from '../src/model/chatgpt/login.ts';
import { saveChatGptTokens, loadChatGptTokens } from '../src/model/chatgpt/tokens.ts';

async function isolated(fn: () => Promise<void>) {
  const old = process.env.DKH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-oauth-lifecycle-'));
  process.env.DKH_HOME = home;
  try { await fn(); } finally {
    if (old === undefined) delete process.env.DKH_HOME; else process.env.DKH_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
}
async function listen(server: http.Server) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}
async function close(server: http.Server) { await new Promise<void>(r => server.close(() => r())); }

test('OAuth ignores wrong state/path, saves before browser success, and exchanges once', async () => isolated(async () => {
  let exchanges = 0;
  const issuer = http.createServer((req, res) => {
    assert.equal(req.url, '/oauth/token'); exchanges++;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'secret' }));
  });
  const port = await listen(issuer);
  try {
    const tokens = await loginChatGpt({ config: { issuer: `http://127.0.0.1:${port}`, clientId: 'test', redirectPort: 0 },
      timeoutMs: 3000, write: () => {}, openUrl: async raw => {
        const auth = new URL(raw), callback = new URL(auth.searchParams.get('redirect_uri')!);
        assert.equal(callback.pathname, '/auth/callback');
        const wrong = new URL(callback); wrong.search = '?error=access_denied&state=wrong';
        assert.equal((await fetch(wrong)).status, 400);
        wrong.pathname = '/callback'; wrong.searchParams.set('state', auth.searchParams.get('state')!);
        assert.equal((await fetch(wrong)).status, 404);
        assert.equal(exchanges, 0);
        callback.searchParams.set('code', 'once'); callback.searchParams.set('state', auth.searchParams.get('state')!);
        const response = await fetch(callback);
        assert.equal(response.status, 200);
        assert.equal(loadChatGptTokens()?.accessToken, 'secret');
      } });
    assert.equal(tokens.accessToken, 'secret'); assert.equal(exchanges, 1);
  } finally { await close(issuer); }
}));

test('OAuth cancellation and timeout release the exact callback port without persisting', async () => isolated(async () => {
  const reserve = http.createServer(); const port = await listen(reserve); await close(reserve);
  const config = { issuer: 'http://127.0.0.1:1', clientId: 'test', redirectPort: port };
  const ac = new AbortController();
  await assert.rejects(loginChatGpt({ config, signal: ac.signal, write: () => {}, openUrl: () => { ac.abort(); } }), /中止/);
  await assert.rejects(loginChatGpt({ config, timeoutMs: 40, write: () => {}, openUrl: () => {} }), /タイムアウト/);
  const reusable = http.createServer();
  await new Promise<void>((resolve, reject) => { reusable.once('error', reject); reusable.listen(port, '127.0.0.1', resolve); });
  await close(reusable); assert.equal(loadChatGptTokens(), null);
}));

test('occupied callback port fails before showing a browser URL', async () => {
  const server = http.createServer(); const port = await listen(server);
  let opened = false;
  try {
    await assert.rejects(loginChatGpt({ config: { issuer: 'http://127.0.0.1:1', clientId: 'test', redirectPort: port },
      openUrl: () => { opened = true; } }), /使用中/);
    assert.equal(opened, false);
  } finally { await close(server); }
});

test('token failure does not overwrite saved credentials or expose endpoint response bodies', async () => isolated(async () => {
  saveChatGptTokens({ accessToken: 'previous' });
  const issuer = http.createServer((_req, res) => { res.writeHead(401); res.end('secret-sensitive-body'); });
  const port = await listen(issuer);
  try {
    await assert.rejects(loginChatGpt({ config: { issuer: `http://127.0.0.1:${port}`, clientId: 'test', redirectPort: 0 },
      write: () => {}, openUrl: async raw => {
        const auth = new URL(raw), callback = new URL(auth.searchParams.get('redirect_uri')!);
        callback.search = new URLSearchParams({ code: 'fail', state: auth.searchParams.get('state')! }).toString();
        assert.equal((await fetch(callback)).status, 500);
      } }), error => error instanceof Error && /401/.test(error.message) && !error.message.includes('secret-sensitive-body'));
    assert.equal(loadChatGptTokens()?.accessToken, 'previous');
  } finally { await close(issuer); }
}));

test('expired credentials refresh once and preserve refresh token/account when omitted', async () => isolated(async () => {
  saveChatGptTokens({ accessToken: 'expired', expiresAt: '2020-01-01T00:00:00Z', refreshToken: 'refresh', accountId: 'acct' });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(String(url), 'https://auth.openai.com/oauth/token');
    assert.equal(new URLSearchParams(String(options?.body)).get('grant_type'), 'refresh_token');
    return Response.json({ access_token: 'renewed', expires_in: 3600 });
  };
  try {
    const tokens = await currentChatGptTokens();
    assert.equal(tokens.accessToken, 'renewed'); assert.equal(tokens.accountId, 'acct'); assert.equal(tokens.refreshToken, 'refresh');
    assert.equal((await currentChatGptTokens()).accessToken, 'renewed'); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
}));
