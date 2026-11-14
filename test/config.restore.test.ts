import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, updateConfig, parseTimeoutMs, configPath, TIMEOUT_MS_MIN, TIMEOUT_MS_MAX } from '../src/cli/config.ts';

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-config-'));
}

test('config keeps the last model/reasoning/timeoutMs fields through load and save', () => {
  const home0 = home();
  const previous = process.env.DKH_HOME;
  process.env.DKH_HOME = home0;
  try {
    const config = {
      memory: { enabled: false, command: 'kiokuko', args: ['mcp', '--profile', 'chatgpt-memory'] },
      model: 'ollama-cloud/glm-test', modelBaseUrl: 'https://example/v1', reasoning: 'low', timeoutMs: 600000,
      permissions: 'workspace', maxTurns: 500,
    };
    saveConfig(config);
    const loaded = loadConfig();
    assert.equal(loaded.model, 'ollama-cloud/glm-test');
    assert.equal(loaded.modelBaseUrl, 'https://example/v1');
    assert.equal(loaded.reasoning, 'low');
    assert.equal(loaded.timeoutMs, 600000);
    assert.equal(loaded.permissions, 'workspace');
    assert.equal(loaded.maxTurns, 500);

    updateConfig((c) => { c.model = 'fixed/scripted'; c.modelBaseUrl = undefined; });
    const reloaded = loadConfig();
    assert.equal(reloaded.model, 'fixed/scripted');
    assert.equal(reloaded.modelBaseUrl, undefined);
    assert.equal(reloaded.reasoning, 'low', 'unrelated fields survive a partial update');
    assert.equal(reloaded.permissions, 'workspace');
  } finally {
    fs.rmSync(home0, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DKH_HOME; else process.env.DKH_HOME = previous;
  }
});

test('timeoutMs accepts only sane integers', () => {
  assert.equal(parseTimeoutMs(600000), 600000);
  assert.equal(parseTimeoutMs(TIMEOUT_MS_MIN), TIMEOUT_MS_MIN);
  assert.equal(parseTimeoutMs(TIMEOUT_MS_MAX), TIMEOUT_MS_MAX);
  assert.equal(parseTimeoutMs(100), null);
  assert.equal(parseTimeoutMs('600000'), null);
  assert.equal(parseTimeoutMs(6000.5), null);
  assert.equal(parseTimeoutMs(true), null);
});

test('a malformed config file falls back to defaults without losing updates', () => {
  const home2 = home();
  const previous = process.env.DKH_HOME;
  process.env.DKH_HOME = home2;
  try {
    fs.mkdirSync(home2, { recursive: true });
    fs.writeFileSync(configPath(), '{ broken');
    assert.equal(loadConfig().timeoutMs, undefined);
    updateConfig((c) => { c.model = 'fixed/scripted'; });
    const fixed = loadConfig();
    // 壊れた設定からの復帰時に memory 初期値が入り、更新したmodelだけが残る
    assert.equal(fixed.model, 'fixed/scripted');
    assert.equal(fixed.memory.enabled, false);
  } finally {
    fs.rmSync(home2, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DKH_HOME; else process.env.DKH_HOME = previous;
  }
});
