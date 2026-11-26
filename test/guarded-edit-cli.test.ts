import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
const modes = ['sequential', 'plain-batch', 'guarded-batch', 'enabled-sequential'] as const;
type Mode = typeof modes[number];
type Message = { role: string; content: string };
type Result = { status: string; output: string };

async function trial(mode: Mode, exercise: number, shouldEdit: boolean, shouldPass = true) {
  const serial = mode === 'sequential' || mode === 'enabled-sequential';
  const enabled = mode === 'guarded-batch' || mode === 'enabled-sequential';
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-guard-cli-')));
  const root = path.join(home, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ language: { autoInstall: false }, memory: { enabled: false } }));
  const old = JSON.stringify({ exercise, enabled: false });
  const next = JSON.stringify({ exercise, enabled: true });
  fs.writeFileSync(path.join(root, 'settings.json'), old);
  fs.writeFileSync(path.join(root, 'check.mjs'), [
    'import { readFileSync, appendFileSync } from "node:fs";',
    'import assert from "node:assert/strict";',
    'appendFileSync("check-ran", "started\\n");',
    `assert.equal(JSON.parse(readFileSync("settings.json", "utf8")).enabled, ${shouldPass});`,
    'console.log("VERIFIED_FIXTURE");',
  ].join('\n'));
  const observed: { bytes: number; messages: Message[]; guard: boolean }[] = [];
  const edit = { id: 'edit-1', name: 'edit_file', args: { path: 'settings.json', old_string: shouldEdit ? old : 'not present', new_string: next } };
  const check = { id: 'check-1', name: 'run_command', args: { command: 'node check.mjs',
    ...(mode === 'guarded-batch' ? { if_edit_succeeds: true } : {}) } };
  const results = (messages: Message[]): Result[] => messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', b => { raw += b; });
    req.on('end', () => {
      const b = JSON.parse(raw);
      observed.push({ bytes: Buffer.byteLength(raw), messages: b.messages,
        guard: Boolean(b.tools?.find((t: { function: { name: string } }) => t.function.name === 'run_command')?.function.parameters.properties.if_edit_succeeds) });
      const step = observed.length;
      const last = results(b.messages).at(-1);
      const calls = step === 1 ? serial ? [edit] : [edit, check]
        : step === 2 && serial && last?.status === 'ok' ? [check] : [];
      const verified = last?.output.includes('VERIFIED_FIXTURE') && last.output.includes('exit code: 0');
      const delta = calls.length ? { tool_calls: calls.map((c, index) => ({
        index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
      })) } : { content: verified ? 'BENCH_VERIFIED' : 'BENCH_NOT_VERIFIED' };
      const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1',
    MODKH_EXPERIMENT_GUARDED_EDIT_CHECK: enabled ? '1' : '0' };
  delete env.NODE_TEST_CONTEXT;
  const t0 = performance.now();
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', root, '--model', 'compatible/fixture',
    '--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`], { env, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  child.stdin.end('Enable the setting and run the existing check.\n/exit\n');
  try {
    assert.equal(await exit, 0, output);
    return { requests: observed.length, bytes: observed.reduce((total, item) => total + item.bytes, 0),
      elapsedMs: Math.round(performance.now() - t0), output, updated: fs.readFileSync(path.join(root, 'settings.json'), 'utf8') === next,
      starts: fs.existsSync(path.join(root, 'check-ran')) ? fs.readFileSync(path.join(root, 'check-ran'), 'utf8').trim().split('\n').length : 0,
      guardInSchema: observed[0]?.guard, results: results(observed.at(-1)?.messages ?? []) };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('paired CLI benchmark: sequential vs plain batch vs guarded batch', async t => {
  const samples = [];
  for (let i = 0; i < 4; i++) {
    const rotation = i % modes.length;
    for (const mode of [...modes.slice(rotation), ...modes.slice(0, rotation)]) {
      for (const shouldEdit of [true, false]) {
        const r = await trial(mode, i, shouldEdit);
        assert.equal(r.guardInSchema, mode === 'guarded-batch' || mode === 'enabled-sequential');
        assert.equal(r.updated, shouldEdit);
        assert.equal(r.requests, (mode === 'sequential' || mode === 'enabled-sequential') && shouldEdit ? 3 : 2);
        assert.equal(r.starts, shouldEdit || mode === 'plain-batch' ? 1 : 0, JSON.stringify(r));
        assert.equal(/\bBENCH_VERIFIED\b/.test(r.output), shouldEdit, JSON.stringify(r));
        if (!shouldEdit && mode === 'guarded-batch') assert.equal(r.results.at(-1)?.status, 'not-executed');
        samples.push({ mode, shouldEdit, requests: r.requests, starts: r.starts, bytes: r.bytes, elapsedMs: r.elapsedMs });
      }
    }
  }
  t.diagnostic(JSON.stringify(samples));
});

test('CLI keeps a failed verification as a failed command, not a passed test', async () => {
  const r = await trial('guarded-batch', 1, true, false);
  assert.equal(r.starts, 1, JSON.stringify(r));
  assert.equal(r.updated, true);
  assert.match(r.output, /BENCH_NOT_VERIFIED/);
  assert.match(r.results.at(-1)?.output ?? '', /exit code: 1/);
});
