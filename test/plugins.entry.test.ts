import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
test('public CLI discovers built-in subagent plugins without starting a model', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-plugins-entry-'));
  try {
    const r = spawnSync(process.execPath, [entry, 'plugin', 'list'], { encoding: 'utf8', env: { ...process.env, MODKH_HOME: home }, timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /modkh-explorer/);
    assert.match(r.stdout, /modkh-worker/);
    assert.equal(fs.existsSync(path.join(home, 'sessions')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('/agents is discoverable without connecting a model', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-agents-entry-'));
  try {
    const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', input: '/agents\n/exit\n', env: { ...process.env, MODKH_HOME: home }, timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /modkh-explorer/);
    assert.match(r.stdout, /modkh-worker/);
    assert.match(r.stdout, /modkh-micro-ts-outline/);
    assert.match(r.stdout, /modkh-micro-svelte-diagnostics/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('bare CLI dispatches two language roles and returns both results to the parent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-default-moa-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'client.ts'), 'export function typedClient(): string { return "ok"; }');
  fs.writeFileSync(path.join(root, 'server.js'), 'export function jsServer() { return "ok"; }');
  const toolCall = (id: string, name: string, args: object) => ({
    tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  const ask = (language: string, path: string) => toolCall(`delegate-${language}`, 'run_subagent', {
    pluginId: `modkh-micro-${language}-outline`, task: `Inspect ${path}`,
  });
  const steps = [
    toolCall('roles', 'list_subagents', {}),
    ask('ts', 'client.ts'),
    toolCall('ts-outline', 'code_outline', { path: 'client.ts' }),
    { content: 'TypeScript outline inspected' },
    ask('js', 'server.js'),
    toolCall('js-outline', 'code_outline', { path: 'server.js' }),
    { content: 'JavaScript outline inspected' },
    { content: 'Both language results integrated' },
  ];
  const requests: { messages: unknown[]; tools: { function: { name: string } }[] }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const step = steps[requests.push(request) - 1];
    if (!step) { res.writeHead(500).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: object, finish_reason: string | null) => res.write(`data: ${JSON.stringify({
      id: 'default-moa', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    send({ role: 'assistant', ...step }, null);
    send({}, 'tool_calls' in step ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    model: 'compatible/fixture',
    modelBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    language: { autoInstall: false },
  }));
  const child = spawn(process.execPath, [entry], {
    cwd: root, env: { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' },
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end('client.ts と server.js の構造を調べ、結果をまとめて。\n/exit\n');
  const [exitCode] = await once(child, 'close');
  assert.equal(exitCode, 0, output);
  assert.match(output, /Both language results integrated/);
  assert.equal(requests.length, steps.length, output);
  const firstRequest = JSON.stringify(requests[0].messages);
  assert.match(firstRequest, /ユーザーから分担の指定がない場合も/);
  assert.match(firstRequest, /対象言語ごとに委譲/);
  for (const index of [2, 5]) {
    assert.deepEqual(requests[index].tools.map(tool => tool.function.name), ['code_outline']);
  }
  assert.match(JSON.stringify(requests[3].messages), /typedClient/);
  assert.match(JSON.stringify(requests[6].messages), /jsServer/);
  const parentMessages = JSON.stringify(requests[7].messages);
  assert.match(parentMessages, /TypeScript outline inspected/);
  assert.match(parentMessages, /JavaScript outline inspected/);
});

function sandbox(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-agents-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.writeFileSync(path.join(root, 'README.md'), '# modkh サンプル\n');
  const run = (args: string[], input = '') => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, encoding: 'utf8', input,
      env: { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' }, timeout: 15000 });
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
  assert.equal(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), '# modkh サンプル\n');
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
  const output = f.run([], '/connect fixed/scripted\n/agents run modkh-explorer Inspect\n/connect fixed/scripted\nParent work\nn\nn\nn\n/exit\n');
  assert.match(output, /子の実行結果: ok/);
  const parent = f.journals().find(events => !events[0].parentSessionId)!;
  const calls = parent.flatMap(e => e.type === 'message' && e.message.role === 'assistant' ? e.message.toolCalls ?? [] : []);
  assert.ok(calls.some(c => c.name === 'list_files'), 'parent must still execute its first model step');
});

test('empty and malformed plugin settings retain ordinary chat and command help', t => {
  const f = sandbox(t);
  f.run(['plugin', 'disable', 'modkh-explorer']);
  f.run(['plugin', 'disable', 'modkh-worker']);
  const builtinRoles = [...f.run(['plugin', 'list']).matchAll(/^\s*(modkh-micro-[\w-]+)/gm)].map(match => match[1]);
  assert.ok(builtinRoles.length > 0);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({
    subagents: Object.fromEntries(builtinRoles.map(id => [id, { disabled: true }])),
  }));
  assert.match(f.run([], '/agents\n/help\n/exit\n'), /利用可能な子はありません/);
  f.run(['plugin', 'enable', 'modkh-explorer']);
  f.run(['plugin', 'enable', 'modkh-worker']);
  fs.writeFileSync(path.join(f.home, 'config.json'), '[]');
  assert.match(f.run([], '/agents\n/exit\n'), /子の起動は無効/);
  fs.writeFileSync(path.join(f.home, 'config.json'), '{broken');
  const output = f.run([], '/agents\n/connect fixed/scripted\nwork\nn\nn\nn\n/exit\n');
  assert.match(output, /子の起動は無効/);
  assert.match(output, /応答終了/);
});

test('bare startup can select a worker, approve its edits and collect its result', t => {
  const f = sandbox(t);
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ permissions: 'none' }));
  const output = f.run([], '/connect fixed/scripted\n/agents run\n2\nImplement fixture\ny\ny\ny\n/exit\n');
  assert.match(output, /子の実行結果: ok/);
  assert.match(output, /modkh-worker \/ /);
  assert.match(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), /固定応答モデルによる追記/);
  assert.equal(fs.readFileSync(path.join(f.root, 'marker.txt'), 'utf8').trim(), '実行マーカー');
});

test('Ctrl+C at child approval returns to input without applying the edit', async t => {
  const f = sandbox(t);
  // Stop during an approval prompt is the subject here, so use the policy that always prompts.
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ permissions: 'none' }));
  const child = spawn(process.execPath, [entry, '--model', 'fixed/scripted'], { cwd: f.root, env: { ...process.env, MODKH_HOME: f.home, MODKH_PLAIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    child.stdin.write('/agents run modkh-worker Implement\n');
    assert.equal(await exited, 0, stderr || stdout);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  assert.equal(stopped, true, stdout);
  assert.equal(returned, true, stdout);
  assert.match(stdout, /プロバイダー選択/);
  assert.equal(fs.readFileSync(path.join(f.root, 'README.md'), 'utf8'), '# modkh サンプル\n');
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
  const removal = spawnSync(process.execPath, [entry, 'plugin', 'remove', 'failed-external'], { cwd: f.root, encoding: 'utf8', env: { ...process.env, MODKH_HOME: f.home }, timeout: 10000 });
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
  const child = spawn(process.execPath, [entry], { cwd: f.root, env: { ...process.env, MODKH_HOME: f.home, MODKH_PLAIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
