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
 * The user-visible promise of promotion: a command that overruns its deadline keeps running and
 * its output is still reachable, instead of being killed with the words "limit exceeded".
 */
test('a command that overruns its deadline keeps running and reports back through a job', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-promote-cli-'));
  const root = path.join(home, 'project');
  fs.mkdirSync(root, { recursive: true });
  // Finishes well past the deadline the model asks for.
  fs.writeFileSync(path.join(root, 'slow.sh'), 'printf EARLY\nsleep 2\nprintf LATE\n');

  const requests: { messages: { role: string; content: string }[] }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const step = requests.length;
      const calls = step === 1
        // A 300ms deadline on a 2-second command.
        ? [{ id: 'fg', name: 'run_command', args: { command: 'sh slow.sh', timeoutMs: 300 } }]
        : step === 2
          ? [{ id: 'poll', name: 'job_output', args: { job_id: jobIdOf(body), wait: true, timeout_ms: 10000 } }]
          : [];
      const delta = calls.length
        ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
        : { content: step === 3 ? 'deadline reached, job kept' : 'PROMOTED_RESULT_SEEN' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  function jobIdOf(body: { messages: { role: string; content: string }[] }): string {
    const tool = body.messages.filter(m => m.role === 'tool').map(m => m.content).filter(c => c.includes('job_id')).at(-1);
    const id = tool === undefined ? undefined : /bash-[0-9a-f]{16}/.exec(tool)?.[0];
    assert.ok(id, `no job id: ${JSON.stringify(tool)}`);
    return id;
  }
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', root, '--model', 'compatible/fixture',
    '--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', data => { output += data; });
  child.stderr!.on('data', data => { output += data; });
  const code = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.stdin!.end('run the slow check\n/exit\n');
  try {
    assert.equal(await code, 0, output);
    const tools = requests.at(-1)!.messages.filter(m => m.role === 'tool').map(m => m.content);
    const whole = tools.join('\n');
    // The deadline did not kill the command: a job handle came back instead of an error.
    assert.match(whole, /\[job_id: bash-/, 'the model got a job handle');
    assert.match(whole, /バックグラウンドジョブへ移した/, 'promotion is explained');
    assert.doesNotMatch(whole, /制限時間\(300ms\)を超過した\(code=/, 'the old kill-on-deadline result is gone');
    // Work from both before and after the deadline arrived.
    assert.match(whole, /EARLY/, 'output from before the deadline survived');
    assert.match(whole, /LATE/, 'the command kept running to completion');
    assert.match(output, /deadline reached, job kept|PROMOTED_RESULT_SEEN/);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
