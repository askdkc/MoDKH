import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SessionStore } from '../src/session/store.ts';
import { languageTools } from '../src/tools/language.ts';
import { LanguageService } from '../src/language/lsp/service.ts';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';

const fixtureLsp = new URL('./fixtures/fake-lsp.mjs', import.meta.url).pathname;

/**
 * The public CLI with a real auto-install is exercised by scripts/acceptance.sh against an offline
 * registry mirror. These tests use the deterministic fixture server for the automatic path.
 */
for (const mode of ['clean', 'silent'] as const) {
  test(`read and edit carry analysis automatically without changing the tool result (${mode})`, async () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-auto-')));
    fs.mkdirSync(path.join(project, 'src'));
    fs.writeFileSync(path.join(project, 'tsconfig.json'), '{}');
    const file = path.join(project, 'src', 'app.ts');
    fs.writeFileSync(file, 'BROKEN value\n');
    const service = new LanguageService({
      root: project,
      settings: {
        autoInstall: true, disabled: [], installTimeoutMs: 10_000, requestTimeoutMs: 1500,
        servers: { typescript: { command: process.execPath, args: [fixtureLsp, mode] } },
      },
    });
    const pool = service['pool'] as unknown as { options: Record<string, unknown> };
    void pool;
    const registry = new ToolRegistry(defaultTools());
    const analyze = async (target: string, kind: 'read' | 'write') => {
      const result = await service.analyze(target, fs.readFileSync(target, 'utf8'));
      if (result.status === 'unavailable' && kind === 'read') return null;
      if (result.status === 'unavailable') return null;
      return `解析: ${result.status}。診断${(result.diagnostics ?? []).length}件` + (result.status === 'partial' ? '（未通知）' : '');
    };
    const ctx = { root: project, approval: { approve: async () => true }, signal: new AbortController().signal, analyze };
    try {
      const read = await registry.executeOne({ id: 'r1', name: 'read_file', args: { path: 'src/app.ts' } }, ctx);
      assert.equal(read.status, 'ok');
      assert.match(read.output, /BROKEN value/);
      if (mode === 'clean') assert.match(read.output, /解析: ok/);
      else { assert.match(read.output, /解析: partial/); assert.match(read.output, /未通知|まだ通知/); }

      const edit = await registry.executeOne({
        id: 'e1', name: 'edit_file', args: { path: 'src/app.ts', old_string: 'BROKEN value', new_string: 'const value = 1;' },
      }, ctx);
      assert.equal(edit.status, 'ok', edit.output);
      assert.match(edit.output, /を編集した/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'const value = 1;\n');
      if (mode === 'clean') assert.match(edit.output, /解析: ok。診断0件/);
    } finally { await service.close(); fs.rmSync(project, { recursive: true, force: true }); }
  });
}

test('a broken analysis never fails the edit and never invites a second write', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-broken-analysis-')));
  fs.mkdirSync(path.join(project, 'src'));
  const file = path.join(project, 'src', 'a.ts');
  fs.writeFileSync(file, 'old\n');
  const registry = new ToolRegistry(defaultTools());
  const ctx = {
    root: project,
    approval: { approve: async () => true },
    signal: new AbortController().signal,
    analyze: async () => { throw new Error('アナライザ故障'); },
  };
  try {
    const edit = await registry.executeOne({
      id: 'e1', name: 'edit_file', args: { path: 'src/a.ts', old_string: 'old', new_string: 'new' },
    }, ctx);
    assert.equal(edit.status, 'ok', edit.output);
    assert.match(edit.output, /を編集した/);
    assert.match(edit.output, /解析: 失敗 — アナライザ故障/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'new\n');
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('language tools refuse unsupported files and report a real zero result', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-lang-tools-')));
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'const a = 1;\n');
  fs.writeFileSync(path.join(project, 'notes.txt'), 'text\n');
  const service = new LanguageService({
    root: project,
    settings: {
      autoInstall: false, disabled: [], installTimeoutMs: 1000, requestTimeoutMs: 1500,
      servers: { typescript: { command: process.execPath, args: [fixtureLsp, 'clean'] } },
    },
  });
  const tools = new Map(languageTools(service).map(tool => [tool.name, tool]));
  const ctx = { root: project, approval: { approve: async () => true } };
  try {
    const outline = await tools.get('code_outline')!.execute({ path: 'src/a.ts' }, ctx);
    assert.match(String(outline), /typescript/);
    assert.match(String(outline), /lexical_declaration a/);
    const diagnostics = await tools.get('code_diagnostics')!.execute({ path: 'src/a.ts' }, ctx);
    assert.match(String(diagnostics), /診断0件/);
    await assert.rejects(() => tools.get('code_outline')!.execute({ path: 'notes.txt' }, ctx), /対象外/);
    await assert.rejects(() => tools.get('code_outline')!.execute({ path: '../escape.ts' }, ctx), /ルート外/);
  } finally { await service.close(); fs.rmSync(project, { recursive: true, force: true }); }
});

test('the public CLI wires analysis into read_file without any extra flag', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-auto-cli-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'BROKEN_HEADER\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    language: { autoInstall: false, servers: { typescript: { command: process.execPath, args: [fixtureLsp, 'clean'] } } },
  }));
  const http = await import('node:http');
  let requests = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests++;
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      const hasToolResult = body.messages.some(m => m.role === 'tool');
      const delta = hasToolResult ? { content: 'CLI_SAW_' + body.messages.filter(m => m.role === 'tool').at(-1)!.content.replace(/\n/g, ' ') } : {
        tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.ts"}' } }],
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', project, '--model', 'compatible/fixture', '--base-url', `http://127.0.0.1:${port}/v1`], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdin.end('Read src/app.ts and tell me what the analysis found.\n/exit\n');
  try {
    assert.equal(await exited, 0, output);
    assert.equal(requests, 2, output);
    // The analysis must have reached the model through the ordinary read path.
    assert.match(output, /CLI_SAW.*解析/);
    assert.match(output, /BROKEN_FOUND/);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the CLI starts, exits, and leaves no language server process behind', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-lang-cli-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'const a = 1;\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    language: { autoInstall: false, servers: { typescript: { command: process.execPath, args: [fixtureLsp, 'clean'] } } },
  }));
  const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', project, '--model', 'compatible/none', '--base-url', 'http://127.0.0.1:9/v1'], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  child.stdin.end('/exit\n');
  try {
    assert.equal(await exited, 0, output);
    assert.equal(fs.existsSync(path.join(home, 'language', 'servers')), false, 'autoInstall:false must not install');
    const store = new SessionStore(path.join(home, 'sessions'));
    assert.equal(store.list().length, 1);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
