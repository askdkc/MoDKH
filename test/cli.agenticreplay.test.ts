import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { SessionStore } from '../src/session/store.ts';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

test('chat uses AgenticReplay when its version probe succeeds', { skip: process.platform === 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces');
  fs.mkdirSync(project);
  const calls = path.join(root, 'calls');
  const recorder = path.join(root, 'agenticreplay');
  fs.writeFileSync(recorder, `#!/bin/sh
printf '%s\\n' "$1" >> "$REPLAY_TEST_CALLS"
if [ "$1" = version ]; then
  printf '%s\\n' 0.1.25
  exit "$REPLAY_TEST_STATUS"
fi
printf '%s\\n' "$PWD" "$@" >> "$REPLAY_TEST_CALLS"
[ "$AGENTICREPLAY_CONTINUE_ON_STORAGE_LIMIT" = 1 ] || exit 19
while [ "$1" != -- ]; do shift; done
shift
AGENTICREPLAY_TLS_CA=active exec "$@"
`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
    MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '1', REPLAY_TEST_CALLS: calls };
  delete env.AGENTICREPLAY_TLS_CA;
  delete env.AGENTICREPLAY_PROXY_URL;
  const run = (status: string, args: string[], recording = '1', expectedStatus = 0) => {
    fs.rmSync(calls, { force: true });
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: root, env: { ...env, MODKH_AGENTICREPLAY: recording, REPLAY_TEST_STATUS: status },
      input: '/exit\n', encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    return fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
  };

  assert.deepEqual(run('0', ['--help']), []);
  const args = ['--cwd', path.basename(project), '--model', 'fixed/scripted'];
  assert.deepEqual(run('1', args), ['version']);
  const recorded = run('0', args);
  assert.deepEqual(recorded.slice(0, 6), ['version', 'record', fs.realpathSync(project), 'record', 'exec', '--tls-intercept']);
  assert.deepEqual(recorded.slice(-args.length), args);
  const sessions = new SessionStore(path.join(root, 'sessions')).list();
  assert.deepEqual(sessions.map(session => session.cwd), [fs.realpathSync(project), fs.realpathSync(project)]);
  assert.deepEqual(run('0', args, '0'), []);

  const profile = path.join(root, 'config.json');
  env.OLLAMA_API_KEY = 'fixture';
  delete env.OLLAMA_CLOUD_BASE_URL;
  const saved = { model: 'ollama/fixture', modelBaseUrl: 'https://saved.example:8443/v1' };
  const resume = new SessionStore(path.join(root, 'sessions')).create(project, 'compatible/resumed');
  resume.setConnection('compatible/resumed', 'https://resume.example/v1');
  const tlsArgs = (chatArgs: string[], modelBaseUrl = saved.modelBaseUrl) => {
    fs.writeFileSync(profile, JSON.stringify({ ...saved, modelBaseUrl }));
    const flags = run('0', ['--cwd', path.basename(project), ...chatArgs]);
    const index = flags.indexOf('--tls-hosts');
    return index === -1 ? [] : flags.slice(index, index + 2);
  };
  assert.deepEqual(tlsArgs([]), ['--tls-hosts', '+saved.example']);
  assert.deepEqual(tlsArgs(['--model', saved.model]), ['--tls-hosts', '+saved.example']);
  assert.deepEqual(tlsArgs(['--resume', resume.id]), ['--tls-hosts', '+resume.example']);
  assert.deepEqual(tlsArgs(['--resume', resume.id, '--base-url', 'https://explicit.example/v1']),
    ['--tls-hosts', '+explicit.example']);
  resume.setConnection(saved.model);
  assert.deepEqual(tlsArgs(['--resume', resume.id]), ['--tls-hosts', '+saved.example']);
  resume.setConnection('ollama/other');
  assert.deepEqual(tlsArgs(['--resume', resume.id]), []);
  assert.deepEqual(tlsArgs([], 'http://saved.example/v1'), []);
  assert.deepEqual(tlsArgs([], 'https://saved.example,+other.example/v1'), []);
  assert.deepEqual(tlsArgs([], 'https://*.saved.example/v1'), []);
  assert.deepEqual(tlsArgs(['--resume', resume.id, '--model', 'ollama-cloud/fixture']),
    ['--tls-hosts', '+ollama.com']);
  env.OLLAMA_CLOUD_BASE_URL = 'https://env.example/v1';
  assert.deepEqual(tlsArgs(['--model', 'ollama-cloud/fixture']), ['--tls-hosts', '+env.example']);
  assert.deepEqual(run('0', ['--resume', resume.id], '1', 1), ['version']);
});

