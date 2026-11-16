import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRepeatedLines, TEXT_RUN_MARKER, toolContext, TOOL_OUTPUT_BYTES } from '../src/model/context.ts';
import { toResponsesInput } from '../src/model/chatgpt/responses.ts';
import type { AgentMessage } from '../src/agent/types.ts';

const decode = (text: string) => text.startsWith(TEXT_RUN_MARKER)
  ? (JSON.parse(text.slice(TEXT_RUN_MARKER.length)) as {text: string; count: number}[]).map(r => r.text.repeat(r.count)).join('') : text;

test('repeated lines round-trip exactly, including CRLF, Unicode, blank lines and trailing text', () => {
  for (const text of ['', 'a', 'あ🙂\r\n'.repeat(2000) + '\n\nTAIL', '\n'.repeat(4000), 'a\nb\n'.repeat(2000), 'x'.repeat(2_000_001)]) {
    const result = compactRepeatedLines(text);
    assert.equal(decode(result), text);
    assert.ok(Buffer.byteLength(result) <= Buffer.byteLength(text));
  }
  const text = 'Repeated log line\n'.repeat(5000) + 'LAST_ERROR';
  assert.ok(Buffer.byteLength(compactRepeatedLines(text)) < Buffer.byteLength(text) / 100);
});

test('tool projection preserves call IDs, statuses and audit text while encoding repeated bodies', () => {
  const output = 'line\n'.repeat(10000) + 'diagnostic';
  const messages: AgentMessage[] = [{ role: 'tool', results: [{ callId: 'a', name: 'run_command', status: 'unknown', output }] }];
  const before = structuredClone(messages);
  const projected = toolContext(messages).get('0:0')!;
  assert.equal(decode(projected), output);
  assert.ok(Buffer.byteLength(projected) < TOOL_OUTPUT_BYTES);
  const wire = toResponsesInput(messages)[0];
  assert.equal(wire.call_id, 'a');
  assert.equal(JSON.parse(wire.output!).status, 'unknown');
  assert.equal(decode(JSON.parse(wire.output!).output), output);
  assert.deepEqual(messages, before);
});

test('oversized nonrepeating output retains header and tail, never partial encoded JSON or broken UTF-8', () => {
  const output = 'HEADER\n' + Array.from({ length: 10000 }, (_, i) => `あ🙂${i}\n`).join('') + '\nLAST_ERROR';
  const messages: AgentMessage[] = [{ role: 'tool', results: [{ callId: 'a', name: 'run_command', status: 'error', output }] }];
  const projected = toolContext(messages).get('0:0')!;
  assert.match(projected, /HEADER/);
  assert.match(projected, /LAST_ERROR$/);
  assert.match(projected, /中間省略/);
  assert.doesNotMatch(projected, /\uFFFD/);
  assert.ok(Buffer.byteLength(projected) <= TOOL_OUTPUT_BYTES);
  assert.equal(messages[0].role === 'tool' && messages[0].results[0].output, output);
});

test('earlier tool projections are never rewritten when later results arrive', () => {
  // A rewritten body changes already-sent messages, which invalidates the provider's cache.
  const big = (n: number) => `HEADER${n}\n` + Array.from({ length: 4000 }, (_, i) => `line ${n}-${i} ${'x'.repeat(40)}\n`).join('') + 'TAIL';
  const messages: AgentMessage[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '' }];
  const snapshots: Map<string, string>[] = [];
  for (let step = 0; step < 6; step++) {
    messages.push({ role: 'tool', results: [{ callId: `c${step}`, name: 'run_command', status: 'ok', output: big(step) }] });
    snapshots.push(toolContext(messages));
  }
  for (let i = 1; i < snapshots.length; i++) {
    for (const [key, value] of snapshots[i - 1]) {
      assert.equal(snapshots[i].get(key), value, `${key} must keep the bytes it was first sent with`);
    }
  }
  // The newest step still gets its own full allowance rather than what earlier steps left over.
  const newest = snapshots.at(-1)!.get(`${messages.length - 1}:0`)!;
  assert.ok(Buffer.byteLength(snapshots[0].get('2:0')!) <= TOOL_OUTPUT_BYTES, 'each body stays within its own allowance');
  assert.ok(Buffer.byteLength(newest) <= TOOL_OUTPUT_BYTES);
});

test('installed AI SDK serializes the compact body and status without opening a network listener', async t => {
  const { resolveModel } = await import('../src/model/factory.ts');
  let sent: { messages: { role: string; content: string }[] } | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    const frame = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content: 'DONE' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const output = 'repeated\n'.repeat(5000) + 'FINAL';
  const messages: AgentMessage[] = [
    { role: 'user', content: 'inspect' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'run_command', args: {} }] },
    { role: 'tool', results: [{ callId: 'a', name: 'run_command', status: 'error', output }] },
  ];
  const model = resolveModel({ provider: 'compatible', model: 'fixture', baseUrl: 'https://fixture.invalid/v1' });
  let answer = '';
  for await (const event of model.stream({ messages, tools: [], system: 'POLICY' }, new AbortController().signal)) {
    if (event.type === 'text-delta') answer += event.text;
  }
  assert.equal(answer, 'DONE');
  const result = JSON.parse(sent!.messages.find(m => m.role === 'tool')!.content);
  assert.equal(result.status, 'error');
  assert.equal(decode(result.output), output);
  assert.ok(Buffer.byteLength(result.output) < 1024);
});
