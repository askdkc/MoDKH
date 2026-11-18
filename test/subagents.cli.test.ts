import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-orchestration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const env = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
  return { root, home, env };
}

test('/agents shows parent1+child2, validates limits and restores the saved limit', t => {
  const f = fixture(t);
  const run = (input: string) => {
    const result = spawnSync(process.execPath, [entry, '--cwd', f.root], { env: f.env, encoding: 'utf8', input, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const first = run('/agents\n/agents limit 4\n/agents limit 0\n/agents limit 17\n/agents limit 2.5\n/exit\n');
  assert.match(first, /親1 \+ 子2 = 最大3/);
  assert.match(first, /親1 \+ 子4 = 最大5/);
  assert.equal((first.match(/使い方: \/agents limit/g) ?? []).length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8')).subagentLimit, 4);
  assert.match(run('/agents\n/exit\n'), /親1 \+ 子4 = 最大5/);
});

test('CLI parent reads independently while two child API requests are live and integrates both durable results', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'parent.txt'), 'PARENT_INDEPENDENT_EVIDENCE');
  const children: { task: string; res: http.ServerResponse }[] = [];
  let parentStep = 0, active = 0, peak = 0, parentWorked = false;
  const parentRequests: string[] = [];
  const send = (res: http.ServerResponse, delta: object, calls = false) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  };
  const call = (id: string, name: string, args: object, index = 0) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const server = http.createServer(async (req, res) => {
    active++; peak = Math.max(peak, active);
    res.once('close', () => active--);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const task = body.messages.find((m: { role: string }) => m.role === 'user')?.content;
    if (task === 'Inspect left' || task === 'Inspect right') {
      children.push({ task, res });
      return;
    }
    parentRequests.push(JSON.stringify(body.messages));
    if (++parentStep === 1) {
      send(res, { tool_calls: [call('left', 'start_subagent', { pluginId: 'modkh-explorer', task: 'Inspect left' }),
        call('right', 'start_subagent', { pluginId: 'modkh-explorer', task: 'Inspect right' }, 1)] }, true);
    } else if (parentStep === 2) {
      send(res, { tool_calls: [call('own-work', 'read_file', { path: 'parent.txt' })] }, true);
    } else {
      // Hold the parent's fixture response until both independent child requests have arrived.
      for (let i = 0; children.length < 2 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
      parentWorked ||= children.length === 2 && children.every(child => !child.res.writableEnded)
        && JSON.stringify(body.messages).includes('PARENT_INDEPENDENT_EVIDENCE');
      for (const child of children) if (!child.res.writableEnded) send(child.res, { content: `${child.task} verified fixture result` });
      send(res, { content: 'Integrated available evidence' });
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const child = spawn(process.execPath, [entry, '--cwd', f.root, '--model', 'compatible/fixture', '--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', bytes => output += bytes);
  child.stderr.on('data', bytes => output += bytes);
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  child.stdin.end('Investigate both parts while checking parent.txt, then integrate the evidence.\n/exit\n');
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, output);
    assert.equal(children.length, 2, output);
    assert.equal(parentWorked, true, output);
    // The first request must guide tool selection even when spawn and parent reads share a batch.
    assert.match(parentRequests[0], /報告の根拠が不足/);
    assert.match(parentRequests[0], /境界値を実際の判定に入力し、結果を観測/);
    assert.match(parentRequests[0], /実測と報告が食い違ったら、該当する分岐の行だけ/);
    assert.equal(peak, 3, 'parent plus two children concurrently use the API');
    assert.ok(parentRequests.some(r => r.includes('Inspect left verified fixture result') && r.includes('Inspect right verified fixture result')), output);
    const logs = fs.readdirSync(path.join(f.home, 'sessions')).map(file => fs.readFileSync(path.join(f.home, 'sessions', file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    const parent = logs.find(events => !events[0].parentSessionId)!;
    assert.equal(parent.filter(e => e.type === 'delegation' && e.record.state === 'finished' && e.record.result.status === 'completed').length, 2);
    assert.equal(parent.filter(e => e.type === 'status').at(-1)?.status, 'complete');
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }
});
