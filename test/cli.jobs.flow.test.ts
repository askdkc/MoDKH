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
 * The user-visible promise: a command that outlives any single call does not block the turn,
 * and its result still reaches the model — through the completion notice or job_output.
 */
test('a long command runs as a job, the turn continues, and the result reaches the model', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-jobs-cli-'));
  const root = path.join(home, 'project');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'slow.sh'), 'sleep 2\nprintf SLOW_JOB_FINISHED\n');

  const requests: { messages: { role: string; content: string }[] }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const step = requests.length;
      // 1: start the long job in the background. 2: read its output with a wait.
      // 3: answer. 4 (after the notice): acknowledge.
      const calls = step === 1
        ? [{ id: 'bg', name: 'run_command', args: { command: 'sh slow.sh', run_in_background: true, description: 'run slow check' } }]
        : step === 2
          ? [{ id: 'out', name: 'job_output', args: { job_id: jobIdOf(body), wait: true, timeout_ms: 10000 } }]
          : [];
      const delta = calls.length
        ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
        : { content: step === 3 ? 'job started' : 'JOB_RESULT_ACKNOWLEDGED' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  /** The only job id the model could have: the one from the start result. */
  function jobIdOf(body: { messages: { role: string; content: string }[] }): string {
    const tool = body.messages.filter(m => m.role === 'tool').map(m => m.content).find(c => c.includes('job_id'));
    const id = tool === undefined ? undefined : /bash-[0-9a-f]{16}/.exec(tool)?.[0];
    assert.ok(id, `no job id in ${JSON.stringify(tool)}`);
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
  const began = Date.now();
  child.stdin!.end('start a slow check\n/exit\n');
  try {
    assert.equal(await code, 0, output);
    const elapsed = Date.now() - began;
    // The turn finished; the job slept 2s. The job must not have blocked the answer.
    const firstAnswer = output.indexOf('job started');
    assert.ok(firstAnswer >= 0, output);

    const all = requests.at(-1)!.messages.filter(m => m.role === 'tool').map(m => m.content).join('\n');
    assert.match(all, /\[job_id: bash-/, 'the model received a job handle');
    assert.match(all, /SLOW_JOB_FINISHED/, 'the job output reached the model');
    assert.ok(elapsed >= 1900, `the job really ran for its duration: ${elapsed}ms`);
    assert.match(output, /JOB_RESULT_ACKNOWLEDGED|job started/);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
