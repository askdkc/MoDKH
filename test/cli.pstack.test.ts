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
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', project, '--model', 'fixed/scripted'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }
}

test('/pstack reports, toggles, and rejects an unknown mode', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-pstack-'));
  try {
    const shown = await cli(home, '/pstack\n/exit\n');
    assert.equal(shown.code, 0, shown.output);
    assert.match(shown.output, /pstack: off（依頼文の pstack・poteto-mode で選択）/);
    assert.match(shown.output, /切り替え: \/pstack on \| \/pstack off/);

    const toggled = await cli(home, '/pstack on\n/pstack\n/pstack off\n/pstack\n/exit\n');
    assert.equal(toggled.code, 0, toggled.output);
    assert.match(toggled.output, /pstack: on（毎ターン注入）/);
    assert.match(toggled.output, /pstack: off（依頼文の pstack・poteto-mode で選択）/);

    const invalid = await cli(home, '/pstack sideways\n/pstack\n/exit\n');
    assert.match(invalid.output, /使い方: \/pstack on\|off/);
    // An invalid mode must leave the state alone.
    assert.match(invalid.output, /pstack: off（依頼文の pstack・poteto-mode で選択）/);

    // An unknown flag must not change the state either.
    const badFlag = await cli(home, '/pstack on --keep\n/pstack\n/exit\n');
    assert.match(badFlag.output, /使い方: \/pstack on\|off \[--save\]/);
    assert.match(badFlag.output, /pstack: off（依頼文の pstack・poteto-mode で選択）/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('/pstack on --save survives a restart, and off --save clears it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-pstack-save-'));
  try {
    const saved = await cli(home, '/pstack on --save\n/exit\n');
    assert.equal(saved.code, 0, saved.output);
    assert.match(saved.output, /設定に保存しました/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).pstack, true);

    // A fresh process starts with the workflow already on, with no keyword in the request.
    const restored = await cli(home, 'バグを修正して\n/exit\n');
    assert.match(restored.output, /参考手順: [^\n]*pstack/);

    const cleared = await cli(home, '/pstack off --save\n/exit\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).pstack, false);
    const after = await cli(home, 'バグを修正して\n/exit\n');
    assert.doesNotMatch(after.output, /参考手順: [^\n]*pstack/);
    assert.equal(cleared.code, 0, cleared.output);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('/pstack on injects without a keyword, and off drops it again', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-pstack-inject-'));
  try {
    const on = await cli(home, '/pstack on\nバグを修正して\n/exit\n');
    assert.equal(on.code, 0, on.output);
    assert.match(on.output, /参考手順: .*pstack/);

    const off = await cli(home, '/pstack on\nバグを修正して\n/pstack off\n続けて\n/exit\n');
    assert.equal(off.code, 0, off.output);
    const notices = [...off.output.matchAll(/参考手順: ([^\n]*)/g)].map(match => match[1]!);
    assert.equal(notices.length, 2, off.output);
    assert.match(notices[0]!, /pstack/);
    assert.doesNotMatch(notices[1]!, /pstack/);
    // Switching off must not disturb guidance the session already paid for.
    assert.match(notices[1]!, /kiokuko-soul/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
