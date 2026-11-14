import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizeUrl, exchangeCode } from '../src/model/chatgpt/login.ts';
import { ResponsesApiModel } from '../src/model/chatgpt/responses.ts';

// Contract source: openai/codex login/src/server.rs (not derived from implementation).
test('ChatGPT uses the registered OAuth endpoints and offline scope', async () => {
  const u = new URL(buildAuthorizeUrl({ issuer: 'https://auth.openai.com', clientId: 'client',
    redirectUri: 'http://127.0.0.1:1455/auth/callback', verifier: 'proof', state: 'state' }));
  assert.equal(u.pathname, '/oauth/authorize');
  assert.ok(u.searchParams.get('scope')?.split(' ').includes('offline_access'));
  assert.equal(u.searchParams.get('codex_cli_simplified_flow'), 'true');
  let endpoint = '';
  const tokens = await exchangeCode({ issuer: 'https://auth.openai.com', clientId: 'client', code: 'code',
    verifier: 'proof', redirectUri: u.searchParams.get('redirect_uri')!,
    fetchImpl: async (url) => {
      endpoint = String(url);
      const claims = Buffer.from(JSON.stringify({ exp: 2000000000, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } })).toString('base64url');
      return Response.json({ access_token: `header.${claims}.signature` });
    } });
  assert.equal(endpoint, 'https://auth.openai.com/oauth/token');
  assert.equal(tokens.accountId, 'account-1');
  assert.equal(tokens.expiresAt, '2033-05-18T03:33:20.000Z');
});

test('ChatGPT subscription tokens go to Codex, not the paid API-key endpoint', async () => {
  let endpoint = '';
  const model = new ResponsesApiModel({ accessToken: 'test', model: 'gpt-test', fetchImpl: async (url) => {
    endpoint = String(url);
    return new Response('data: {"type":"response.completed"}\n\n');
  } });
  for await (const event of model.stream({ messages: [], tools: [], system: 'test' }, new AbortController().signal)) {
    if (event.type === 'finish') assert.equal(event.stopReason, 'stop');
  }
  assert.equal(endpoint, 'https://chatgpt.com/backend-api/codex/responses');
});
