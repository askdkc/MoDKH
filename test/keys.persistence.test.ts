import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

test('line mode refuses to read a secret and says how to provide it instead', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-keys-plain-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.OPENAI_API_KEY;
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', project], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const code = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdin.end('/connect\n1\n2\n/exit\n');
  try {
    assert.equal(await code, 0, output);
    // The line protocol never accepts a secret; it points at the environment instead.
    assert.match(output, /OPENAI_API_KEY を環境変数に設定して再接続してください/);
    assert.equal(fs.existsSync(path.join(home, 'keys.json')), false, 'nothing may be persisted from line mode');
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
