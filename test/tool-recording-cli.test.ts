import { readSealedReplay } from './sealed-replay.ts';
import { SessionStore } from '../src/session/store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

async function trial(record: boolean, maxTurns: number, mode: 'normal' | 'broken' | 'replay' | 'crash' | 'lost-click' | 'denied' | 'job' | 'interrupt' | 'disconnect' | 'foreground-child' | 'background-child' = 'normal',
  provider = 'compatible', route: 'direct' | 'saved' | 'resume' | 'connect' | 'https-connect' = 'direct') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-tool-record-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const log = path.join(root, 'states.jsonl');
  let posts = 0;
  const crash = mode === 'crash';
  const lostClick = mode === 'lost-click';
  const childProbe = mode === 'foreground-child' || mode === 'background-child';
  const background = mode === 'job' || mode === 'background-child';
  const replay = childProbe || ['replay', 'lost-click', 'denied', 'job', 'interrupt', 'disconnect'].includes(mode);
  if (childProbe) {
    // Model a nested tool recorder that emits a final receipt if it inherits a transport.
    fs.writeFileSync(path.join(project, 'child.cjs'), `const fs = require('node:fs');
const destination = process.env.AGENTICREPLAY_MODKH_FRAMES;
if (destination) {
  const frame = { session: 'nested', turn: 0, attempt: require('node:crypto').randomUUID(), ordinal: 1,
    callId: 'nested-call', state: 'completed', reason: 'command_exited' };
  fs.appendFileSync(destination, JSON.stringify(frame) + '\\n');
}
fs.appendFileSync('marker', 'x');
`);
  }
  let command = childProbe ? 'node child.cjs' : 'printf x >> marker';
  if (background) command = 'echo $$ > job.pid; ' + command;
  if (crash) command += '; sleep 3';
  const action = lostClick ? { name: 'browse', arguments: JSON.stringify({ action: 'click', tab: 7, ref: 'e11' }) }
    : { name: 'run_command', arguments: JSON.stringify({ command, ...(background && { run_in_background: true }) }) };
  const fixtureKey = 'fixture-local-key';
  const tls = route === 'https-connect';
  const serve: http.RequestListener = async (req, res) => {
    for await (const _ of req) { /* drain the POST */ }
    if (tls && req.headers.authorization !== 'Bearer ' + fixtureKey) { res.writeHead(401).end(); return; }
    posts++;
    const toolRequested = posts === 1 || ((crash || mode === 'disconnect') && posts === 2);
    const delta = toolRequested ? { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function',
      function: action }] } : { content: 'FIXTURE_DONE' };
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: toolRequested ? 'tool_calls' : 'stop' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'disconnect' && posts === 1) {
      const partial = { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] };
      res.write('data: ' + JSON.stringify(partial) + '\n\n');
      setTimeout(() => res.destroy(), 75);
      return;
    }
    res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
  };
  const cert = path.join(root, 'tls.crt');
  const key = path.join(root, 'tls.key');
  if (tls) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const server = tls ? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, serve)
    : http.createServer(serve);
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ maxTurns, permissions: 'none', language: { autoInstall: false } }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: root, MODKH_PLAIN: '1' };
    if (replay) {
      for (const key of Object.keys(env)) {
        if (key.startsWith('AGENTICREPLAY_') || key.startsWith('MODKH_AGENTICREPLAY')) delete env[key];
      }
    } else env.MODKH_AGENTICREPLAY = '0';
    if (tls) {
      fs.writeFileSync(path.join(root, 'keys.json'), JSON.stringify({ compatible: fixtureKey }));
      env.NODE_EXTRA_CA_CERTS = cert;
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
    if (record) env.MODKH_TOOL_RECORD_FILE = mode === 'broken' ? root : log;
    else delete env.MODKH_TOOL_RECORD_FILE;
    if (lostClick) {
      fs.writeFileSync(path.join(root, 'browse'), '#!/bin/sh\n[ "$1" = click ] || exit 2\n' +
        'printf x >> marker\n[ -z "${MODKH_TOOL_RECORD_FILE+x}" ] || exit 2\necho "click did not finish within 20 s"\nexit 1\n', { mode: 0o700 });
      env.PATH = root + path.delimiter + env.PATH;
    }
    let output = '';
    const model = provider + '/fixture';
    const baseUrl = (tls ? 'https' : 'http') + '://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1';
    const connection = ['--model', model, '--base-url', baseUrl];
    const store = new SessionStore(path.join(root, 'sessions'));
    if (route === 'saved') fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      model, modelBaseUrl: baseUrl, maxTurns, permissions: 'none', language: { autoInstall: false },
    }));
    async function launch(resume?: string, initialize = false) {
      const child = spawn(process.execPath, [entry, 'chat', '--cwd', project,
        ...(route === 'direct' || initialize ? connection : []),
        ...(resume ? ['--resume', resume] : [])], { cwd: root, env, stdio: 'pipe' });
      let interrupted = false;
      child.stdout.on('data', b => {
        output += b;
        if (mode === 'interrupt' && !interrupted && output.includes('打ち切り:')) interrupted = child.kill('SIGINT');
      });
      child.stderr.on('data', b => { output += b; });
      const closed = once(child, 'close');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 60000);
      let killedAfterStart = false;
      const watch = background ? setInterval(() => {
        const pidFile = path.join(project, 'job.pid');
        if (!fs.existsSync(pidFile)) return;
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) return;
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            clearInterval(watch);
            child.stdin.end('/exit\n');
          }
        }
      }, 50) : crash && !resume ? setInterval(() => {
        if (!killedAfterStart && fs.existsSync(path.join(project, 'marker')) && fs.existsSync(log) &&
            fs.readFileSync(log, 'utf8').includes('"reason":"command_started"')) killedAfterStart = child.kill('SIGKILL');
      }, 10) : undefined;
      if (route === 'connect' || tls) child.stdin.write('/connect ' + model + ' --base-url ' + baseUrl + '\n');
      if (mode === 'interrupt' || background) child.stdin.write('Run the fixture.\ny\n');
      else if (initialize) child.stdin.end('/exit\n');
      else if (crash && resume) child.stdin.end('Continue the fixture.\n/exit\n');
      else if (lostClick) child.stdin.end('Click once.\n/exit\n');
      else child.stdin.end('Run the fixture.\n' + (mode === 'denied' ? 'n' : 'y') + '\n/exit\n');
      try {
        const [code, signal] = await closed;
        if (crash && !resume) {
          assert.ok(killedAfterStart, output);
          assert.equal(signal, 'SIGKILL');
        } else if (mode === 'interrupt') assert.ok(interrupted && (code === 0 || code === 130 || signal === 'SIGINT'), output);
        else assert.equal(code, 0, output);
      } finally { clearTimeout(deadline); clearInterval(watch); }
    }
    const runs = path.join(project, '.agenticreplay', 'runs');
    let previous: string | undefined;
    if (route === 'resume') {
      await launch(undefined, true);
      [previous] = fs.readdirSync(runs);
      const before = readSealedReplay(path.join(runs, previous));
      await launch(store.list()[0].id);
      assert.deepEqual(readSealedReplay(path.join(runs, previous)), before);
    } else await launch();
    if (crash) {
      const [session] = fs.readdirSync(path.join(root, 'sessions')).filter(name => name.endsWith('.jsonl'));
      assert.ok(session);
      await launch(session.slice(0, -6));
    }
    const raw = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(raw, /printf|marker|FIXTURE_DONE|exit code|fixture\./);
    const events = [];
    if (replay) {
      const dirs = fs.readdirSync(runs).filter(name => name !== previous);
      assert.equal(dirs.length, 1);
      events.push(...readSealedReplay(path.join(runs, dirs[0])));
      assert.ok(!JSON.stringify(events).includes(fixtureKey));
      const receipts = store.load(store.list()[0].id).messages.flatMap(m => m.role === 'tool' ? m.results : []);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].callId, 'fixture-call');
      if (!lostClick) assert.equal(receipts[0].status, mode === 'denied' ? 'error' : 'ok');
      // The truncated upstream exchange has network evidence, but no complete model response.
      const exchanges = mode === 'disconnect' ? posts - 1 : posts;
      assert.equal(events.filter(e => e.type === 'model.request').length, exchanges);
      assert.equal(events.filter(e => e.type === 'model.response').length, exchanges);
    }
    return { events, behavior: { posts, approvals: output.split('承認要求(command)').length - 1,
      marker: fs.existsSync(path.join(project, 'marker')) ? fs.readFileSync(path.join(project, 'marker'), 'utf8') : '', done: output.includes('FIXTURE_DONE') },
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

const realReplay = process.env.MODKH_TEST_TOOL_RECORD_AR === '1' || process.env.MODKH_TEST_REAL_AGENTICREPLAY === '1';

test('real AgenticReplay merges the receipt with proxy evidence and records it without another POST', { skip: !realReplay }, async () => {
  const routes = ['direct', 'saved', 'resume', 'connect'] as const;
  const cases = ['ollama', 'llama-server', 'compatible', 'local-llm'].flatMap(provider =>
    routes.map(route => [provider, route, 1, false] as const));
  for (const [provider, route, posts, record] of [
    ...cases, ['compatible', 'direct', 2, false], ['compatible', 'direct', 2, true],
    ['compatible', 'https-connect', 1, false],
  ] as const) {
    const { behavior, events, rows, output } = await trial(record, posts, 'replay', provider, route);
    assert.equal(behavior.posts, posts, output);
    assert.equal(behavior.marker, 'x');
    assert.equal(behavior.approvals, 1);
    assert.equal(rows.some(row => row.reason === 'command_exited'), record);
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

test('real AgenticReplay records interruptions, retries, denials and background jobs', { skip: !realReplay }, async () => {
  for (const mode of ['denied', 'job', 'interrupt', 'disconnect'] as const) {
    const { events, behavior, output } = await trial(false, 1, mode);
    assert.equal(behavior.posts, mode === 'disconnect' ? 2 : 1);
    if (mode === 'disconnect') assert.equal(events.filter(e => e.attrs?.reason === 'command_started').length, 1);
    assert.equal(behavior.marker, mode === 'denied' ? '' : 'x', output);
    const results = events.filter(e => e.type === 'tool.result');
    assert.equal(results.length, 1, output);
    assert.equal(results[0].attrs.state, { denied: 'not-executed', job: 'accepted', interrupt: 'completed', disconnect: 'completed' }[mode]);
    if (mode === 'denied') assert.equal(results[0].attrs.reason, 'approval_denied');
    if (mode === 'job') {
      const settled = events.filter(e => e.attrs?.reason === 'command_exited');
      assert.equal(settled.length, 1, output);
      assert.equal(settled[0].attrs.job_id, results[0].attrs.job_id);
      assert.deepEqual(settled[0].causes, [results[0].seq]);
    }
  }
});

test('real AgenticReplay automatically records an unacknowledged click once', { skip: !realReplay }, async () => {
  const { events, behavior, output } = await trial(false, 2, 'lost-click');
  assert.deepEqual(behavior, { posts: 1, approvals: 0, marker: 'x', done: false });
  assert.match(output, /中断しました。browse click/);
  assert.match(output, /click did not finish within 20 s/);
  const calls = events.filter(e => e.type === 'tool.call');
  const results = events.filter(e => e.type === 'tool.result');
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].causes, [calls[0].seq]);
  assert.equal(results[0].attrs.state, 'unknown');
  assert.ok(!events.some(e => e.attrs?.rule === 'unresolved_tool_calls'));
});

for (const kind of ['foreground', 'background'] as const) {
  test(`real AgenticReplay isolates ${kind} child receipts`, { skip: !realReplay }, async () => {
    const { events, behavior, output } = await trial(false, 1, `${kind}-child`);
    assert.equal(behavior.marker, 'x', output);
    const calls = events.filter(e => e.type === 'tool.call');
    const results = events.filter(e => e.type === 'tool.result');
    assert.equal(calls.length, 1);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].causes, [calls[0].seq]);
    assert.equal(results[0].attrs.state, kind === 'foreground' ? 'completed' : 'accepted');
    if (kind === 'background') {
      const settled = events.filter(e => e.attrs?.reason === 'command_exited');
      assert.equal(settled.length, 1);
      assert.ok(results[0].attrs.job_id);
      assert.equal(settled[0].attrs.job_id, results[0].attrs.job_id);
      assert.deepEqual(settled[0].causes, [results[0].seq]);
    }
  });
}
