import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveModel } from '../src/model/factory.ts';
import type { ModelEvent } from '../src/agent/types.ts';

// タイムアウトは「総時間」ではなく「無通信時間」で測る。受信が続く限り長い生成も止めない。
test('a streaming response that keeps producing survives longer than the timeout budget', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { content: `d${++sent}` }, finish_reason: null }] })}\n\n`);
      if (sent >= 6) {
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      }
    }, 120);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const model = resolveModel({ provider: 'compatible', model: 'm', baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'k', timeoutMs: 300 });
    const result: ModelEvent[] = [];
    for await (const ev of model.stream({ messages: [{ role: 'user', content: 'go' }], tools: [] }, new AbortController().signal)) result.push(ev);
    const finish = result.at(-1) as { stopReason: string; errorMessage?: string };
    assert.equal(finish.stopReason, 'stop', finish.errorMessage ?? '');
    assert.ok(result.some(e => e.type === 'text-delta'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('an unresponsive model reports an idle timeout instead of hanging forever', async () => {
  const server = http.createServer((_req, res) => {
    // must not write a readable byte for the test duration
    void res;
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const model = resolveModel({ provider: 'compatible', model: 'm', baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'k', timeoutMs: 200 });
    const events: ModelEvent[] = [];
    for await (const ev of model.stream({ messages: [{ role: 'user', content: 'go' }], tools: [] }, new AbortController().signal)) events.push(ev);
    const finish = events.at(-1) as { stopReason: string; errorMessage?: string };
    assert.equal(finish.stopReason, 'error');
    assert.match(finish.errorMessage ?? '', /制限時間/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
