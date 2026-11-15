import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

/**
 * The point of the tool contract: the agent runs a check, reads the exit code, and keeps working
 * when the check fails. Previously a nonzero exit arrived as a tool error, so a failing check
 * looked like the harness breaking rather than a signal to fix the code.
 */
test('the agent reads a failing check as a result and repairs the code', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-shell-flow-'));
  const root = path.join(home, 'project');
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'value.txt'), 'BROKEN\n');
  fs.writeFileSync(path.join(root, 'check.sh'), 'grep -qx OK value.txt\n');
  const steps = [
    // 1. Run the check. It exits 1.
    [{ id: 'check', name: 'run_command', args: { command: 'sh check.sh' } }],
    // 2. Read the failing file.
    [{ id: 'read', name: 'read_file', args: { path: 'value.txt' } }],
    // 3. Fix it.
    [{ id: 'edit', name: 'edit_file', args: { path: 'value.txt', old_string: 'BROKEN', new_string: 'OK' } }],
    // 4. Re-run the same check. It now exits 0.
    [{ id: 'recheck', name: 'run_command', args: { command: 'sh check.sh' } }],
  ];
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const calls = steps[requests.length - 1] ?? [];
      const delta = calls.length
        ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
        : { content: 'check repaired' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', root, '--model', 'compatible/fixture',
    '--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', data => { output += data; });
  child.stderr!.on('data', data => { output += data; });
  const code = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  child.stdin!.end('check.sh を通して\n/exit\n');
  try {
    assert.equal(await code, 0, output);
    const toolResults = requests.at(-1)!.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content) as { status: string; output: string });
    // The failing check is `ok` status with exit code 1 — a result, not a harness error.
    const first = toolResults[0];
    assert.equal(first.status, 'ok', `failing check must be a result: ${JSON.stringify(first)}`);
    assert.match(first.output, /\[exit code: 1\]/);
    // The fix landed and the re-check now passes.
    assert.equal(fs.readFileSync(path.join(root, 'value.txt'), 'utf8'), 'OK\n');
    const last = toolResults.at(-1)!;
    assert.match(last.output, /\[exit code: 0\]/);
    // The whole loop completed within one turn.
    assert.match(output, /check repaired/);
    assert.doesNotMatch(output, /打ち切り/);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
