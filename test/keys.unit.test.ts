import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { keysPath, loadSavedKeys, saveKey, removeKey, savedKeyProviders, resolveApiKey } from '../src/cli/keys.ts';

test('saving a key is atomic, owner-only and never returns the secret through help text', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-keys-unit-'));
  const previous = process.env['DKH_HOME'];
  process.env['DKH_HOME'] = home;
  try {
    const result = saveKey('openrouter', '  sk-or-secret  ');
    assert.equal(result.provider, 'openrouter');
    assert.equal(keysPath(), path.join(home, 'keys.json'));
    const stat = fs.statSync(keysPath());
    assert.equal(stat.mode & 0o077, 0, 'no group or world permission');
    assert.equal(stat.mode & 0o400, 0o400, 'owner can read');
    assert.deepEqual(loadSavedKeys(), { openrouter: 'sk-or-secret' });
    assert.deepEqual(savedKeyProviders(), ['openrouter']);
    // Environment wins over a stale saved value.
    assert.equal(resolveApiKey('openrouter', { OPENROUTER_API_KEY: 'from-env' }, 'OPENROUTER_API_KEY'), 'from-env');
    assert.equal(resolveApiKey('openrouter', {}, 'OPENROUTER_API_KEY'), 'sk-or-secret');
    assert.equal(removeKey('openrouter'), true);
    assert.equal(removeKey('openrouter'), false, 'removing twice is not an effect');
    assert.deepEqual(loadSavedKeys(), {});
  } finally {
    if (previous === undefined) delete process.env['DKH_HOME']; else process.env['DKH_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('malformed keys and providers are rejected without writing a file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-keys-bad-'));
  const previous = process.env['DKH_HOME'];
  process.env['DKH_HOME'] = home;
  try {
    for (const provider of ['../escape', 'Bad Name', '', 'a'.repeat(65)]) {
      assert.throws(() => saveKey(provider, 'key'), /プロバイダー名/);
    }
    for (const key of ['', '   ', 'a\nb', 'x'.repeat(4097)]) {
      assert.throws(() => saveKey('openai', key), /APIキー/);
    }
    assert.equal(fs.existsSync(keysPath()), false, 'nothing is written for invalid input');
    // A corrupt file yields no keys rather than a crash or a partial identity.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(keysPath(), '{not json');
    assert.deepEqual(loadSavedKeys(), {});
    fs.writeFileSync(keysPath(), JSON.stringify({ openai: 'ok', broken: 42, '../x': 'y' }));
    assert.deepEqual(loadSavedKeys(), { openai: 'ok' });
  } finally {
    if (previous === undefined) delete process.env['DKH_HOME']; else process.env['DKH_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a key saved by /connect is reused on the next launch without prompting', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-keys-reuse-'));
  const previous = process.env['DKH_HOME'];
  process.env['DKH_HOME'] = home;
  try {
    saveKey('ollama-cloud', 'saved-cloud-key');
    // A fresh process reads the file rather than an in-memory session map.
    const script = `
      import { loadSavedKeys, resolveApiKey } from '${new URL('../src/cli/keys.ts', import.meta.url).pathname}';
      process.stdout.write(JSON.stringify({ keys: Object.keys(loadSavedKeys()), value: resolveApiKey('ollama-cloud') }));
    `;
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, DKH_HOME: home }, timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { keys: ['ollama-cloud'], value: 'saved-cloud-key' });
  } finally {
    if (previous === undefined) delete process.env['DKH_HOME']; else process.env['DKH_HOME'] = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