test('a recording that falls short is reported without changing the conversation exit code', {
  skip: process.platform === 'win32', timeout: 30_000,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-replay-recording-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  // The fake recorder reports a run directory through the child's own CA path, exactly like the
  // real one, and the manifest decides the recording status. Only the conversation exit code is
  // the recorder's to report: capture completeness must stay a separate signal.
  const scenario = path.join(root, 'scenario.json');
  fs.writeFileSync(path.join(root, 'agenticreplay'), `#!/bin/sh
if [ "$1" = version ]; then echo 0.1.25; exit 0; fi
while [ "$1" != -- ]; do shift; done
shift
exec node "$REPLAY_DRIVER" "$@"
`, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'driver.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const scenario = JSON.parse(fs.readFileSync(process.env.REPLAY_SCENARIO, 'utf8'));
const runDir = path.join(process.env.REPLAY_ROOT, 'runs', '20260101000000-exec-session-' + scenario.runId);
if (scenario.writeManifest !== false) {
  fs.mkdirSync(path.join(runDir, 'tls'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ run_id: scenario.seal ? 'run_' + scenario.runId : scenario.runId, capture: scenario.capture }));
} else {
  // A previous call reused the same directory; only an absent manifest is the case under test.
  fs.rmSync(runDir, { recursive: true, force: true });
}
// Only the recorder's own child gets this path, which is how the run is correlated.
if (scenario.reportCa !== false) process.env.AGENTICREPLAY_TLS_CA = path.join(runDir, 'tls', 'ca.crt');
const child = require('node:child_process').spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
child.on('close', code => {
  if (scenario.seal) fs.renameSync(runDir, path.join(path.dirname(runDir), '20260101000000-exec-title-' + scenario.runId));
  process.exit(scenario.recorderExit ?? code ?? 0);
});
`);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
    MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '1',
    REPLAY_SCENARIO: scenario, REPLAY_ROOT: root, REPLAY_DRIVER: path.join(root, 'driver.cjs') };
  delete env.AGENTICREPLAY_TLS_CA;
  delete env.AGENTICREPLAY_PROXY_URL;

  const run = (capture: object, extra: { seal?: boolean; runId?: string; recorderExit?: number; writeManifest?: boolean; reportCa?: boolean } = {}) => {
    fs.writeFileSync(scenario, JSON.stringify({ runId: 'run_test0001', ...extra, capture }));
    const result = spawnSync(process.execPath, [entry, '--cwd', project, '--model', 'fixed/scripted'], {
      cwd: root, env, input: '/exit\n', encoding: 'utf8', timeout: 20_000,
    });
    assert.ifError(result.error);
    return result;
  };

  // Conversation completed and the recording is whole: nothing to say.
  const complete = run({ status: 'complete', issues: [], requests: 1, responses: 1 });
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  assert.doesNotMatch(complete.stderr, /記録:/);

  // Conversation completed but the recording has no model request (closed before the first one).
  const empty = run({ status: 'incomplete', issues: ['no_requests_observed'], requests: 0, responses: 0 });
  assert.equal(empty.status, 0, 'the conversation still succeeded');
  assert.match(empty.stderr, /記録: モデル要求を観測していません/);
  assert.match(empty.stderr, /run_test0001/, 'the report names this run, not the newest directory');
  assert.match(empty.stderr, /終了コードは変えていません/);
  assert.doesNotMatch(empty.stderr + empty.stdout, new RegExp(root), 'no absolute paths leak into the report');

  // Conversation completed, recording truncated mid-stream: still its own axis.
  const partial = run({ status: 'incomplete', issues: ['response_body_truncated'], requests: 2, responses: 1 });
  assert.equal(partial.status, 0);
  assert.match(partial.stderr, /記録: 不完全/);
  assert.match(partial.stderr, /要求2\/応答1/);

  const sealed = run({ status: 'incomplete', issues: ['diagnostic_storage_limit'], requests: 12, responses: 12 },
    { seal: true, runId: 'abcdef123456', recorderExit: 2 });
  assert.equal(sealed.status, 0);
  assert.match(sealed.stderr, /記録: 不完全.*diagnostic_storage_limit/);

  // A completed conversation whose recorder reported an error status keeps that exit code.
  const failed = run({ status: 'complete', issues: [] }, { recorderExit: 5 });
  assert.equal(failed.status, 5, 'the recorder failure is not hidden');
  assert.doesNotMatch(failed.stderr, /記録:/, 'a complete recording is quiet even then');

  // No manifest at all: the run cannot be verified, and the report says so instead of guessing.
  const unverified = run({ status: 'complete', issues: [] }, { writeManifest: false });
  assert.equal(unverified.status, 0);
  assert.match(unverified.stderr, /記録: 未検証/);
  assert.doesNotMatch(unverified.stderr, /run_test0001/, 'nothing was correlated, so no run is claimed');
});

test('recording stays quiet when it is turned off explicitly', {
  skip: process.platform === 'win32', timeout: 20_000,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-replay-off-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // An opt-out is not a recording failure. Nothing is launched and nothing is reported.
  const result = spawnSync(process.execPath, [entry, '--model', 'fixed/scripted'], {
    cwd: root, input: '/exit\n', encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr.trim(), '', 'explicitly disabled recording says nothing');
  assert.equal(fs.existsSync(path.join(root, '.agenticreplay')), false, 'no recording was started');
});

test('parallel recorded runs each report their own run', {
  skip: process.platform === 'win32', timeout: 40_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-replay-parallel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(root, 'driver.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const run = process.env.REPLAY_RUN;
const dir = path.join(process.env.REPLAY_ROOT, 'runs', '20260101000000-exec-session-' + run);
const child = require('node:child_process').spawn(process.argv[2], process.argv.slice(3), {
  stdio: 'inherit',
  // Only this recorder's own child sees the CA path, which is how the run is correlated.
  env: { ...process.env, AGENTICREPLAY_TLS_CA: path.join(dir, 'tls', 'ca.crt') },
});
// The manifest only appears once the child has finished, exactly when the recorder seals the run.
child.on('close', code => {
  fs.mkdirSync(path.join(dir, 'tls'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    run_id: run, capture: { status: 'incomplete', issues: ['no_requests_observed'], requests: 0, responses: 0 },
  }));
  process.exit(code ?? 0);
});
`);
  fs.writeFileSync(path.join(root, 'agenticreplay'), `#!/bin/sh
if [ "$1" = version ]; then echo 0.1.25; exit 0; fi
while [ "$1" != -- ]; do shift; done
shift
exec node "$REPLAY_DRIVER" "$@"
`, { mode: 0o700 });
  const runOne = (index: number) => new Promise<string>((resolve, reject) => {
    const run = `run_par0000${index}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
      MODKH_HOME: path.join(root, `home${index}`), MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '1',
      REPLAY_DRIVER: path.join(root, 'driver.cjs'), REPLAY_ROOT: root, REPLAY_RUN: run,
    };
    // The test runner itself may be inside another recorder; this run must start its own.
    delete env.AGENTICREPLAY_TLS_CA;
    delete env.AGENTICREPLAY_PROXY_URL;
    const child = spawn(process.execPath, [entry, '--model', 'fixed/scripted'], { cwd: root, env });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.end('/exit\n');
    child.once('error', reject);
    child.once('close', code => { assert.equal(code, 0, stderr); resolve(stderr); });
  });
  // Two runs in the same workspace at once: the report must name the run each one produced,
  // never whichever directory happens to be newest.
  const [first, second] = await Promise.all([runOne(1), runOne(2)]);
  assert.match(first, /run_par00001/);
  assert.doesNotMatch(first, /run_par00002/);
  assert.match(second, /run_par00002/);
  assert.doesNotMatch(second, /run_par00001/);
});

test('an interrupted conversation still reports its recording and keeps the interrupt', {
  skip: process.platform === 'win32', timeout: 30_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-replay-sigint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'driver.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(process.env.REPLAY_ROOT, 'runs', '20260101000000-exec-session-run_sig000001');
// The real recorder writes its run directory and manifest before the agent starts, so an
// interrupt still leaves the run identifiable.
fs.mkdirSync(path.join(dir, 'tls'), { recursive: true });
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  run_id: 'run_sig000001', capture: { status: 'incomplete', issues: ['no_requests_observed'], requests: 0, responses: 0 },
}));
const child = require('node:child_process').spawn(process.argv[2], process.argv.slice(3), {
  stdio: 'inherit', env: { ...process.env, AGENTICREPLAY_TLS_CA: path.join(dir, 'tls', 'ca.crt') },
});
child.on('close', () => {
  // The recorder collapses an incomplete recording to 2; the conversation was interrupted.
  process.exit(2);
});
`);
  fs.writeFileSync(path.join(root, 'agenticreplay'), `#!/bin/sh
if [ "$1" = version ]; then echo 0.1.25; exit 0; fi
while [ "$1" != -- ]; do shift; done
shift
exec node "$REPLAY_DRIVER" "$@"
`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
    MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '1',
    REPLAY_DRIVER: path.join(root, 'driver.cjs'), REPLAY_ROOT: root,
  };
  delete env.AGENTICREPLAY_TLS_CA;
  delete env.AGENTICREPLAY_PROXY_URL;
  const child = spawn(process.execPath, [entry, '--model', 'fixed/scripted'], { cwd: root, env });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  // Interrupt only once the recorded conversation is actually up, the way a human would.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`prompt did not appear: ${stderr}`)), 15_000);
    child.stdout.on('data', data => {
      if (!String(data).includes('入力してください')) return;
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill('SIGINT');
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
  });
  // The conversation was interrupted, so the run does not look like a success.
  assert.ok(code !== 0 || signal !== null, `an interrupted run must not report success: ${code}/${signal} ${stderr}`);
  // The recording is still described on its own axis, with the run it actually produced.
  assert.match(stderr, /記録: モデル要求を観測していません/);
  assert.match(stderr, /run_sig000001/);
});

