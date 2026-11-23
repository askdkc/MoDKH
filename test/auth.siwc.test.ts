import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chatGptFixture } from './fixtures/chatgpt-sign-in.ts';
import { fetchOfficialModels } from '../src/cli/official-models.ts';
import { buildModelFromRef } from '../src/model/connection.ts';
import { hasChatGptConnection } from '../src/model/chatgpt/tokens.ts';

test('DevKit registration, consent, encrypted session, refresh and tool-capable inference', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'modkh-siwc-'));
  const previous = process.env.MODKH_HOME;
  process.env.MODKH_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = previous; });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let requests = 0;
  const fixture = await chatGptFixture(new URL('../src/model/chatgpt/login.ts', import.meta.url).href, async (input, init = {}) => {
    const url = String(input);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer oauth-fixture');
    if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ slug: 'example', visibility: 'list' }] });
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body));
    assert.equal(body.tools[0].type, 'namespace');
    assert.equal(body.tools[0].name, 'modkh');
    assert.equal(body.tools[0].tools[0].name, 'read_file');
    assert.equal(body.input[0].namespace, 'modkh');
    assert.equal(body.store, false);
    requests++;
    return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  t.after(fixture.restore);
  fixture.grant.sharing = false;
  await assert.rejects(fixture.signIn(), /許可/);
  assert.equal(hasChatGptConnection(), false);
  fixture.grant.sharing = true;
  await fixture.signIn();
  assert.equal(hasChatGptConnection(), true);
  assert.doesNotMatch(readFileSync(path.join(home, 'siwc/chatgpt-auth.json'), 'utf8'), /refresh-fixture|first-fixture/);
  const signal = AbortSignal.timeout(5000);
  assert.deepEqual(await fetchOfficialModels('chatgpt', signal), ['chatgpt/example']);
  const model = buildModelFromRef('chatgpt/example');
  const events = [];
  for await (const event of model.stream({ system: 'test',
    messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_file', args: {} }] },
      { role: 'tool', results: [{ callId: 'call', name: 'read_file', status: 'ok', output: 'file' }] }],
    tools: [{name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }] }, signal)) events.push(event);
  assert.ok(events.some(event => event.type === 'text-delta' && event.text === 'ok'));
  assert.equal(fixture.grant.refreshes, 1);
  assert.equal(requests, 1);
});
