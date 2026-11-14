import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, updateConfig, DEFAULT_CONFIG } from '../src/cli/config.ts';

// 同一プロセスで2回読む: ENOENT時の既定値は共有オブジェクトとして書き換わってはいけない。
// 起動直後に /connect が保存したモデルが、別セッションの空の設定ディレクトリへ漏えいしない。
test('loadConfig never returns a shared default object that a later update mutates', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-config-'));
  const previous = process.env.DKH_HOME;
  process.env.DKH_HOME = home;
  try {
    const first = loadConfig();
    updateConfig((c) => { c.model = 'fixed/scripted'; });
    // 保存済み設定を消して「設定なし」で読み直す(別セッションの初期状態に相当)。
    fs.rmSync(path.join(home, 'config.json'), { force: true });
    const second = loadConfig();
    assert.equal(second.model ?? undefined, undefined,
      'a saved model from one run must not leak into another run with an empty config dir');
    assert.deepEqual(DEFAULT_CONFIG, { memory: { enabled: false, command: 'kiokuko', args: ['mcp', '--profile', 'chatgpt-memory'] } },
      'the module default stays untouched');
    assert.equal(first.model ?? undefined, undefined);
  } finally {
    if (previous === undefined) delete process.env.DKH_HOME; else process.env.DKH_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
