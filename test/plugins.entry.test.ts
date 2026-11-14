import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const entry = process.env.DKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
test('public CLI discovers built-in subagent plugins without starting a model', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-plugins-entry-'));
  try {
    const r = spawnSync(process.execPath, [entry, 'plugin', 'list'], { encoding: 'utf8', env: { ...process.env, DKH_HOME: home }, timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dkh-explorer/);
    assert.match(r.stdout, /dkh-worker/);
    assert.equal(fs.existsSync(path.join(home, 'sessions')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('/agents is discoverable without connecting a model', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-agents-entry-'));
  try {
    const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', input: '/agents\n/exit\n', env: { ...process.env, DKH_HOME: home }, timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dkh-explorer/);
    assert.match(r.stdout, /dkh-worker/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

function sandbox(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-agents-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.writeFileSync(path.join(root, 'README.md'), '# dkh サンプル\n');
  const run = (args: string[], input = '') => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', input,
      env: { ...process.env, DKH_HOME: home, DKH_PLAIN: '1' }, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const journals = () => fs.readdirSync(path.join(home, 'sessions')).map(name => fs.readFileSync(path.join(home, 'sessions', name), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
  return { root, home, run, journals };
}

test('third-party local package: trust, add, run, disable, enable and remove through public CLI', t => {
  const f = sandbox(t);
  const plugin = path.join(f.root, 'my reviewer');
  fs.mkdirSync(plugin);
  fs.writeFileSync(path.join(plugin, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'my-reviewer', version: '1', title: 'Review', description: 'Read only', kind: 'local', entry: './index.mjs' }));
  fs.writeFileSync(path.join(plugin, 'index.mjs'), 'export function define() { return {system: \"Read only\", tools:[\"read_file\"]}; }');
  assert.match(f.run(['plugin', 'add', plugin], 'n\n'), /登録しませんでした/);
  assert.doesNotMatch(f.run(['plugin', 'list']), /my-reviewer/);
  assert.match(f.run(['plugin', 'add', plugin], 'y\n'), /登録しました: my-reviewer/);
  assert.match(f.run(['plugin', 'list']), /my-reviewer.*enabled/);
  const output = f.run([], '/connect fixed/scripted\n/agents run my-reviewer Inspect\n/exit\n');
  assert.match(output, /子の実行結果: ok/);
  const logs = f.journals();
  const parent = logs.find(events => !events[0].parentSessionId)!;
  const child = logs.find(events => events[0].parentSessionId)!;
  assert.equal(logs.length, 2);
  assert.equal(child[0].parentSessionId, parent[0].id);
  assert.equal(parent.filter(e => e.type === 'delegation').at(-1).record.result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), '# dkh サンプル\n');
  assert.equal(fs.existsSync(path.join(f.root, 'marker.txt')), false);
  f.run(['plugin', 'disable', 'my-reviewer']);
  assert.match(f.run([], '/agents run my-reviewer Inspect\n/help\n/exit\n'), /利用できない子: my-reviewer/);
  f.run(['plugin', 'enable', 'my-reviewer']);
  assert.match(f.run(['plugin', 'list']), /my-reviewer.*enabled/);
  f.run(['plugin', 'remove', 'my-reviewer']);
  assert.doesNotMatch(f.run(['plugin', 'list']), /my-reviewer/);
  assert.ok(f.journals().some(events => events[0].id === child[0].id));
});

test('manual child execution and reconnect do not consume the parent FixedModel cursor', t => {
  const f = sandbox(t);
  const output = f.run([], '/connect fixed/scripted\n/agents run dkh-explorer Inspect\n/connect fixed/scripted\nParent work\nn\nn\nn\n/exit\n');
  assert.match(output, /子の実行結果: ok/);
  const parent = f.journals().find(events => !events[0].parentSessionId)!;
  const calls = parent.flatMap(e => e.type === 'message' && e.message.role === 'assistant' ? e.message.toolCalls ?? [] : []);
  assert.ok(calls.some(c => c.name === 'list_files'), 'parent must still execute its first model step');
});

test('empty and malformed plugin settings retain ordinary chat and command help', t => {
  const f = sandbox(t);
  f.run(['plugin', 'disable', 'dkh-explorer']);
  f.run(['plugin', 'disable', 'dkh-worker']);
  assert.match(f.run([], '/agents\n/help\n/exit\n'), /利用可能な子はありません/);
  f.run(['plugin', 'enable', 'dkh-explorer']);
  f.run(['plugin', 'enable', 'dkh-worker']);
  fs.writeFileSync(path.join(f.home, 'config.json'), '[]');
  assert.match(f.run([], '/agents\n/exit\n'), /子の起動は無効/);
  fs.writeFileSync(path.join(f.home, 'config.json'), '{broken');
  const output = f.run([], '/agents\n/connect fixed/scripted\nwork\nn\nn\nn\n/exit\n');
  assert.match(output, /子の起動は無効/);
  assert.match(output, /応答終了/);
});

test('bare startup can select a worker, approve its edits and collect its result', t => {
  const f = sandbox(t);
  const output = f.run([], '/connect fixed/scripted\n/agents run\n2\nImplement fixture\ny\ny\ny\n/exit\n');
  assert.match(output, /子の実行結果: ok/);
  assert.match(output, /dkh-worker \/ /);
  assert.match(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), /固定応答モデルによる追記/);
  assert.equal(fs.readFileSync(path.join(f.root, 'marker.txt'), 'utf8').trim(), '実行マーカー');
});

test('Ctrl+C at child approval returns to input without applying the edit', async t => {
  const f = sandbox(t);
  // Stop during an approval prompt is the subject here, so use the policy that always prompts.
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ permissions: 'none' }));
  const child = spawn(process.execPath, [entry, '--model', 'fixed/scripted'], { cwd: f.root, env: { ...process.env, DKH_HOME: f.home, DKH_PLAIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', stopped = false, returned = false;
  const exited = new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!stopped && stdout.includes('--- 承認要求(edit) ---')) { stopped = true; child.kill('SIGINT'); }
    if (!returned && stdout.includes('(中断しました。')) { returned = true; child.stdin.end('/help\n/exit\n'); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    child.stdin.write('/agents run dkh-worker Implement\n');
    assert.equal(await exited, 0, stderr || stdout);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  assert.equal(stopped, true, stdout);
  assert.equal(returned, true, stdout);
  assert.match(stdout, /プロバイダー選択/);
  assert.equal(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), '# dkh サンプル\n');
  const parent = f.journals().find(events => !events[0].parentSessionId)!;
  assert.equal(parent.filter(e => e.type === 'delegation').at(-1).record.result.status, 'cancelled');
});

test('external fixture uses per-process approval and preserves literal arguments', t => {
  const f = sandbox(t);
  const directory = path.join(f.root, 'external');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'external-fixture', version: '1', title: 'External', description: 'Local process fixture', kind: 'external', entry: './index.mjs' }));
  const literal = "a'b $HOME";
  fs.writeFileSync(path.join(directory, 'index.mjs'), `export function start(request, host) { return {result:host.run({command:process.execPath,args:['-e','console.log(process.argv[1])',${JSON.stringify(literal)}]}).then(r=>({text:r.output})),stop:async()=>{}}; }`);
  f.run(['plugin', 'add', directory], 'y\n');
  const output = f.run([], '/agents run external-fixture Probe\ny\ny\n/exit\n');
  assert.match(output, /子の実行結果: ok/);
  assert.match(output, /リモート処理の停止/);
  const child = f.journals().find(events => events[0].parentSessionId)!;
  const result = child.flatMap(e => e.message?.role === 'tool' ? e.message.results : []).find(r => r.name === 'external_process');
  assert.equal(result.status, 'ok');
  assert.ok(result.output.includes(literal), result.output);
});

test('external startup throw is persisted as unconfirmed cleanup and prevents removal through CLI', t => {
  const f = sandbox(t);
  const directory = path.join(f.root, 'failed-external');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'failed-external', version: '1', title: 'Failing external', description: 'Startup failure fixture', kind: 'external', entry: './index.mjs' }));
  fs.writeFileSync(path.join(directory, 'index.mjs'), "export function start() { throw new Error('startup exception'); }");
  f.run(['plugin', 'add', directory], 'y\n');
  const output = f.run([], '/agents run failed-external Probe\ny\n/exit\n');
  assert.match(output, /子の実行結果: unknown/);
  const parent = f.journals().find(events => !events[0].parentSessionId)!;
  const result = parent.filter(e => e.type === 'delegation').at(-1).record.result;
  assert.equal(result.status, 'unknown');
  assert.equal(result.cleanup, 'unknown');
  const removal = spawnSync(process.execPath, [entry, 'plugin', 'remove', 'failed-external'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, DKH_HOME: f.home }, timeout: 10000 });
  assert.equal(removal.status, 1, removal.stderr + removal.stdout);
  assert.match(removal.stderr, /unreconciled lease/);
});