test('a host outside the recorded set is named once, and the connection still works', {
  skip: process.platform === 'win32', timeout: 30_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-replay-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = 'run_scope00001';
  const dir = path.join(root, 'runs', `20260101000000-exec-session-${runId}`);
  fs.mkdirSync(path.join(dir, 'tls'), { recursive: true });
  // The recorder announces the hosts it decrypts as the first event of this run, before the
  // agent starts — that is what lets the child judge a later /connect without guessing.
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({
    seq: 1, type: 'note', actor: 'agenticreplay',
    attrs: { rule: 'tls_intercept', hosts: 'api.deepseek.com, *.chatgpt.com' },
  })}\n`);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    run_id: runId, capture: { status: 'incomplete', issues: ['unobserved_tunnel_body'], requests: 1, responses: 1 },
  }));
  fs.writeFileSync(path.join(root, 'driver.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const runDir = ${JSON.stringify(dir)};
const child = require('node:child_process').spawn(process.argv[2], process.argv.slice(3), {
  stdio: 'inherit', env: { ...process.env, AGENTICREPLAY_TLS_CA: path.join(runDir, 'tls', 'ca.crt') },
});
child.on('close', () => process.exit(2));
`);
  fs.writeFileSync(path.join(root, 'agenticreplay'), `#!/bin/sh
if [ "$1" = version ]; then echo 0.1.25; exit 0; fi
while [ "$1" != -- ]; do shift; done
shift
exec node "$REPLAY_DRIVER" "$@"
`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
    MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '1', REPLAY_DRIVER: path.join(root, 'driver.cjs'),
  };
  delete env.AGENTICREPLAY_TLS_CA;
  delete env.AGENTICREPLAY_PROXY_URL;
  const child = spawn(process.execPath, [entry, '--model', 'fixed/scripted'], { cwd: root, env });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  await new Promise<void>(resolve => setTimeout(resolve, 400));
  // Two switches: one to a host the run decrypts, one outside it.
  child.stdin.write('/connect compatible/inside --base-url https://api.deepseek.com/v1\n');
  child.stdin.write('/connect compatible/outside --base-url https://models.other.test/v1\n');
  child.stdin.end('/exit\n');
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  assert.match(output, /接続しました: compatible\/outside/, 'a host outside the set still connects');
  assert.equal((output.match(/記録対象外/g) ?? []).length, 1, `named once: ${output}`);
  assert.match(output, /models\.other\.test は記録対象外/);
  assert.doesNotMatch(output, /api\.deepseek\.com は記録対象外/, 'a decrypted host is not reported');
});

