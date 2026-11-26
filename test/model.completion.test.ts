import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ResponsesApiModel, toResponsesInput } from '../src/model/chatgpt/responses.ts';
import { resolveModel } from '../src/model/factory.ts';
import type { ModelEvent } from '../src/agent/types.ts';

test('model input preserves structured tool status instead of only its prose', () => {
  const input = toResponsesInput([{ role: 'tool', results: [{ callId: 'c', name: 'effect', status: 'unknown', output: 'partial evidence' }] }]);
  assert.ok(typeof input[0].output === 'string');
  assert.deepEqual(JSON.parse(input[0].output), { status: 'unknown', output: 'partial evidence' });
});

for (const terminal of ['', 'response.failed', 'response.incomplete']) {
  test(`Responses does not report completion on ${terminal || 'EOF'}`, async () => {
    const events = [{ type: 'response.output_text.delta', delta: 'partial' }];
    const stream = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
      + (terminal ? `data: ${JSON.stringify({ type: terminal })}\n\n` : '');
    const model = new ResponsesApiModel({ accessToken: 'test', model: 'test', fetchImpl: async () => new Response(stream) });
    const result: ModelEvent[] = [];
    for await (const ev of model.stream({ messages: [], tools: [] }, new AbortController().signal)) result.push(ev);
    assert.deepEqual(result[0], { type: 'text-delta', text: 'partial' });
    assert.equal(result.at(-1)?.type, 'finish');
    assert.equal((result.at(-1) as { stopReason: string }).stopReason, 'error');
  });
}

test('Responses accepts CRLF completion and rejects malformed tool arguments', async () => {
  for (const badArgs of [false, true]) {
    const payload = badArgs
      ? { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'x', name: 'effect', arguments: '{bad' } }
      : { type: 'response.output_text.delta', delta: 'done' };
    const stream = [payload, { type: 'response.completed' }].map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
    const model = new ResponsesApiModel({ accessToken: 'test', model: 'test', fetchImpl: async () => new Response(stream) });
    const result: ModelEvent[] = [];
    for await (const ev of model.stream({ messages: [], tools: [] }, new AbortController().signal)) result.push(ev);
    assert.equal((result.at(-1) as { stopReason: string }).stopReason, badArgs ? 'error' : 'stop');
    assert.equal(result.some(e => e.type === 'tool-call'), false);
    if (!badArgs) assert.deepEqual(result[0], { type: 'text-delta', text: 'done' });
  }
});

for (const finish of [null, 'length', 'tool_calls']) {
  test(`AI SDK does not turn ${finish ?? 'missing finish'} into completion`, async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'test',
        choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const model = resolveModel({ provider: 'compatible', model: 'test', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
      const result: ModelEvent[] = [];
      for await (const ev of model.stream({ messages: [{ role: 'user', content: 'hello' }], tools: [] }, new AbortController().signal)) result.push(ev);
      assert.equal((result.at(-1) as { stopReason: string }).stopReason, finish === 'length' ? 'length' : 'error');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test('Responses reports progress while the next tool call is still incomplete', async () => {
  const events = [
    { type: 'response.created' },
    { type: 'response.output_item.added', item: { type: 'reasoning' } },
    { type: 'response.output_item.added', item: { type: 'function_call', name: 'write_file' } },
  ];
  const stream = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  const model = new ResponsesApiModel({ accessToken: 'test', model: 'test', fetchImpl: async () => new Response(stream) });
  const result: ModelEvent[] = [];
  for await (const ev of model.stream({ messages: [], tools: [] }, new AbortController().signal)) result.push(ev);
  assert.deepEqual(result.slice(0, -1), [
    { type: 'activity', stage: 'accepted' },
    { type: 'activity', stage: 'reasoning' },
    { type: 'activity', stage: 'tool-input', toolName: 'write_file' },
  ]);
  assert.equal(result.at(-1)?.type, 'finish');
});

test('Ollama query rejection after tool results returns a report without rerunning tools', async t => {
  const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (requests.length === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no user query found in messages', type: 'api_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'c', model: 'test', created: 1,
      choices: [{ index: 0, delta: { content: 'Read failed. The task is incomplete.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const model = resolveModel({ provider: 'ollama', model: 'test', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
  const events: ModelEvent[] = [];
  for await (const ev of model.stream({
    messages: [{ role: 'user', content: 'Read the document' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', args: {} }] },
      { role: 'tool', results: [{ callId: 'c1', name: 'read', status: 'error', output: 'file missing' }] }],
    tools: [{ name: 'read', description: 'read a document', parameters: { type: 'object' } }],
  }, new AbortController().signal)) events.push(ev);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.slice(0, -1), requests[0].messages);
  assert.equal(requests[1].messages.at(-1)?.role, 'user');
  assert.equal(requests[1].tools?.length ?? 0, 0);
  assert.ok(events.some(e => e.type === 'finish' && e.errorMessage?.includes('Read failed')));
  assert.equal(events.some(e => e.type === 'tool-call'), false);
  assert.equal((events.at(-1) as { stopReason: string }).stopReason, 'error');
});