test('external cleanup releases its pending approval and returns to CLI input without Ctrl+C', async t => {
  const f = sandbox(t);
  const directory = path.join(f.root, 'pending-external');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'pending-external', version: '1', title: 'Pending external', description: 'Unawaited process fixture', kind: 'external', entry: './index.mjs' }));
  fs.writeFileSync(path.join(directory, 'index.mjs'), `export function start(request, host) {
    void host.run({command:process.execPath,args:['-e',\"require('node:fs').writeFileSync('forbidden','bad')\"]});
    return {result:Promise.resolve({text:'captured'}),stop:async()=>{}};
  }`);
  f.run(['plugin', 'add', directory], 'y\n');
  const child = spawn(process.execPath, [entry], { cwd: f.root, env: { ...process.env, DKH_HOME: f.home, DKH_PLAIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', returned = false;
  const exited = new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!returned && stdout.includes('子の実行結果: error')) {
      returned = true;
      child.stdin.end('/help\n/exit\n');
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    child.stdin.write('/agents run pending-external Probe\ny\n');
    assert.equal(await exited, 0, stderr || stdout);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  assert.equal(returned, true, stdout);
  assert.match(stdout, /外部プラグインのプロセス起動/);
  assert.match(stdout, /プロバイダー選択/);
  assert.equal(fs.existsSync(path.join(f.root, 'forbidden')), false);
  const parent = f.journals().find(events => !events[0].parentSessionId)!;
  assert.equal(parent.filter(e => e.type === 'delegation').at(-1).record.result.cleanup, 'settled');
  assert.equal(parent.filter(e => e.type === 'delegation').at(-1).record.result.text, 'captured');
  f.run(['plugin', 'remove', 'pending-external']);
});