test('AgenticReplay records local HTTP model calls after switching providers', {
  skip: process.platform === 'win32', timeout: 30_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-replay-http-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realRecorder = process.env.MODKH_TEST_REAL_AGENTICREPLAY === '1';
  const received: string[] = [];
  const forwarded: string[] = [];
  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const model = (name: string) => serve((req, res) => {
    received.push(`${name} ${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({
        id: name, object: 'chat.completion.chunk', created: 1, model: name,
        choices: [{ index: 0, delta: { content: `answer from ${name}` }, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`);
    });
  });
  const ollama = await model('ollama');
  const other = await model('other');
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: root, MODKH_PLAIN: '1',
    MODKH_AGENTICREPLAY: '1', OLLAMA_BASE_URL: `${ollama}/v1` };
  delete env.AGENTICREPLAY_TLS_CA;
  delete env.AGENTICREPLAY_PROXY_URL;
  if (!realRecorder) {
    env.REPLAY_TEST_PROXY = await serve(async (req, res) => {
      const [, prefix, encodedOrigin, ...tail] = (req.url ?? '').split('/');
      const origin = decodeURIComponent(encodedOrigin ?? '');
      forwarded.push(`${origin}/${tail.join('/')}`);
      if (prefix !== 'forward' || ![ollama, other].includes(origin)) {
        res.writeHead(400).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const upstream = await fetch(`${origin}/${tail.join('/')}`, {
        method: req.method, headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks),
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? '' });
      res.end(await upstream.text());
    });
    env.PATH = `${root}${path.delimiter}${env.PATH ?? ''}`;
    fs.writeFileSync(path.join(root, 'agenticreplay'), `#!/bin/sh
if [ "$1" = version ]; then
  echo 0.1.25
  exit 0
fi
while [ "$1" != -- ]; do shift; done
shift
AGENTICREPLAY_TLS_CA=active HTTPS_PROXY="$REPLAY_TEST_PROXY" https_proxy="$REPLAY_TEST_PROXY" \
  NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 exec "$@"
`, { mode: 0o700 });
  }

  const child = spawn(process.execPath, [entry, '--model', 'ollama/fixture'], { cwd: root, env });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  child.stdin.end(`first request\n/connect compatible/fixture --base-url ${other}/custom/v1\nsecond request\n/exit\n`);
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(status, 0, output);
  assert.match(output, /answer from ollama/);
  assert.match(output, /answer from other/);
  assert.deepEqual(received, ['ollama POST /v1/chat/completions', 'other POST /custom/v1/chat/completions']);
  if (!realRecorder) {
    assert.deepEqual(forwarded, [`${ollama}/v1/chat/completions`, `${other}/custom/v1/chat/completions`]);
    return;
  }
  const runsDir = path.join(root, '.agenticreplay/runs');
  const runs = fs.readdirSync(runsDir);
  assert.equal(runs.length, 1, output);
  const events = fs.readFileSync(path.join(runsDir, runs[0], 'events.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { type: string; attrs: { port?: number; status?: number } });
  assert.equal(events.filter(event => event.type === 'model.request').length, 2, output);
  assert.equal(events.filter(event => event.type === 'model.response').length, 2, output);
  const responses = events.filter(event => event.type === 'net.response');
  assert.equal(responses.length, 2, output);
  assert.deepEqual(responses.map(event => event.attrs.status), [200, 200]);
});

