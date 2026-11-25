import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { afterEach, beforeEach, type TestContext } from 'node:test';
import { runAgentLoop } from '../src/agent/loop.ts';
import type { AgentMessage } from '../src/agent/types.ts';
import { resolveModel } from '../src/model/factory.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

const secret = 'LOCAL_THINKING_SENTINEL';
const calls = [{ index: 0, id: 'call_fixture', type: 'function',
  function: { name: 'read_fixture', arguments: '{}' } }];
const settings = () => ({ root: process.cwd(), skills: false as const, signal: new AbortController().signal,
  approval: { approve: async () => false }, registry: new ToolRegistry([
    { name: 'read_fixture', description: 'read fixture', parameters: { type: 'object', properties: {} },
      readOnly: true, execute: async () => 'ACTUAL_TOOL_RESULT' },
  ]) });
type Body = { model: string; tools?: unknown[]; messages: Record<string, unknown>[] };

// These cases assert that loopback reasoning is replayed, which a recorder disables on purpose.
// Pin the ambient recorder state instead of inheriting a developer or CI shell value.
const recorderVars = ['AGENTICREPLAY_TLS_CA', 'AGENTICREPLAY_PROXY_URL'] as const;
const ambient = new Map<string, string | undefined>(recorderVars.map(name => [name, process.env[name]]));
beforeEach(() => { for (const name of recorderVars) delete process.env[name]; });
afterEach(() => {
  for (const name of recorderVars) {
    const value = ambient.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

function response(index: number, field: string, thinking = true) {
  const chunk = (delta: object, finish_reason: string | null = null) => ({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1,
    model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
  const payload = index === 1 ? [
    ...(thinking ? [chunk({ role: 'assistant', [field]: secret })] : []),
    chunk({ tool_calls: calls }), chunk({}, 'tool_calls'),
  ] : [chunk({ role: 'assistant', content: 'done' }), chunk({}, 'stop')];
  return payload.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
}

async function endpoint(t: TestContext, field: string, opts: { thinking?: boolean; redirect?: boolean } = {}) {
  const requests: Body[] = [];
  let redirects = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/redirected') { redirects++; res.writeHead(400).end(); return; }
    assert.equal(req.url, '/v1/chat/completions');
    let raw = '';
    for await (const x of req) raw += x;
    requests.push(JSON.parse(raw) as Body);
    if (opts.redirect && requests.length === 2) { res.writeHead(307, { location: '/redirected' }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(response(requests.length, field, opts.thinking !== false));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, redirects: () => redirects };
}

for (const [provider, field, other] of [['ollama', 'reasoning', 'reasoning_content'],
    ['llama-server', 'reasoning_content', 'reasoning']] as const) {
  test(`${provider} selected local preset sends exact reasoning field and tool result`, async t => {
    const e = await endpoint(t, field);
    const model = resolveModel({ provider, model: 'inkling-2-mini', baseUrl: e.baseUrl });
    const transcript: AgentMessage[] = [{ role: 'user', content: 'read' }];
    const result = await runAgentLoop(transcript, { ...settings(), model });
    assert.equal(result.outcome, 'complete');
    assert.equal(e.requests.length, 2);
    assert.equal(e.requests[0]?.model, 'inkling-2-mini');
    assert.equal(e.requests[0]?.tools?.length, 1);
    const assistant = e.requests[1]!.messages.find(x => x.role === 'assistant')!;
    assert.equal(assistant[field], secret);
    assert.equal(assistant[other], undefined);
    const tool = e.requests[1]!.messages.find(x => x.role === 'tool');
    assert.equal(tool?.tool_call_id, 'call_fixture');
    assert.match(String(tool?.content), /ACTUAL_TOOL_RESULT/);
    assert.equal(transcript.at(-1)?.role, 'assistant');
    assert.doesNotMatch(JSON.stringify(transcript), new RegExp(secret));
  });
}

for (const [provider, modelId, thinking] of [['ollama', 'inkling-2-mini', false],
    ['compatible', 'inkling-2-mini', true], ['ollama', 'alias:14b-cloud', true]] as const) {
  test(`no replay for ${provider}/${modelId} when dialect is not selected or no data exists (thinking=${thinking})`, async t => {
    const e = await endpoint(t, 'reasoning', { thinking });
    const model = resolveModel({ provider, model: modelId, baseUrl: e.baseUrl });
    assert.equal((await runAgentLoop([{ role: 'user', content: 'read' }], { ...settings(), model })).outcome, 'complete');
    assert.equal(e.requests.length, 2);
    assert.doesNotMatch(JSON.stringify(e.requests[1]), /LOCAL_THINKING_SENTINEL/);
    assert.match(JSON.stringify(e.requests[1]), /ACTUAL_TOOL_RESULT/);
  });
}

test('loopback replay request is not forwarded by redirects', async t => {
  const e = await endpoint(t, 'reasoning', { redirect: true });
  const model = resolveModel({ provider: 'ollama', model: 'inkling-2-mini', baseUrl: e.baseUrl });
  const result = await runAgentLoop([{ role: 'user', content: 'read' }], { ...settings(), model });
  assert.equal(result.outcome, 'error');
  assert.equal(e.requests.length, 2);
  assert.equal(e.redirects(), 0);
});

test('remote Ollama overrides and ollama-cloud never add local reasoning fields', async t => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  for (const provider of ['ollama', 'llama-server', 'ollama-cloud']) {
    const requests: Body[] = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(typeof url, 'string');
      assert.equal(url, 'https://fixture.invalid/v1/chat/completions');
      requests.push(JSON.parse(String(init?.body)) as Body);
      return new Response(response(requests.length, 'reasoning'), { headers: { 'content-type': 'text/event-stream' } });
    };
    const model = resolveModel({ provider, model: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'test-only' });
    assert.equal((await runAgentLoop([{ role: 'user', content: 'read' }], { ...settings(), model })).outcome, 'complete');
    assert.equal(requests.length, 2);
    assert.doesNotMatch(JSON.stringify(requests[1]), /LOCAL_THINKING_SENTINEL/);
  }
});
