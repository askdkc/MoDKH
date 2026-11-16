import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
while [ "$1" != -- ]; do shift; done
shift
AGENTICREPLAY_TLS_CA=active exec "$@"
`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}`,
    MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '1', REPLAY_TEST_CALLS: calls };
  delete env.AGENTICREPLAY_TLS_CA;
  delete env.AGENTICREPLAY_PROXY_URL;
  const run = (status: string, args: string[], recording = '1') => {
    fs.rmSync(calls, { force: true });
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: root, env: { ...env, MODKH_AGENTICREPLAY: recording, REPLAY_TEST_STATUS: status },
      input: '/exit\n', encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
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