/**
 * Answers with text, in saved order. The tool round trips of the first turn are saved as
 * assistant messages without text, and they are not what the following turn is judged on.
 */
function textAnswers(session: { messages: { role: string; content?: string }[] } | undefined): string[] {
  return (session?.messages ?? []).flatMap(message =>
    message.role === 'assistant' && message.content?.trim() ? [message.content] : []);
}

/**
 * Run one AgenticReplay storage case against the real recorder.
 *
 * Whether the conversation worked is judged separately from whether the recording did: the exit
 * code and the saved turns are one question, the manifest's `capture` is another. The run under
 * test is identified by the manifest of the single run directory the isolated home produced, not
 * by the directory name, because the recorder renames a sealed run after its first prompt.
 *
 * With `awaitExhaustion` the second turn is only typed once the recorder has reported
 * `capture.storage_limit` mid-run, so "the answer came back because the run was not full yet" is
 * not a passing outcome. Without it the same fixture drives a rotating run that must stay whole.
 */
function runStorageCase(t: TestContext, options: {
  fileBytes: string; runBytes: string; tools: number; awaitExhaustion: boolean;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-replay-full-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  /** Answers the fixture returned, in the order it returned them. */
  const answers: string[] = [];
  let firstTurnRequests = 0;
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      calls += 1;
      let prompt = '';
      try {
        const body = JSON.parse(raw) as { messages?: { role?: string; content?: unknown }[] };
        const users = (body.messages ?? []).filter(message => message.role === 'user');
        prompt = String(users.at(-1)?.content ?? '');
      } catch { /* The fixture reads the prompt only to tell its turns apart. */ }
      const secondTurn = prompt.includes('storage second turn');
      const round = secondTurn ? 1 : (firstTurnRequests += 1);
      // The first turn keeps the writer busy with real round trips to a fixed tool, which is how a
      // run budget is crossed by an ordinary conversation rather than by one oversized response
      // (a large body is spilled to a blob and does not move the event log the same way).
      const useTool = !secondTurn && round <= options.tools;
      const delta: { content?: string; tool_calls?: object[] } = useTool
        ? { tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name: 'list_files', arguments: '{}' } }] }
        : { content: secondTurn ? 'storage-answer-2' : 'storage-answer-1' };
      if (delta.content !== undefined) answers.push(delta.content);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'fixture', model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: useTool ? 'tool_calls' : 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return (async () => {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '1',
      OLLAMA_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      AGENTICREPLAY_EVENT_FILE_BYTES: options.fileBytes, AGENTICREPLAY_RUN_EVENT_BYTES: options.runBytes };
    delete env.AGENTICREPLAY_TLS_CA;
    delete env.AGENTICREPLAY_PROXY_URL;
    // Only MoDKH's own launch may set this. Inheriting it from the process that started the tests
    // (an interactive session that is itself being recorded) would satisfy the recorder without
    // the behaviour under test and hide a regression in the launch environment.
    delete env.AGENTICREPLAY_CONTINUE_ON_STORAGE_LIMIT;
    const child = spawn(process.execPath, [entry, '--model', 'ollama/fixture'], { cwd: root, env });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const waitFor = async (pattern: RegExp, timeoutMs = 30_000): Promise<boolean> => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (pattern.test(output)) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return pattern.test(output);
    };
    child.stdin.write('storage first turn\n');
    // The signal can only be observed before the next turn if this waits for it here: a run that
    // reports exhaustion only after the second answer has not exercised what this case is about.
    // The bound is generous against a slow CI machine and still fails a run that never saturates.
    const reached = options.awaitExhaustion
      ? await waitFor(/capture\.storage_limit/, 45_000)
      : await waitFor(/storage-answer-1/, 60_000);
    child.stdin.write('storage second turn\n');
    // The second answer is awaited before ending the session, so the exit is not racing the turn
    // the case is about. The assertion below still decides, this only sequences the two.
    await waitFor(/storage-answer-2/, 60_000);
    child.stdin.end('/exit\n');
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const runs = path.join(root, '.agenticreplay', 'runs');
    const dirs = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
    const manifest = dirs.length === 1
      ? JSON.parse(fs.readFileSync(path.join(runs, dirs[0], 'manifest.json'), 'utf8')) as {
        run_id?: string; capture?: { status?: string; issues?: string[] } } : undefined;
    const events = dirs.length === 1
      ? fs.readdirSync(path.join(runs, dirs[0])).filter(name => /^events(\.[0-9]+)?\.jsonl$/.test(name)) : [];
    const store = new SessionStore(path.join(root, 'sessions'));
    const sessions = store.list();
    const session = sessions.length ? store.load(sessions[0].id) : undefined;
    t.diagnostic?.(JSON.stringify({ fileBytes: options.fileBytes, runBytes: options.runBytes,
      tools: options.tools, calls, reached, runs: dirs.length, segments: events.length,
      runId: manifest?.run_id, capture: manifest?.capture }));
    return { output, code, reached, answers, manifest, dirs, segments: events.length, session, sessions };
  })();
}

