import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { runAgentLoop } from '../src/agent/loop.ts';
import type { AgentMessage, Model, ProviderContinuation } from '../src/agent/types.ts';
import { AiSdkModel } from '../src/model/ai-sdk.ts';
import { ResponsesApiModel } from '../src/model/chatgpt/responses.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

const opts = () => ({
  registry: new ToolRegistry([{ name: 'inspect_fixture', description: 'test', parameters: { type: 'object', properties: {} },
    readOnly: true, execute: async () => 'observed' }]),
  root: process.cwd(), approval: { approve: async () => false }, signal: new AbortController().signal, skills: false as const,
});
const sse = (frames: unknown[]) => new Response(frames.map(x => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n').join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const secret = 'PRIVATE_CONTINUATION_SENTINEL';

// Replay is the default; the recorder case below sets these itself. Pin the ambient
// recorder state so an inherited value cannot silently disable every replay assertion.
const recorderVars = ['AGENTICREPLAY_TLS_CA', 'AGENTICREPLAY_PROXY_URL'] as const;
const ambient = new Map<string, string | undefined>(recorderVars.map(name => [name, process.env[name]]));
const clearRecorder = () => { for (const name of recorderVars) delete process.env[name]; };
const restoreRecorder = () => {
  for (const name of recorderVars) {
    const value = ambient.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
};
beforeEach(clearRecorder);
afterEach(restoreRecorder);

function fixture(kind: 'astra' | 'deepseek', fail = false, reflect = false) {
  const bodies: Record<string, unknown>[] = [];
  const chunk = (delta: object, finish_reason: string | null = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-pro',
    choices: [{ index: 0, delta, finish_reason }] });
  const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: secret };
  const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'inspect_fixture', namespace: 'modkh', arguments: '{}' };
  const model: Model = kind === 'astra'
    ? new ResponsesApiModel({ model: 'gpt-6.2-astra', accessToken: 'fixture', fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (reflect && bodies.length > 1) return new Response(JSON.stringify({ error: { message: secret } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
      return sse(bodies.length === 1 ? [
        { type: 'response.output_item.done', item: reasoning },
        { type: 'response.output_item.done', item: call },
        fail ? { type: 'response.failed' } : { type: 'response.completed', response: { output: [reasoning, call] } },
      ] : [{ type: 'response.output_text.delta', delta: 'done' }, { type: 'response.completed' }]);
    } })
    : new AiSdkModel({ id: 'deepseek/deepseek-v4-pro', provider: 'deepseek', languageModel: createDeepSeek({ apiKey: 'fixture', fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (reflect && bodies.length > 1) return new Response(JSON.stringify({ error: { message: secret } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
      return sse(bodies.length === 1 ? [
        chunk({ role: 'assistant', reasoning_content: 'PRIVATE_CONT' }),
        chunk({ reasoning_content: 'INUATION_SENTINEL' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'inspect_fixture', arguments: '{}' } }] }),
        chunk({}, fail ? 'length' : 'tool_calls'), '[DONE]',
      ] : [chunk({ role: 'assistant', content: 'done', reasoning_content: 'PRIVATE_NO_TOOL' }), chunk({}, 'stop'), '[DONE]']);
    } })('deepseek-v4-pro') });
  return { model, bodies, reasoning, call };
}
const wire = (body: Record<string, unknown>) => (body.input ?? body.messages) as Record<string, unknown>[];
function state() { return new WeakMap<AgentMessage, { model: Model; value: ProviderContinuation }>(); }

for (const kind of ['astra', 'deepseek'] as const) {
  test(`${kind}: actual adapter replays complete private data in order, not in transcript`, async () => {
    const { model, bodies, reasoning, call } = fixture(kind);
    const continuationState = state();
    const messages: AgentMessage[] = [{ role: 'user', content: 'inspect' }];
    assert.equal((await runAgentLoop(messages, { ...opts(), model, continuationState, transientContext: 'MEMORY_SENTINEL' })).outcome, 'complete');
    assert.equal(bodies.length, 2);
    const first = wire(bodies[0]!);
    const next = wire(bodies[1]!);
    assert.ok(first.length);
    if (kind === 'astra') {
      const pos = next.findIndex(item => item.type === 'reasoning');
      assert.notEqual(pos, -1, 'encrypted reasoning item must reach the second wire request');
      assert.deepEqual(next.slice(pos, pos + 2), [reasoning, call]);
      assert.equal(next[pos + 2]?.call_id, 'call_1');
    } else {
      assert.equal(next.find(item => item.role === 'assistant')?.reasoning_content, secret);
      assert.equal(next.find(item => item.role === 'tool')?.tool_call_id, 'call_1');
    }
    assert.deepEqual(next.slice(0, first.length), first);
    assert.match(JSON.stringify(next.at(-1)), /observed/);
    assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_|MEMORY_SENTINEL/);
    if (kind === 'deepseek') {
      messages.push({ role: 'user', content: 'another turn' });
      await runAgentLoop(messages, { ...opts(), model, continuationState });
      assert.match(JSON.stringify(bodies[2]), /PRIVATE_NO_TOOL/);
    }
    const otherRun = fixture(kind);
    const newMessages: AgentMessage[] = [...messages, { role: 'user', content: 'different connection' }];
    await runAgentLoop(newMessages, { ...opts(), model: otherRun.model, continuationState });
    assert.doesNotMatch(JSON.stringify(otherRun.bodies[0]), /PRIVATE_/);
  });

  test(`${kind}: recorder mode and incomplete response do not retain private output`, async () => {
    process.env.AGENTICREPLAY_TLS_CA = '/fixture/recording-ca';
    const recorded = fixture(kind), map = state();
    const journal: AgentMessage[] = [{ role: 'user', content: 'inspect' }];
    assert.equal((await runAgentLoop(journal, { ...opts(), model: recorded.model, continuationState: map })).outcome, 'complete');
    assert.doesNotMatch(JSON.stringify(recorded.bodies[1]), /PRIVATE_/);
    assert.ok(journal.every(message => !map.has(message)));
    delete process.env.AGENTICREPLAY_TLS_CA;
    const incomplete = fixture(kind, true);
    const messages: AgentMessage[] = [{ role: 'user', content: 'inspect' }];
    assert.equal((await runAgentLoop(messages, { ...opts(), model: incomplete.model, continuationState: map })).outcome, 'error');
    assert.equal(incomplete.bodies.length, 1);
    assert.ok(messages.every(message => !map.has(message)));
    assert.equal(messages.at(-1)?.role, 'tool');
  });
}

for (const kind of ['astra', 'deepseek'] as const) {
  test(`${kind}: an HTTP failure reflecting private data is not persisted as a diagnostic`, async () => {
    const { model, bodies } = fixture(kind, false, true);
    const messages: AgentMessage[] = [{ role: 'user', content: 'inspect' }];
    const result = await runAgentLoop(messages, { ...opts(), model });
    assert.equal(result.outcome, 'error');
    assert.equal(bodies.length, 2);
    assert.match(JSON.stringify(bodies[1]), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify({ messages, result }), new RegExp(secret));
  });
}
