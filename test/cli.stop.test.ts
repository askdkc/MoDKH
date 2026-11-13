import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const entry = process.env['DKH_TEST_CHAT'] ?? new URL('../src/cli/chat.ts', import.meta.url).href;

test('CLI approval Stop preserves the next instruction through the real model adapter', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-cli-stop-'));
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: object, finishReason: string | null) => {
        res.write(`data: ${JSON.stringify({
          id: 'stop-test', object: 'chat.completion.chunk', created: 1700000000, model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
      };
      if (requests.length === 1) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'command-1', type: 'function',
          function: { name: 'run_command', arguments: JSON.stringify({ command: 'touch command-started' }) },
        }] }, null);
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: 'NEXT_INSTRUCTION_RECEIVED' }, null);
        send({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const args = { model: 'compatible/fake', 'base-url': baseUrl, cwd: home };
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { runChat } from ${JSON.stringify(entry)}; await runChat({args:${JSON.stringify(args)}});`],
    { env: { ...process.env, DKH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let stopped = false, continued = false;
    const exited = new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!stopped && stdout.includes('--- 承認要求(command) ---')) {
        stopped = true;
        child.kill('SIGINT');
      }
      if (!continued && stdout.includes('(中断しました。')) {
        continued = true;
        child.stdin.end('AFTER_STOP\n/exit\n');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      child.stdin.write('FIRST_INSTRUCTION\n');
      assert.equal(await exited, 0, stderr || stdout);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    assert.equal(stopped, true, stdout);
    assert.equal(continued, true, stdout);
    assert.equal(requests.length, 2, stdout);
    const secondUsers = requests[1].messages.filter((message) => message.role === 'user');
    assert.equal(secondUsers[secondUsers.length - 1]?.content, 'AFTER_STOP');
    assert.match(stdout, /NEXT_INSTRUCTION_RECEIVED/);
    assert.equal(fs.existsSync(path.join(home, 'command-started')), false);
    const sessionFile = fs.readdirSync(path.join(home, 'sessions')).find((name) => name.endsWith('.jsonl'));
    assert.ok(sessionFile);
    const events = fs.readFileSync(path.join(home, 'sessions', sessionFile), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.message?.role === 'user' && event.message.content === 'AFTER_STOP').length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
