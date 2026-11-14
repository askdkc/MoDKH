import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AiSdkModel } from '../src/model/ai-sdk.ts';
import type { ModelEvent } from '../src/agent/types.ts';
import { SessionStore } from '../src/session/store.ts';

for (const cancelled of [false, true]) {
  test(`reasoning-only stream reports activity and ends on ${cancelled ? 'user Stop' : 'deadline'} without replay`, async () => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      req.resume(); requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: { reasoning_content: 'PRIVATE_REASONING_FIXTURE' }, finish_reason: null }] })}\n\n`);
      // Deliberately no completion or subsequent chunk.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const model = new AiSdkModel({ id: 'fixture', languageModel: createOpenAICompatible({ name: 'fixture', baseURL })('fixture'), timeoutMs: cancelled ? 5000 : 1000 });
    const events: ModelEvent[] = [];
    const ac = new AbortController();
    const stop = setTimeout(() => ac.abort(), 6000);
    try {
      for await (const event of model.stream({ messages: [{ role: 'user', content: 'work' }], tools: [] }, ac.signal)) {
        events.push(event);
        if (cancelled && event.type === 'activity') ac.abort();
      }
      assert.ok(events.some(e => e.type === 'activity' && e.stage === 'reasoning'));
      // Reasoning is displayed, so it travels as its own event. It must never be merged into the
      // answer text, because that text is persisted and sent back to the provider.
      const answer = events.filter(e => e.type === 'text-delta').map(e => e.type === 'text-delta' ? e.text : '').join('');
      assert.doesNotMatch(answer, /PRIVATE_REASONING_FIXTURE/);
      const shown = events.filter(e => e.type === 'reasoning-delta').map(e => e.type === 'reasoning-delta' ? e.text : '').join('');
      assert.match(shown, /PRIVATE_REASONING_FIXTURE/, 'reasoning reaches the display hook');
      const finish = events.at(-1);
      assert.equal(finish?.type, 'finish');
      if (finish?.type === 'finish') {
        assert.equal(finish.stopReason, cancelled ? 'aborted' : 'error');
        if (!cancelled) assert.match(finish.errorMessage ?? '', /時間|タイムアウト/);
      }
      assert.equal(requests, 1);
    } finally { clearTimeout(stop); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
}

test('failure diagnostics survive restart, bounded and separate from conversation evidence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-diagnostic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(dir), session = store.create(dir, 'fixture');
  session.append({ role: 'user', content: 'implement it' });
  session.setStatus('error', 'CONTEXT_TOO_LARGE ' + 'x'.repeat(10000));
  const loaded = store.load(session.id);
  assert.equal(loaded.status, 'error');
  assert.match(loaded.lastError ?? '', /CONTEXT_TOO_LARGE/);
  assert.ok((loaded.lastError?.length ?? Infinity) <= 2048);
  assert.deepEqual(loaded.messages, [{ role: 'user', content: 'implement it' }]);
});
