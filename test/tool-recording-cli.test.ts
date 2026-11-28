import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

async function trial(record: boolean, maxTurns: number, mode: 'normal' | 'broken' | 'replay' | 'crash' = 'normal') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-tool-record-'));
  const log = path.join(root, 'states.jsonl');
  let posts = 0;
  const crash = mode === 'crash';
  const command = crash ? 'printf x >> marker; sleep 3' : 'printf x >> marker';
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain the POST */ }
    posts++;
    const toolRequested = posts === 1 || (crash && posts === 2);
    const delta = toolRequested ? { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
      function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] } : { content: 'FIXTURE_DONE' };
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: toolRequested ? 'tool_calls' : 'stop' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
  });
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ maxTurns, permissions: 'none', language: { autoInstall: false } }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const env = { ...process.env, MODKH_AGENTICREPLAY: mode === 'replay' ? '1' : '0', MODKH_HOME: root, MODKH_PLAIN: '1',
      MODKH_TOOL_RECORD_FILE: record ? (mode === 'broken' ? root : log) : '' };
    let output = '';
    async function launch(resume?: string) {
      const child = spawn(process.execPath, [entry, 'chat', '--cwd', root, '--model', 'compatible/fixture',
        '--base-url', 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1',
        ...(resume ? ['--resume', resume] : [])], { env, stdio: 'pipe' });
      child.stdout.on('data', b => { output += b; });
      child.stderr.on('data', b => { output += b; });
      const closed = once(child, 'close');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 60000);
      let killedAfterStart = false;
      const watch = crash && !resume ? setInterval(() => {
        if (!killedAfterStart && fs.existsSync(path.join(root, 'marker'))) killedAfterStart = child.kill('SIGKILL');
      }, 10) : undefined;
      child.stdin.end(resume ? 'Continue the fixture.\n/exit\n' : 'Run the fixture.\ny\n/exit\n');
      try {
        const [code, signal] = await closed;
        if (crash && !resume) {
          assert.ok(killedAfterStart, output);
          assert.equal(signal, 'SIGKILL');
        } else assert.equal(code, 0, output);
      } finally { clearTimeout(deadline); clearInterval(watch); }
    }
    await launch();
    if (crash) {
      const [session] = fs.readdirSync(path.join(root, 'sessions')).filter(name => name.endsWith('.jsonl'));
      assert.ok(session);
      await launch(session.slice(0, -6));
    }
    const raw = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(raw, /printf|marker|FIXTURE_DONE|exit code|fixture\./);
    const events = [];
    if (mode === 'replay') {
      const runs = path.join(root, '.agenticreplay', 'runs');
      const dirs = fs.readdirSync(runs);
      assert.equal(dirs.length, 1);
      const run = path.join(runs, dirs[0]);
      const manifest = JSON.parse(fs.readFileSync(path.join(run, 'manifest.json'), 'utf8'));
      for (const segment of manifest.integrity.segments ?? [{ name: 'events.jsonl' }]) {
        const lines = fs.readFileSync(path.join(run, segment.name), 'utf8').trim().split('\n');
        events.push(...lines.map(line => JSON.parse(line)));
      }
    }
    return { events, behavior: { posts, approvals: output.split('承認要求(command)').length - 1,
      marker: fs.readFileSync(path.join(root, 'marker'), 'utf8'), done: output.includes('FIXTURE_DONE') },
      rows: raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), output };
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('command completion is recorded before any subsequent model POST', async () => {
  const { behavior, rows } = await trial(true, 1);
  assert.deepEqual(behavior, { posts: 1, approvals: 1, marker: 'x', done: false });
  assert.equal(rows.filter(row => row.state === 'completed').length, 1);
});

test('CLI approval, marker, model POSTs and answer survive disabled or failed recording', async () => {
  const baseline = await trial(false, 2);
  assert.deepEqual(baseline.behavior, { posts: 2, approvals: 1, marker: 'x', done: true });
  assert.equal(baseline.rows.length, 0);
  const enabled = await trial(true, 2);
  assert.deepEqual(enabled.behavior, baseline.behavior);
  assert.equal(enabled.rows.filter(r => r.state === 'completed').length, 1);
  const broken = await trial(true, 2, 'broken');
  assert.deepEqual(broken.behavior, baseline.behavior);
  assert.match(broken.output, /TOOL_RECORD_WRITE_FAILED/);
});

test('a killed CLI leaves the started command unknown and resume never repeats it', async () => {
  const { behavior, rows } = await trial(true, 2, 'crash');
  assert.equal(behavior.approvals, 1);
  assert.equal(behavior.marker, 'x');
  assert.equal(rows.filter(row => row.reason === 'command_started').length, 1);
  const original = rows[0].attempt;
  assert.equal(rows.filter(row => row.attempt === original).at(-1)?.state, 'unknown');
  assert.ok(rows.some(row => row.attempt !== original && ['prior_unknown', 'saved_result'].includes(row.reason)));
});

test('real AgenticReplay merges the receipt with proxy evidence and records it without another POST', {
  skip: process.env.MODKH_TEST_TOOL_RECORD_AR !== '1',
}, async () => {
  for (const posts of [1, 2]) {
    const { behavior, events, output } = await trial(true, posts, 'replay');
    assert.equal(behavior.posts, posts, output);
    assert.equal(behavior.marker, 'x');
    const calls = events.filter(e => e.type === 'tool.call');
    const results = events.filter(e => e.type === 'tool.result');
    assert.equal(calls.length, 1, output);
    assert.equal(results.length, 1, output);
    assert.deepEqual(results[0].causes, [calls[0].seq]);
    const completed = events.filter(e => e.attrs?.reason === 'command_exited');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].attrs.state, 'completed');
    if (posts === 2) assert.deepEqual(completed[0].causes, [results[0].seq]);
  }
});