test('a full AgenticReplay event log still allows the answer and the following turn', {
  skip: process.env.MODKH_TEST_REAL_AGENTICREPLAY !== '1', timeout: 180_000,
}, async t => {
  const { output, code, reached, answers, manifest, dirs, session, sessions } =
    await runStorageCase(t, { fileBytes: '4096', runBytes: '12288', tools: 24, awaitExhaustion: true });
  // The recorder has to run out of room for the whole run, not merely for one file.
  assert.equal(reached, true,
    `capture.storage_limit was not observed before the second turn (${manifest?.capture?.issues?.join(', ') ?? 'no manifest'}): ${output.slice(-2000)}`);
  // Whether the conversation worked is judged separately from whether the recording did.
  assert.equal(code, 0, output.slice(-2000));
  assert.equal(dirs.length, 1, `exactly one run directory is expected: ${dirs.join(', ')}`);
  assert.equal(sessions.length, 1, 'exactly one saved session is expected');
  assert.deepEqual(answers, ['storage-answer-1', 'storage-answer-2']);
  // The round trips in the first turn are saved as tool-call messages without text; the answers
  // under test are the two carrying one, in the order the user saw them.
  assert.deepEqual(textAnswers(session), ['storage-answer-1', 'storage-answer-2']);
  // The recording that did survive has to say it is incomplete, and for the reason under test.
  assert.match(output, /記録: 不完全/);
  assert.equal(manifest?.capture?.status, 'incomplete', JSON.stringify(manifest));
  assert.ok(manifest?.capture?.issues?.includes('diagnostic_storage_limit'), JSON.stringify(manifest));
  assert.match(manifest?.run_id ?? '', /^run_/);
});

