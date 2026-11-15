import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentMessage, ModelEvent } from '../src/agent/types.ts';
import { searchFilesTool } from '../src/tools/files.ts';
import { resolveModel } from '../src/model/factory.ts';
import { utf8Prefix } from '../src/model/context.ts';
import { toResponsesInput } from '../src/model/chatgpt/responses.ts';

const context = (root: string) => ({ root, approval: { approve: async () => false } });
test('search honors gitignore and does not feed replay archives back to the model', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-source-search-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
  fs.writeFileSync(path.join(root, '.gitignore'), '.agenticreplay/\ncustom-generated/\n');
  fs.mkdirSync(path.join(root, '.agenticreplay'));
  fs.mkdirSync(path.join(root, 'custom-generated'));
  fs.writeFileSync(path.join(root, '.agenticreplay', 'archive.json'), `reasoning ${'ARCHIVE '.repeat(10000)}`);
  fs.writeFileSync(path.join(root, 'custom-generated', 'other.txt'), 'reasoning GENERATED');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'model.ts'), 'export const reasoning = "source";\n');
  const output = await searchFilesTool.execute({ pattern: 'reasoning' }, context(root));
  assert.equal(typeof output, 'string');
  assert.match(output as string, /src\/model.ts:1:/);
  assert.doesNotMatch(output as string, /ARCHIVE|GENERATED/);
  assert.ok(Buffer.byteLength(output as string) < 32 * 1024);
});

test('search bounds excerpts from giant single lines while keeping the actual match visible', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-long-line-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
  fs.writeFileSync(path.join(root, 'large.json'), 'x'.repeat(300000) + 'NEEDLE' + 'y'.repeat(300000));
  const output = await searchFilesTool.execute({ pattern: 'NEEDLE' }, context(root)) as string;
  assert.ok(Buffer.byteLength(output) < 32 * 1024);
  assert.match(output, /large.json:1:/);
  assert.match(output, /NEEDLE/);
  assert.match(output, /省略|一部/);
});

test('legacy huge tool results are bounded for both APIs without rewriting audit evidence or status', async () => {
  const output = 'private archive line\n'.repeat(200000);
  const messages: AgentMessage[] = [
    { role: 'user', content: 'Continue the implementation' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'old-search', name: 'search_files', args: { pattern: 'reasoning' } }] },
    { role: 'tool', results: [{ callId: 'old-search', name: 'search_files', status: 'unknown', output }] },
  ];
  let received = '';
  const server = http.createServer((req, res) => {
    req.on('data', data => { received += data; });
    req.on('end', () => {
      if (Buffer.byteLength(received) > 128 * 1024) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"CONTEXT_TOO_LARGE"}}'); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content: 'RESUMED' }, finish_reason: 'stop' }] };
      res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const model = resolveModel({ provider: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
    const events: ModelEvent[] = [];
    for await (const event of model.stream({ messages, tools: [] }, new AbortController().signal)) events.push(event);
    assert.ok(events.some(e => e.type === 'text-delta' && e.text === 'RESUMED'));
    const wire = JSON.parse(received).messages.find((m: { role: string }) => m.role === 'tool');
    const result = JSON.parse(wire.content);
    assert.equal(result.status, 'unknown');
    assert.match(result.output, /省略/);
    assert.ok(Buffer.byteLength(result.output) <= 16 * 1024);
    const response = toResponsesInput(messages);
    const item = response.find(item => item.type === 'function_call_output')!;
    assert.ok(Buffer.byteLength(item.output!) < 32 * 1024);
    assert.equal(JSON.parse(item.output!).status, 'unknown');
    assert.equal(messages[2].role === 'tool' && messages[2].results[0].output, output);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('context prefixes preserve UTF-8 and repeated receipt objects do not erase the newest result', () => {
  assert.equal(utf8Prefix('あ🙂ab', 0), '');
  assert.equal(utf8Prefix('あ🙂ab', 3), 'あ');
  assert.equal(utf8Prefix('あ🙂ab', 4), 'あ');
  assert.equal(utf8Prefix('あ🙂ab', 7), 'あ🙂');
  const shared = { callId: 'same', name: 'read_file', status: 'unknown' as const, output: 'SHARED_SENTINEL ' + 'x'.repeat(40000) };
  const messages: AgentMessage[] = Array.from({ length: 16 }, () => ({ role: 'tool', results: [shared] }));
  const wire = toResponsesInput(messages).map(item => JSON.parse(item.output!));
  assert.match(wire.at(-1).output, /SHARED_SENTINEL/);
  assert.doesNotMatch(wire[0].output, /SHARED_SENTINEL/);
  assert.ok(wire.every(item => item.status === 'unknown'));
  assert.ok(wire.reduce((sum, item) => sum + Buffer.byteLength(item.output), 0) < 140 * 1024);
  assert.equal(shared.output.length, 40016);
});
