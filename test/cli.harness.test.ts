import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { SessionStore } from '../src/session/store.ts';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
for (const resume of [false, true]) {
  test(`public CLI researches, edits with approval and runs a real test (${resume ? 'legacy oversized history' : 'ignored replay archive'})`, async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-harness-flow-')));
    const root = path.join(home, 'project'); fs.mkdirSync(root);
    assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test')); fs.mkdirSync(path.join(root, '.agenticreplay'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.agenticreplay/\n');
    fs.writeFileSync(path.join(root, 'src/config.ts'), 'export const reasoning = "off";\n');
    fs.writeFileSync(path.join(root, 'test/config.test.mjs'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('requested setting is enabled',()=>assert.equal(fs.readFileSync('src/config.ts','utf8'),'export const reasoning = "on";\\n'));`);
    fs.writeFileSync(path.join(root, '.agenticreplay/archive.json'), Array(50).fill('reasoning ARCHIVE ' + 'x'.repeat(10000)).join('\n'));
    const store = new SessionStore(path.join(home, 'sessions'));
    const legacy = 'LEGACY_ARCHIVE '.repeat(300000);
    const saved = resume ? store.create(root, 'compatible/fixture') : undefined;
    if (saved) {
      saved.append({ role: 'user', content: 'previous request' });
      saved.append({ role: 'assistant', content: '', toolCalls: [{ id: 'legacy', name: 'search_files', args: { pattern: 'reasoning' } }] });
      saved.append({ role: 'tool', results: [{ callId: 'legacy', name: 'search_files', status: 'ok', output: legacy }] });
      saved.setStatus('error', 'CONTEXT_TOO_LARGE');
    }
    const received: { bytes: number; body: { messages: { role: string; content: string }[] } }[] = [];
    const server = http.createServer((req, res) => {
      let raw = ''; req.on('data', data => { raw += data; });
      req.on('end', () => {
        const body = JSON.parse(raw); received.push({ bytes: Buffer.byteLength(raw), body });
        if (Buffer.byteLength(raw) > 128 * 1024) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"CONTEXT_TOO_LARGE"}}'); return; }
        const step = received.length;
        const calls = step === 1 ? [
          { id: 'list', name: 'list_files', args: {} }, { id: 'search', name: 'search_files', args: { pattern: 'reasoning' } },
        ] : step === 2 ? [{ id: 'read', name: 'read_file', args: { path: 'src/config.ts' } }]
          : step === 3 ? [{ id: 'edit', name: 'edit_file', args: { path: 'src/config.ts', old_string: '"off"', new_string: '"on"' } }]
          : step === 4 ? [{ id: 'test', name: 'run_command', args: { command: `${JSON.stringify(process.execPath)} --test --test-reporter=tap test/config.test.mjs` } }] : [];
        const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }
          : { content: 'Implementation finished; verification output was received.' };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
    // The CLI is an ordinary app, not a nested node:test worker. Keep the real test assertion below.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [entry, 'chat', '--cwd', root, '--model', 'compatible/fixture', '--base-url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, ...(saved ? ['--resume', saved.id] : [])], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    // The default policy is `workspace`: in-root edits and commands run without a prompt,
    // so no `y` answers are supplied and any prompt would hang until the timeout.
    child.stdin.end('Enable the reasoning setting in this project and verify it.\n/exit\n');
    try {
      assert.equal(await exited, 0, output);
      assert.equal(received.length, 5, output);
      assert.ok(received.every(request => request.bytes < 128 * 1024));
      const toolOutputs = received[1].body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      assert.ok(toolOutputs.some(r => r.output.includes('src/config.ts:1:')));
      assert.ok(toolOutputs.every(r => !r.output.includes('reasoning ARCHIVE')));
      assert.equal(fs.readFileSync(path.join(root, 'src/config.ts'), 'utf8'), 'export const reasoning = "on";\n');
      // The default policy approves in-root effects automatically; any prompt would have hung
      // the run because no `y` answers are supplied.
      assert.doesNotMatch(output, /\(自動承認: /, 'tool activity and its results need no separate auto-approval notice');
      assert.doesNotMatch(output, /承認要求/, 'the default policy must not prompt inside the workspace');
      const last = received[4].body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      assert.ok(last.some(r => r.status === 'ok' && r.output.includes('requested setting is enabled') && r.output.includes('# pass 1')), JSON.stringify(last.at(-1)));
      const session = store.load(saved?.id ?? store.list()[0].id);
      assert.equal(session.status, 'complete');
      if (saved) {
        const original = session.messages.find(m => m.role === 'tool' && m.results[0].callId === 'legacy');
        assert.equal(original?.role === 'tool' && original.results[0].output, legacy);
        assert.match(output, /前回のエラー: CONTEXT_TOO_LARGE/);
      }
    } finally {
      clearTimeout(timeout); child.kill('SIGKILL'); await exited.catch(() => {});
      server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
