import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

interface Run { output: string; systems: string[]; inputs: string[][]; code: number | null }

/** One chat turn against a stub model that answers without calling any tool. */
async function chat(home: string, input = 'ok'): Promise<Run> {
  const project = path.join(home, 'project');
  fs.mkdirSync(path.join(project, '.github', 'workflows'), { recursive: true });
  const systems: string[] = [];
  const inputs: string[][] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      inputs.push(body.messages.filter(message => message.role === 'user').map(message => message.content));
      systems.push(body.messages.find(message => message.role === 'system')?.content ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({
        id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta: { content: '意図を教えてください' }, finish_reason: 'stop' }],
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
  child.stdin.end(input + '\n/exit\n');
  try {
    const exitCode = await code;
    await new Promise<void>(resolve => setImmediate(resolve));
    return { output, systems, inputs, code: exitCode };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('CI の原因調査では作業ルートから失敗ログまで確認する指示がモデルに届く', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-clarify-'));
  try {
    const run = await chat(home, 'ci fails. why?');
    assert.equal(run.code, 0, run.output);
    assert.equal(run.systems.length, 1, run.output);
    assert.match(run.systems[0], /目的を特定できないときだけ、一度聞き返す/);
    assert.match(run.systems[0], /現在のGitリポジトリ・ブランチ・リモート/);
    assert.ok(run.systems[0].includes(JSON.stringify(path.join(home, 'project'))));
    assert.match(run.inputs[0].at(-1)!, /gh run view <id> --log-failed/);
    assert.match(run.systems[0], /失敗ジョブ、ログの最初の原因エラー/);
    assert.match(run.systems[0], /\[kiokuko-investigate\]/);
    assert.doesNotMatch(run.systems[0], /\[kiokuko-ui-design-soul\]/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('ツールを呼ばない応答は打ち切りではなく通常終了として扱う', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-clarify-stop-'));
  try {
    const run = await chat(home);
    assert.equal(run.code, 0, run.output);
    assert.deepEqual(run.inputs[0], ['ok']);
    assert.match(run.output, /意図を教えてください/);
    assert.match(run.output, /応答終了/);
    assert.doesNotMatch(run.output, /打ち切り/);
    assert.doesNotMatch(run.output, /▶ (list_files|read_file|search_files)/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
