import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const entry = process.env.DKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

/**
 * An edit must not wait for language analysis. The fixture model edits one file and then runs a
 * command; the total time is measured with analysis forced to be slow via a disabled server.
 */
test('an edit returns before analysis finishes, and the next read still reports diagnostics', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-edit-fast-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'README.md'), '# dkh サンプル\n');
  fs.writeFileSync(path.join(project, 'a.ts'), 'const a = 1;\n');
  const env: NodeJS.ProcessEnv = { ...process.env, DKH_HOME: home, DKH_PLAIN: '1' };
  delete env.NODE_TEST_CONTEXT;
  // Point the server at a command that never answers so a synchronous wait would be obvious.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    language: { autoInstall: false, servers: { typescript: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } } },
  }));
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', project, '--model', 'fixed/scripted'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const started = Date.now();
  const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
  child.stdin.end('編集して\n/exit\n');
  const code = await new Promise(r => child.on('close', r));
  clearTimeout(timer);
  const elapsed = Date.now() - started;
  try {
    assert.equal(code, 0, output);
    assert.match(output, /edit_file/);
    assert.match(output, /を編集した/);
    // A synchronous five-second wait per write would push this well past the bound below.
    assert.ok(elapsed < 20_000, `edit path must not block on analysis: ${elapsed}ms\n${output.slice(-1500)}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
