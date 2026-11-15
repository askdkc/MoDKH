import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LspServer } from '../src/language/lsp/client.ts';
import { ServerPool, aggregate } from '../src/language/lsp/pool.ts';
import { LanguageService } from '../src/language/lsp/service.ts';
import { languageById } from '../src/language/catalog.ts';

const fixture = new URL('./fixtures/fake-lsp.mjs', import.meta.url).pathname;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-lsp-')));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });

function server(mode: string, id = 'typescript'): LspServer {
  return new LspServer({
    id, command: process.execPath, args: [fixture], root,
    requestTimeoutMs: 3000, env: { FAKE_LSP_MODE: mode },
  });
}

test('diagnostics distinguish a real zero result from a silent server', async () => {
  const clean = server('clean');
  const cleanFile = path.join(root, 'src', 'clean.ts');
  try {
    await clean.start();
    const observed = await clean.synchronize(cleanFile, 'const ok = 1;\n');
    assert.equal(observed.status, 'observed');
    assert.equal(observed.diagnostics.length, 0);
  } finally { await clean.dispose(); }

  const silent = server('silent');
  try {
    await silent.start();
    const waiting = await silent.synchronize(path.join(root, 'src', 'silent.ts'), 'const ok = 1;\n');
    assert.equal(waiting.status, 'waiting', '無通知は診断0件ではない');
    assert.equal(waiting.diagnostics.length, 0);
  } finally { await silent.dispose(); }
});

test('a diagnostic for an older document version is not reported as current', async () => {
  const stale = server('stale');
  try {
    await stale.start();
    await stale.synchronize(path.join(root, 'src', 'stale.ts'), 'BROKEN v1\n');
    const second = await stale.synchronize(path.join(root, 'src', 'stale.ts'), 'BROKEN v2 changed\n');
    assert.equal(second.status, 'waiting');
    assert.equal(second.diagnostics.some(d => d.message === 'STALE_DIAGNOSTIC'), false);
  } finally { await stale.dispose(); }
});

test('the same text is not re-sent and an edited version is synchronized', async () => {
  const live = server('clean');
  const file = path.join(root, 'src', 'edit.ts');
  try {
    await live.start();
    const first = await live.synchronize(file, 'BROKEN here\n');
    assert.equal(first.status, 'observed');
    assert.equal(first.diagnostics[0].message, 'BROKEN_FOUND');
    const same = await live.synchronize(file, 'BROKEN here\n');
    assert.equal(same.version, first.version, '同一内容では版を進めない');
    const fixed = await live.synchronize(file, 'const ok = 1;\n');
    assert.equal(fixed.status, 'observed');
    assert.equal(fixed.diagnostics.length, 0, '編集後は新しい診断を返す');
  } finally { await live.dispose(); }
});

test('a server that never answers initialize fails with a reason instead of hanging', async () => {
  const dead = new LspServer({ id: 'typescript', command: process.execPath, args: [fixture], root, requestTimeoutMs: 400, env: { FAKE_LSP_MODE: 'no-initialize' } });
  try {
    await assert.rejects(dead.start(), /初期化に失敗|応答しません/);
    assert.equal(dead.running, false);
  } finally { await dead.dispose(); }
});

test('hover, definition and references report positions and refuse a dead server', async () => {
  const live = server('clean');
  const file = path.join(root, 'src', 'nav.ts');
  try {
    await live.start();
    await live.synchronize(file, 'const value = 1;\n');
    const hover = await live.hover(file, { line: 0, character: 6 });
    assert.match(hover ?? '', /HOVER 0:6/);
    assert.deepEqual((await live.definition(file, { line: 0, character: 6 })).length, 1);
    assert.equal((await live.references(file, { line: 0, character: 6 })).length, 1);
  } finally { await live.dispose(); }
  await assert.rejects(() => live.hover(file, { line: 0, character: 0 }), /起動していません/);
});

test('dispose waits for the process and never leaks a write after teardown', async () => {
  const live = server('clean');
  const file = path.join(root, 'src', 'dispose.ts');
  await live.start();
  await live.synchronize(file, 'const a = 1;\n');
  const child = live['child'] as import('node:child_process').ChildProcess | undefined;
  assert.ok(child, 'server process must exist');
  const exited = new Promise<void>(resolve => { child!.once('exit', () => resolve()); });
  await live.dispose();
  // The runner fails a test file when work continues after the test; dispose must finish the job.
  await exited;
  assert.equal(child!.exitCode !== null || child!.signalCode !== null, true);
  assert.equal(live.running, false);
  await new Promise(resolve => setImmediate(resolve));
});

test('aborting startup stops the process instead of leaving it running', async () => {
  const ac = new AbortController();
  const live = server('no-initialize');
  const starting = live.start(ac.signal);
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(starting);
  const child = live['child'] as import('node:child_process').ChildProcess | undefined;
  assert.equal(child, undefined, 'the client must not keep a child after a stopped launch');
  assert.equal(live.running, false);
});

test('workspace/applyEdit from a server is refused, not applied', async () => {
  const live = server('clean');
  try {
    await live.start();
    // The client registers a refusal handler; nothing in the repository may change.
    assert.equal(fs.existsSync(path.join(root, 'server-edit.txt')), false);
  } finally { await live.dispose(); }
});

