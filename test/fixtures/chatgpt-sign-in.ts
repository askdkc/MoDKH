import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

/** Exercise the real local listener and encrypted SDK store without contacting OpenAI or the OS keyring. */
export async function chatGptFixture(loginModule: string, apiFetch: typeof fetch) {
  const native = createRequire(loginModule)('@napi-rs/keyring');
  const OriginalEntry = native.AsyncEntry;
  let key: Uint8Array | undefined;
  native.AsyncEntry = class {
    async getSecret() { return key; }
    async setSecret(value: Uint8Array) { key = value; }
  };
  const originalFetch = globalThis.fetch;
  const issuer = 'https://auth.openai.com';
  const clientId = 'fixture-client';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture' };
  let authorization: URL;
  let hostId: string | null = null;
  let registrations = 0;
  const grant = { sharing: true, refreshes: 0 };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === issuer + '/.well-known/openid-configuration') return Response.json({
      issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks',
    });
    if (url === issuer + '/jwks') return Response.json({ keys: [jwk] });
    if (url !== issuer + '/token') return apiFetch(input, init);
    const body = init.body as URLSearchParams;
    assert.equal(body.get('client_id'), clientId);
    if (body.get('grant_type') === 'refresh_token') {
      grant.refreshes++;
      assert.equal(body.get('refresh_token'), 'refresh-fixture');
      return Response.json({ access_token: 'oauth-fixture', refresh_token: 'rotated', token_type: 'bearer', expires_in: 3600 });
    }
    const jwt = await new SignJWT({ nonce: authorization.searchParams.get('nonce') })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(issuer).setAudience(clientId)
      .setSubject('fixture-user').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return Response.json({ access_token: 'first-fixture', refresh_token: 'refresh-fixture', token_type: 'bearer',
      id_token: jwt, scope: 'openid offline_access' + (grant.sharing ? ' resource.invoke chatgpt.tokens.use.direct' : ''), expires_in: 15 });
  };
  const openUrl = async (raw: string) => {
    authorization = new URL(raw);
    const query = authorization.searchParams;
    assert.equal(query.get('client_id'), registrations++ ? clientId : 'dynamic_agent_client');
    const host = query.get('ext_agent_host_id');
    assert.match(host ?? '', /^urn:uuid:/);
    if (hostId) assert.equal(host, hostId);
    hostId = host;
    assert.match(query.get('scope') ?? '', /chatgpt.tokens.use.direct/);
    const callback = new URL(query.get('redirect_uri')!);
    callback.search = new URLSearchParams({ code: 'code', state: 'incorrect', client_id: clientId }).toString();
    assert.equal((await originalFetch(callback)).status, 400);
    callback.searchParams.set('state', query.get('state')!);
    assert.equal((await originalFetch(callback)).status, 200);
  };
  return { grant, openUrl, async signIn() { await (await import(loginModule)).loginChatGpt({ openUrl }); },
    restore() { globalThis.fetch = originalFetch; native.AsyncEntry = OriginalEntry; } };
}
