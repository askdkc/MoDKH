import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const entry = process.env['MODKH_TEST_ENTRY'] ?? fileURLToPath(new URL('../src/index.ts', import.meta.url));
const serverSource = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const name = m.params.name || m.method;
  fs.appendFileSync(process.env.MODKH_MEMORY_LOG, JSON.stringify({name, args:m.params.arguments}) + '\n');
  const send = (result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result}) + '\n');
  if (m.method === 'initialize') return send({serverInfo:{name:'cli-memory-test'}});
  if (name === 'memory_policy') return send({content:[{type:'text',text:JSON.stringify({global:{read:true,write:false},projects:[]})}]});
  if (name === 'memory_recall') {
    if (process.env.MODKH_MEMORY_MODE === 'error') return send({isError:true,content:[{type:'text',text:'optional backend unavailable'}]});
    if (process.env.MODKH_MEMORY_MODE === 'hang') return;
    return send({content:[{type:'text',text:'REFERENCE_FOR_' + m.params.arguments.query}]});
  }
  send({isError:true,content:[{type:'text',text:'unexpected call'}]});
});
`;

interface WireMessage { role: string; content: string }
interface SessionEvent { type: string; message?: WireMessage; [key: string]: unknown }

async function chatWithMemory(mode: string, inputs: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cli-memory-'));
  const requests: { messages: WireMessage[] }[] = [];
  const backend = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        { index: 0, delta: { role: 'assistant', content: '主作業の応答です' }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) {
        res.write(`data: ${JSON.stringify({ id: 'memory-test', object: 'chat.completion.chunk',
          created: 1700000000, model: 'fake', choices: [choice] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ memory: {
      enabled: true, command: process.execPath, args: ['-e', serverSource],
    } }));
    const child = spawn(process.execPath, [entry, 'chat', '--cwd', home,
      '--model', 'compatible/fake', '--base-url', `http://127.0.0.1:${(backend.address() as AddressInfo).port}/v1`],
    { env: { ...process.env, MODKH_HOME: home, MODKH_MEMORY_MODE: mode,
      MODKH_MEMORY_LOG: path.join(home, 'memory.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdin.end([...inputs, '/exit', ''].join('\n'));
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
    } finally { clearTimeout(timeout); }
    assert.equal(code, 0, stderr || stdout);
    const sessionFiles = fs.readdirSync(path.join(home, 'sessions')).filter((name) => name.endsWith('.jsonl'));
    assert.equal(sessionFiles.length, 1);
    const events = fs.readFileSync(path.join(home, 'sessions', sessionFiles[0]), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as SessionEvent);
    const calls = fs.readFileSync(path.join(home, 'memory.jsonl'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { name: string; args?: { query?: string } });
    return { stdout, requests, events, calls };
  } finally {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('CLIの記憶検索結果はモデル入力に届き、過去の参考データを履歴へ積み増さない', async () => {
  const { requests, events, calls } = await chatWithMemory('ok', ['first-task', 'second-task']);
  assert.deepEqual(calls.filter((c) => c.name === 'memory_recall').map((c) => c.args?.query),
    ['first-task', 'second-task']);
  assert.equal(requests.length, 2);
  // Recalled data rides on the newest input, not on the system prompt: a changed system suffix
  // would invalidate the provider's cached prefix for the whole transcript.
  const firstSystem = requests[0].messages.find((m) => m.role === 'system')?.content ?? '';
  const secondSystem = requests[1].messages.find((m) => m.role === 'system')?.content ?? '';
  assert.doesNotMatch(firstSystem, /REFERENCE_FOR_/);
  assert.equal(secondSystem, firstSystem, 'the policy prefix is byte-identical across turns');
  const lastUser = (body: { messages: WireMessage[] }) => [...body.messages].reverse().find((m) => m.role === 'user');
  assert.match(lastUser(requests[0])?.content ?? '', /REFERENCE_FOR_first-task/);
  assert.match(lastUser(requests[1])?.content ?? '', /REFERENCE_FOR_second-task/);
  assert.doesNotMatch(lastUser(requests[1])?.content ?? '', /REFERENCE_FOR_first-task/);
  assert.ok(requests[1].messages.some((m) => m.role === 'user' && m.content === 'first-task'));
  assert.ok(requests[1].messages.some((m) => m.role === 'user' && m.content.startsWith('second-task\n\n')));
  const messages = events.filter((event) => event.type === 'message').map((event) => event.message);
  assert.doesNotMatch(JSON.stringify(messages), /REFERENCE_FOR_/);
  const memory = events.filter((event) => event.type === 'memory');
  const retrieved = memory.filter((event) => event.stage === 'retrieved');
  assert.deepEqual(retrieved.map((event) => event.content),
    ['REFERENCE_FOR_first-task', 'REFERENCE_FOR_second-task']);
  for (const event of retrieved) {
    assert.equal(typeof event.elapsedMs, 'number');
    assert.equal(typeof event.at, 'string');
  }
  const supplied = memory.filter((event) => event.stage === 'supplied');
  assert.equal(supplied.length, 2);
  assert.ok(supplied.every((event) => event.content === undefined));
  assert.equal(memory.some((event) => event.stage === 'applied'), false);
});

for (const mode of ['error', 'hang']) {
  test(`メモリ${mode}でも実CLIから主作業のモデル応答に到達する`, async () => {
    const { stdout, requests, calls, events } = await chatWithMemory(mode, ['continue-task']);
    assert.equal(requests.length, 1);
    assert.match(stdout, /主作業の応答です/);
    assert.equal(calls.filter((c) => c.name === 'memory_recall').length, 1);
    assert.doesNotMatch(JSON.stringify(requests), /REFERENCE_FOR_/);
    const memory = events.filter((event) => event.type === 'memory');
    assert.equal(memory.filter((event) => event.stage === 'unavailable').length, 1);
    assert.equal(memory.filter((event) => event.stage === 'supplied').length, 0);
  });
}
