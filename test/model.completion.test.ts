import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ResponsesApiModel, toResponsesInput } from '../src/model/chatgpt/responses.ts';
import { resolveModel } from '../src/model/factory.ts';
import type { ModelEvent, ModelRequest } from '../src/agent/types.ts';

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

const multimodalRejection = 'Multimodal data provided, but model does not support multimodal requests.';
for (const { name, message, status, attachment, recover } of [
  { name: 'unsupported screenshot', message: multimodalRejection, status: 400, recover: true },
  { name: 'unsupported image input (422)', message: 'Image input is not supported by this model.', status: 422, recover: true },
  { name: 'explicit user image', message: multimodalRejection, status: 400, attachment: 'image' },
  { name: 'explicit user PDF', message: multimodalRejection, status: 400, attachment: 'pdf' },
  { name: 'image size restriction', message: 'This engine does not read images larger than 512 pixels.', status: 400 },
  { name: 'invalid image bytes', message: 'Invalid image data.', status: 400 },
  { name: 'unrelated request error', message: 'Unrecognized tool call ID.', status: 400 },
  { name: 'rate limit', message: multimodalRejection, status: 429 },
]) test(`tool image rejection preserves tool receipts: ${name}`, async t => {
  const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==' };
  const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    if (JSON.stringify(body.messages).includes('image_url')) return Response.json({ error: {
      message, type: 'invalid_request_error',
    } }, { status });
    const chunk = { id: 'x', model: 'test', created: 1, choices: [{ index: 0, delta: { content: 'fixture response' }, finish_reason: 'stop' }] };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const model = resolveModel({ provider: 'ollama', model: 'test' });
  const results = [{ callId: 'a', name: 'browse', status: 'ok' as const, output: 'shot.png', image },
    { callId: 'b', name: 'run_command', status: 'ok' as const, output: 'fixture status 200' }];
  const events: ModelEvent[] = [];
  const request: ModelRequest = {
    messages: [{ role: 'user', content: 'Check the fixture', ...(attachment === 'image' ? { images: [image] } : {}),
      ...(attachment === 'pdf' ? { pdfs: [{ filename: 'fixture.pdf', data: Buffer.from('%PDF-1.4\n%%EOF').toString('base64') }] } : {}) },
      { role: 'assistant', content: '', toolCalls: results.map(r => ({ id: r.callId, name: r.name, args: {} })) },
      { role: 'tool', results }],
    tools: [{ name: 'browse', description: 'browse', parameters: { type: 'object' } }],
  };
  for await (const ev of model.stream(request, new AbortController().signal)) events.push(ev);
  assert.equal(requests.length, recover ? 2 : 1);
  assert.equal((events.at(-1) as { stopReason: string }).stopReason, recover ? 'stop' : 'error');
  if (recover) {
    assert.deepEqual(requests[1].messages.filter(m => m.role === 'tool'), requests[0].messages.filter(m => m.role === 'tool'));
    assert.ok(!JSON.stringify(requests[1].messages).includes(image.data));
    assert.equal(requests[1].tools?.length ?? 0, 0);
    assert.ok(events.some(e => e.type === 'text-delta' && e.text.includes('fixture response')));
    assert.equal(results[0].image, image);
    // A reloaded receipt has a new JS identity. Only reconnecting should try its pixels again.
    const reloaded = structuredClone(request);
    for await (const _ of model.stream(reloaded, new AbortController().signal)) { /* consume */ }
    assert.equal(requests.length, 3);
    assert.ok(!JSON.stringify(requests[2].messages).includes(image.data));
    const reconnected = resolveModel({ provider: 'ollama', model: 'test' });
    for await (const _ of reconnected.stream(reloaded, new AbortController().signal)) { /* consume */ }
    assert.ok(JSON.stringify(requests[3].messages).includes(image.data));
  } else {
    assert.ok(events.some(e => e.type === 'finish' && e.errorMessage === message));
  }
});
