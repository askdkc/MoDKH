import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveKey, resolveApiKey, loadSavedKeys, removeKey, canonicalKeyProvider } from '../src/cli/keys.ts';
import { providerKeyEnv } from '../src/model/factory.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-keys-alias-'));
const previous = process.env['MODKH_HOME'];
process.env['MODKH_HOME'] = home;
test.after(() => {
  if (previous === undefined) delete process.env['MODKH_HOME']; else process.env['MODKH_HOME'] = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

test('OpenCode Zen and Go share one stored key', () => {
  assert.equal(canonicalKeyProvider('opencode-go'), 'opencode');
  assert.equal(canonicalKeyProvider('opencode'), 'opencode');
  saveKey('opencode', 'sk-zen-go');
  assert.deepEqual(loadSavedKeys(), { opencode: 'sk-zen-go' }, 'the alias is stored under the representative name');
  // どちらの接続先も同じキーで解決できる。
  assert.equal(resolveApiKey('opencode'), 'sk-zen-go');
  assert.equal(resolveApiKey('opencode-go'), 'sk-zen-go');
  // 環境変数は保存値より優先する(Zen/Go で同じ変数名)。
  assert.equal(resolveApiKey('opencode-go', { OPENCODE_API_KEY: 'from-env' }, 'OPENCODE_API_KEY'), 'from-env');
  assert.equal(providerKeyEnv('opencode-go'), 'OPENCODE_API_KEY');
  assert.equal(providerKeyEnv('opencode'), 'OPENCODE_API_KEY');
  assert.equal(removeKey('opencode-go'), true, 'removing through the alias removes the shared key');
  assert.equal(resolveApiKey('opencode'), undefined);
});

test('a key stored under the alias is still resolved for the representative provider', () => {
  // 旧版が別名で保存していた場合も読み替える(キー入力のやり直しを求めない)。
  fs.writeFileSync(path.join(home, 'keys.json'), JSON.stringify({ 'opencode-go': 'sk-legacy' }));
  assert.equal(resolveApiKey('opencode'), 'sk-legacy');
  assert.equal(resolveApiKey('opencode-go'), 'sk-legacy');
  fs.rmSync(path.join(home, 'keys.json'), { force: true });
});