test('pool reuses one server per key and caps concurrent servers', async () => {
  const pool = new ServerPool({ maxRunning: 2, requestTimeoutMs: 2000 });
  const language = languageById('typescript')!;
  try {
    const launch = { command: process.execPath, args: [fixture] };
    const first = await pool.acquire({ root, language, configDigest: 'a' }, launch);
    const again = await pool.acquire({ root, language, configDigest: 'a' }, launch);
    assert.equal(first.reused, false);
    assert.equal(again.reused, true);
    assert.equal(pool.size, 1);
    const second = await pool.acquire({ root, language, configDigest: 'b' }, launch);
    assert.equal(second.status, 'ready');
    assert.equal(pool.size, 2);
    // At capacity the least recently used server is stopped so the new key can start.
    const third = await pool.acquire({ root, language, configDigest: 'c' }, launch);
    assert.equal(third.status, 'ready');
    assert.equal(pool.size, 2);
    assert.equal(first.server.running, false, '最も古いサーバーは解放される');
    assert.equal(second.server.running, true);
    assert.equal(third.server.running, true);
  } finally { await pool.disposeAll(); }
});

test('closing a pool stops every owned server', async () => {
  const pool = new ServerPool({ requestTimeoutMs: 2000 });
  const language = languageById('typescript')!;
  const started = await pool.acquire({ root, language, configDigest: 'x' }, { command: process.execPath, args: [fixture] });
  assert.equal(started.status, 'ready');
  await pool.disposeAll();
  assert.equal(pool.size, 0);
  assert.equal(started.server.running, false);
});

test('aggregate keeps successful results when another server fails', () => {
  const combined = aggregate([
    { id: 'typescript', status: 'observed', diagnostics: [{ path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, severity: 'error', message: 'bad', server: 'typescript' }] },
    { id: 'tailwind', status: 'error', detail: 'timeout' },
  ]);
  assert.equal(combined.diagnostics.length, 1);
  assert.equal(combined.servers[1].detail, 'timeout');
});

test('analysis failure never throws and reports degradation', async () => {
  const service = new LanguageService({
    root,
    settings: { autoInstall: false, disabled: ['typescript'], installTimeoutMs: 1000, requestTimeoutMs: 500, servers: {} },
  });
  try {
    const file = path.join(root, 'src', 'x.ts');
    fs.writeFileSync(file, 'const x = 1;\n');
    const result = await service.analyze(file, 'const x = 1;\n');
    assert.equal(result.status, 'unavailable');
    assert.match(result.detail ?? '', /無効/);
  } finally { await service.close(); }
  assert.equal((await service.analyze('anything.ts', 'x')).status, 'unavailable');
});

test('a file without a language is reported as unsupported rather than clean', async () => {
  const service = new LanguageService({
    root,
    settings: { autoInstall: false, disabled: [], installTimeoutMs: 1000, requestTimeoutMs: 500, servers: {} },
  });
  try {
    const result = await service.analyze(path.join(root, 'notes.txt'), 'hello');
    assert.equal(result.status, 'unavailable');
    assert.match(result.detail ?? '', /対応言語ではない/);
  } finally { await service.close(); }
});

test('malformed/unchanged pull reports do not invent clean diagnostics; valid empty report is observed', async () => {
  for (const mode of ['pull-invalid', 'pull-empty']) {
    const live=server(mode);
    try {
      await live.start();
      const result=await live.synchronize(path.join(root,`${mode}.ts`),'BROKEN');
      assert.equal(result.status,mode==='pull-empty'?'observed':'waiting');
      assert.deepEqual(live.diagnosticEvidence,{pushNotifications:0,pullRequests:1,pullReports:mode==='pull-empty'?1:0,pullSupported:true});
    } finally { await live.dispose(); }
  }
});


test('disposing an LSP stops its owned child process group and shares completion', async () => {
  const pidFile=path.join(root,'owned-child.pid');
  const live=new LspServer({id:'commonlisp',command:process.execPath,args:[fixture],root,requestTimeoutMs:3000,env:{FAKE_LSP_MODE:'owned-child',FAKE_LSP_CHILD_PID:pidFile}});
  try {
    await live.start();
    const pid=Number(fs.readFileSync(pidFile,'utf8'));assert.ok(pid>1);assert.doesNotThrow(()=>process.kill(pid,0));
    const first=live.dispose();assert.equal(live.dispose(),first);await first;
    assert.throws(()=>process.kill(pid,0),/ESRCH/);
  } finally {await live.dispose();}
});

test('pool eviction preserves unknown cleanup instead of silently claiming settlement', async () => {
 const pool=new ServerPool({maxRunning:1,requestTimeoutMs:3000});
 const first=await pool.acquire({root,language:languageById('typescript')!,configDigest:'first'},{command:process.execPath,args:[fixture]});
 const stop=first.server.dispose.bind(first.server);
 first.server.dispose=async()=>{throw new Error('fixture cleanup unknown');};
 try {
  await pool.acquire({root,language:languageById('typescript')!,configDigest:'second'},{command:process.execPath,args:[fixture]});
  await assert.rejects(pool.settled(),/cleanup unknown/);
  await assert.rejects(pool.disposeAll(),/cleanup unknown/);
 } finally {await stop();}
});
