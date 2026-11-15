import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

async function cli(home: string, input: string): Promise<{ output: string; code: number | null }> {
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', project], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const code = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdin.end(input);
  try {
    const exitCode = await code;
    // 'close' fires before the last stdout chunk is necessarily flushed to the listener.
    await new Promise<void>(resolve => setImmediate(resolve));
    return { output, code: exitCode };
  }
  finally { clearTimeout(timer); child.kill('SIGKILL'); }
}

test('/allow shows and changes the policy, and --save writes the config', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-allow-'));
  try {
    const shown = await cli(home, '/allow\n/exit\n');
    assert.equal(shown.code, 0, shown.output);
    assert.match(shown.output, /workspace — ワークスペース内は自動/);
    assert.match(shown.output, /all \| workspace \| none/);

    const changed = await cli(home, '/allow all\n/allow\n/exit\n');
    assert.equal(changed.code, 0, changed.output);
    assert.match(changed.output, /all — 承認を求めず自動実行/);

    const invalid = await cli(home, '/allow read-only\n/allow\n/exit\n');
    assert.match(invalid.output, /使い方: \/allow/);
    // An invalid value must not change the current policy.
    assert.match(invalid.output, /workspace — ワークスペース内は自動/);

    const saved = await cli(home, '/allow none --save\n/exit\n');
    assert.equal(saved.code, 0, saved.output);
    assert.match(saved.output, /設定に保存/);
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(config.permissions, 'none');

    // A fresh process picks the saved policy up.
    const reused = await cli(home, '/allow\n/exit\n');
    assert.match(reused.output, /none — 読み取り以外は毎回確認/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an invalid saved policy falls back to workspace with a diagnostic', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-allow-bad-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ permissions: 'readonly' }));
    const { output, code } = await cli(home, '/allow\n/exit\n');
    assert.equal(code, 0, output);
    assert.match(output, /permissions が不正なため workspace/);
    assert.match(output, /workspace — ワークスペース内は自動/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
