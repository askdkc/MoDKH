import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

interface Run { output: string; requests: unknown[]; code: number | null }

/** One chat turn against a stub model that keeps calling a tool for `steps` responses. */
async function chat(home: string, config: object | null, limit: number): Promise<Run> {
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config ?? {}));
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push(raw);
      const call = requests.length <= limit
        ? { tool_calls: [{ index: 0, id: `c${requests.length}`, type: 'function', function: { name: 'list_files', arguments: '{}' } }] }
        : { content: 'FINISHED_AFTER_LONG_WORK' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({
        id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: call, finish_reason: requests.length <= limit ? 'tool_calls' : 'stop' }],
      })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', project, '--model', 'compatible/fixture',
    '--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.stdin.end('長い作業を続けて\n/exit\n');
  try {
    const exitCode = await code;
    await new Promise<void>(resolve => setImmediate(resolve));
    return { output, requests, code: exitCode };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('30 round trips complete under the default limit instead of being truncated', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-turns-'));
  try {
    const run = await chat(home, null, 30);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /FINISHED_AFTER_LONG_WORK/);
    assert.doesNotMatch(run.output, /打ち切り/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a configured maxTurns caps the turn and says the work can be continued', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-turns-cap-'));
  try {
    const run = await chat(home, { maxTurns: 3 }, 100);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /打ち切り: ツール往復が上限\(3回\)/);
    assert.match(run.output, /続きは同じセッションで指示/);
    assert.doesNotMatch(run.output, /FINISHED_AFTER_LONG_WORK/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an invalid maxTurns falls back to the default with a diagnostic', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-turns-bad-'));
  try {
    const run = await chat(home, { maxTurns: 'lots' }, 1);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /設定の maxTurns が不正なため 500 を使用します/);
    // The default still lets the work finish.
    assert.match(run.output, /FINISHED_AFTER_LONG_WORK/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
