import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SessionStore } from '../src/session/store.ts';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
async function launch(home: string, args: string[], input = '/exit\n') {
  const child = spawn(process.execPath, [...(fs.existsSync(path.join(home, 'transport.mjs')) ? ['--import', path.join(home, 'transport.mjs')] : []), entry, '--cwd', home, ...args], {
    env: { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.stdin.end(input);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, output); return output;
  } finally { clearTimeout(timer); }
}

test('saved demo never runs on ordinary startup or overwrites the real connection', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-demo-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'fixed/scripted' }));
  const out = await launch(home, [], 'fix the requested bug\n/exit\n');
  assert.doesNotMatch(out, /▶ list_files|▶ edit_file|▶ run_command/);
  assert.equal(fs.existsSync(path.join(home, 'marker.txt')), false);
  assert.match(out, /未接続/);
  const real = { model: 'compatible/real', modelBaseUrl: 'http://127.0.0.1:1/v1' };
  fs.writeFileSync(file, JSON.stringify(real));
  await launch(home, ['--model', 'fixed/scripted']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), real);
  await launch(home, [], '/connect fixed/scripted\n/exit\n');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, real.model);
});

test('restored URL, config updates and resumed session retain the actual connection across launches', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-restore-flow-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Exercise the public CLI and real SDK with an in-process SSE transport (no listening socket).
  fs.writeFileSync(path.join(home, 'transport.mjs'), `
    import fs from 'node:fs'; import path from 'node:path';
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      fs.appendFileSync(path.join(process.env.MODKH_HOME, 'requests.jsonl'), JSON.stringify({url, ...body}) + '\\n');
      return new Response('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: { content: 'answer to ' + body.messages.at(-1).content }, finish_reason: 'stop' }] })
        + '\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
    };
  `);
  const url = 'https://fixture.invalid/v1';
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'compatible/original', modelBaseUrl: url }));
  await launch(home, [], 'first request\n/exit\n');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).modelBaseUrl, url);
  await launch(home, [], `/connect compatible/selected --base-url ${url}\n/allow all --save\nsecond request\n/exit\n`);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.model, 'compatible/selected'); assert.equal(config.modelBaseUrl, url);
  const store = new SessionStore(path.join(home, 'sessions'));
  const saved = store.list()[0];
  assert.equal(saved.model, 'compatible/selected');
  fs.writeFileSync(file, JSON.stringify({ model: 'compatible/different', modelBaseUrl: url }));
  await launch(home, ['--resume', saved.id], 'continue this request\n/exit\n');
  const requests = fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) as {url: string; model: string; messages: {role: string; content: string}[]}[];
  assert.ok(requests.every(r => r.url === url + '/chat/completions'));
  assert.deepEqual(requests.map(r => r.model), ['original', 'selected', 'selected']);
  assert.ok(requests[2].messages.some(m => m.role === 'user' && m.content === 'second request'));
});

test('CLI passes the request and tool failures back to the model, applies the repair and runs verification', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-request-flow-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'value.txt'), 'before');
  fs.writeFileSync(path.join(home, 'verify.mjs'), `import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(fs.readFileSync('value.txt', 'utf8'), 'after'); console.log('VERIFIED_ACTUAL_FILE');`);
  fs.writeFileSync(path.join(home, 'transport.mjs'), `
    import fs from 'node:fs'; import path from 'node:path';
    const home = process.env.MODKH_HOME;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const outputs = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      if (!body.messages.some(m => m.role === 'user' && m.content === 'change value to after and verify')) throw Error('lost user request');
      fs.appendFileSync(path.join(home, 'requests.jsonl'), JSON.stringify(body) + '\\n');
      const calls = [
        ['edit_file', {path:'value.txt',old_string:'wrong assumption',new_string:'after'}],
        ['read_file', {path:'value.txt'}],
        ['edit_file', {path:'value.txt',old_string:'before',new_string:'after'}],
        ['run_command', {command: JSON.stringify(process.execPath) + ' verify.mjs'}],
      ];
      if (outputs.length >= 1 && outputs[0].status !== 'error') throw Error('lost failed edit');
      if (outputs.length >= 4 && !outputs[3].output.includes('VERIFIED_ACTUAL_FILE')) throw Error('verification failed');
      const next = calls[outputs.length];
      const delta = next ? {tool_calls:[{index:0,id:'step-' + outputs.length,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}]}
        : {content:'Verified the requested change.'};
      return new Response('data: ' + JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,
        choices:[{index:0,delta,finish_reason:next?'tool_calls':'stop'}]}) + '\\n\\ndata: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
    };
  `);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ model: 'compatible/request-aware-fixture', modelBaseUrl: 'https://fixture.invalid/v1', language: { enabled: false } }));
  const output = await launch(home, [], 'change value to after and verify\n/exit\n');
  assert.equal(fs.readFileSync(path.join(home, 'value.txt'), 'utf8'), 'after');
  assert.match(output, /MATCH_MISSING/);
  assert.match(output, /VERIFIED_ACTUAL_FILE/, 'command stdout must be visible, not only its exit code');
  assert.match(output, /Verified the requested change/);
  assert.equal(fs.existsSync(path.join(home, 'marker.txt')), false);
  const store = new SessionStore(path.join(home, 'sessions'));
  const session = store.load(store.list()[0].id);
  assert.equal(session.status, 'complete');
  assert.equal(session.messages.filter(m => m.role === 'tool').length, 4);
});

test('public interactive startup omits the redundant session instructions', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-startup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'transport.mjs'), `
    delete process.env.MODKH_PLAIN;
    process.env.TERM = 'xterm-256color';
    process.stdin.isTTY = true;
    process.stdin.setRawMode = raw => { process.stdin.isRaw = raw; return process.stdin; };
    process.stdout.isTTY = true; process.stdout.columns = 160; process.stdout.rows = 48;
    const write = process.stdout.write.bind(process.stdout);
    let exiting = false;
    process.stdout.write = function(chunk, ...args) {
      const result = write(chunk, ...args);
      if (!exiting && String(chunk).includes('何を調べますか')) {
        exiting = true;
        queueMicrotask(() => {
          process.stdin.emit('keypress', '/exit', {});
          process.stdin.emit('keypress', '', { name: 'return' });
        });
      }
      return result;
    };
  `);
  const output = await launch(home, [], '');
  assert.match(output, /何を調べますか/);
  assert.doesNotMatch(output, /を開始します|入力してください|\/connect で認証/);
});
