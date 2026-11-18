import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONNECT_PROVIDERS, modelProviders, toRefs, SEARCH_ROW_VALUE } from '../src/cli/catalog.ts';
import { fetchProviderModels } from '../src/cli/model-catalog.ts';
import { knownProviders, supportsLiveModels, providerDefinition } from '../src/model/providers.ts';

/**
 * 固定モデルリストを持たないことの契約。
 * 一覧はプロバイダーから毎回取得し、取得できなければ空を返す(古い固定値へは落とさない)。
 *
 * 保存済みキーを読ませると実プロバイダーへ通信してしまうため、MODKH_HOME を空の一時領域へ向ける。
 */
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-catalog-'));
process.env['MODKH_HOME'] = isolatedHome;
test.after(() => { fs.rmSync(isolatedHome, { recursive: true, force: true }); });

test('no bundled model list survives in the picker metadata', () => {
  const exported = Object.keys(CONNECT_PROVIDERS[0] ?? {});
  assert.deepEqual(exported.sort(), ['detail', 'key', 'label', 'value'].sort(), 'rows carry no model list');
  assert.ok(modelProviders().every(provider => !('models' in provider)), 'provider rows never embed models');
  // 検索キー専用の登録はモデル接続の一覧に出さない。
  assert.equal(modelProviders().some(provider => provider.value === 'brave-search'), false);
});

test('OpenCode Zen and Go are separate rows sharing one key', () => {
  const zen = CONNECT_PROVIDERS.find(p => p.value === 'opencode');
  const go = CONNECT_PROVIDERS.find(p => p.value === 'opencode-go');
  assert.ok(zen && go, 'both endpoints are selectable');
  assert.equal(zen.key, 'OPENCODE_API_KEY');
  assert.equal(go.key, 'OPENCODE_API_KEY', 'the same key serves both');
  assert.notEqual(zen.detail, go.detail);
  assert.equal(providerDefinition('opencode-go')?.keyProvider, 'opencode');
});

test('every selectable model provider resolves to a known endpoint', () => {
  for (const provider of modelProviders()) {
    if (provider.value === 'brave-search') continue;
    assert.ok(knownProviders().includes(provider.value), `${provider.value} is a known provider`);
  }
  assert.equal(supportsLiveModels('compatible'), false, 'a free-form endpoint has no list path');
});

test('refs are built from fetched ids without duplicating the provider prefix', () => {
  assert.deepEqual(toRefs('opencode-go', ['glm-5.3', 'gpt-6-luna']),
    ['opencode-go/glm-5.3', 'opencode-go/gpt-6-luna']);
  assert.deepEqual(toRefs('opencode-go', ['opencode-go/glm-5.3']), ['opencode-go/glm-5.3']);
  assert.deepEqual(toRefs('opencode-go', ['glm-5.3'], 'opencode-go/kimi-k3'),
    ['opencode-go/glm-5.3', 'opencode-go/kimi-k3']);
  assert.equal(toRefs('opencode-go', []).includes(SEARCH_ROW_VALUE), false);
});

test('the live list shape is read from an OpenAI-compatible endpoint', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3' }, { id: 'qwen4-max' }, { id: 'glm-5.3' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { OPENCODE_GO_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, OPENCODE_API_KEY: 'k' };
    const result = await fetchProviderModels('opencode-go', new AbortController().signal, env);
    assert.deepEqual(result.ids, ['glm-5.3', 'qwen4-max'], 'duplicates collapse and the list is not sorted or trimmed');
    assert.equal(result.note, undefined);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a missing key or failing endpoint reports a reason instead of a bundled list', async () => {
  const noKey = await fetchProviderModels('opencode-go', new AbortController().signal, {});
  assert.deepEqual(noKey.ids, []);
  assert.match(noKey.note ?? '', /OPENCODE_API_KEY/);
  const server = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { OPENCODE_GO_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, OPENCODE_API_KEY: 'k' };
    const failed = await fetchProviderModels('opencode-go', new AbortController().signal, env);
    assert.deepEqual(failed.ids, [], 'no fallback to fixed ids');
    assert.match(failed.note ?? '', /HTTP 503/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('malformed rows are skipped without dropping the rest of the list', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'ok-model' }, { id: '' }, { id: ' bad id' }, { nope: 1 }, 'x'] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const env = { OPENCODE_GO_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, OPENCODE_API_KEY: 'k' };
    const result = await fetchProviderModels('opencode-go', new AbortController().signal, env);
    assert.deepEqual(result.ids, ['ok-model']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