test('a rotated AgenticReplay event log stays complete when only the file budget is small', {
  skip: process.env.MODKH_TEST_REAL_AGENTICREPLAY !== '1', timeout: 180_000,
}, async t => {
  const { output, code, reached, answers, manifest, dirs, segments, session, sessions } =
    await runStorageCase(t, { fileBytes: '4096', runBytes: '1048576', tools: 8, awaitExhaustion: false });
  // The negative control: the run is allowed to continue into new files, so this must not be
  // reported as exhausted. Without this, a test that always fails to saturate would still pass.
  assert.doesNotMatch(output, /capture\.storage_limit/, output.slice(-2000));
  assert.ok(segments > 1, `rotation is expected: ${segments} event files`);
  assert.equal(code, 0, output.slice(-2000));
  assert.equal(dirs.length, 1, `exactly one run directory is expected: ${dirs.join(', ')}`);
  assert.equal(sessions.length, 1, 'exactly one saved session is expected');
  assert.deepEqual(answers, ['storage-answer-1', 'storage-answer-2']);
  assert.deepEqual(textAnswers(session), ['storage-answer-1', 'storage-answer-2']);
  assert.equal(manifest?.capture?.status, 'complete', JSON.stringify(manifest));
  assert.ok(!manifest?.capture?.issues?.includes('diagnostic_storage_limit'), JSON.stringify(manifest));
  assert.equal(reached, true, output.slice(-2000));
});
