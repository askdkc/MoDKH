import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SessionStore } from '../src/session/store.ts';

const entry = process.env['MODKH_TEST_ENTRY'] ?? new URL('../src/index.ts', import.meta.url).pathname;
function launch(home: string, cwd: string, args: string[], input: string) {
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', cwd, ...args], {
    env: { ...process.env, MODKH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.stdin.end(input);
  return new Promise<{ output: string; code: number | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ output, code }); });
  });
}

test('CLI error stays error after EOF and original user whitespace is retained', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cli-state-'));
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const finish = requests === 1 ? 'stop' : 'length';
    res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'test',
      choices: [{ index: 0, delta: { content: 'response' }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await launch(home, home, ['--model', 'compatible/test', '--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`], '  original request  \nsecond request\n/exit\n');
    assert.equal(result.code, 0, result.output);
    const store = new SessionStore(path.join(home, 'sessions'));
    const session = store.load(store.list()[0].id);
    assert.equal(session.status, 'error');
    assert.deepEqual(session.messages[0], { role: 'user', content: '  original request  ' });
    assert.equal(result.output.split('(応答終了)').length - 1, 1);
    assert.doesNotMatch(result.output, /回答できたよ！|依頼全体の検証結果/);
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI refuses to resume evidence in a different repository', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cli-root-'));
  try {
    const first = path.join(home, 'first');
    const other = path.join(home, 'other');
    fs.mkdirSync(first); fs.mkdirSync(other);
    const store = new SessionStore(path.join(home, 'sessions'));
    const session = store.create(first, 'fixed/scripted');
    session.append({ role: 'user', content: 'owned by first' });
    session.setStatus('interrupted');
    const result = await launch(home, other, ['--resume', session.id], '/exit\n');
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /作業ルート/);
    assert.equal(store.load(session.id).status, 'interrupted');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
