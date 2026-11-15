import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, updateConfig, parseTimeoutMs, configPath, TIMEOUT_MS_MIN, TIMEOUT_MS_MAX } from '../src/cli/config.ts';

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-config-'));
}

test('config keeps the last model/reasoning/timeoutMs fields through load and save', () => {
  const home0 = home();
  const previous = process.env.MODKH_HOME;
  process.env.MODKH_HOME = home0;
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
    if (previous === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = previous;
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
  const previous = process.env.MODKH_HOME;
  process.env.MODKH_HOME = home2;
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
    if (previous === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = previous;
  }
});

test('a truncated config still yields the last model, so the next launch is not unconnected', () => {
  const home3 = home();
  const previous = process.env.MODKH_HOME;
  process.env.MODKH_HOME = home3;
  try {
    fs.mkdirSync(home3, { recursive: true });
    // 強制終了・電源断で書き込みが途中になった状態。モデル指定だけは救出する。
    fs.writeFileSync(configPath(), '{\n  "model": "ollama-cloud/deepseek-flash",\n  "reason');
    const loaded = loadConfig();
    assert.equal(loaded.model, 'ollama-cloud/deepseek-flash', 'the saved model survives a broken file');
    assert.equal(loaded.diagnostics?.length, 1, 'the breakage is reported instead of hidden');
    assert.equal(fs.readFileSync(`${configPath()}.broken`, 'utf8').includes('deepseek-flash'), true,
      'the broken content is kept for inspection instead of being destroyed');
    // 無関係な保存が救出したモデルを消さない。
    updateConfig((c) => { c.reasoning = 'low'; });
    const after = loadConfig();
    assert.equal(after.model, 'ollama-cloud/deepseek-flash');
    assert.equal(after.reasoning, 'low');
  } finally {
    fs.rmSync(home3, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = previous;
  }
});

test('saving keeps hand-written keys and never leaves a partial file behind', () => {
  const home4 = home();
  const previous = process.env.MODKH_HOME;
  process.env.MODKH_HOME = home4;
  try {
    fs.mkdirSync(home4, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ model: 'ollama-cloud/keep-me', theme: 'dark', myOwn: 42 }));
    updateConfig((c) => { c.model = 'ollama-cloud/kept'; });
    const onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    assert.equal(onDisk.model, 'ollama-cloud/kept');
    assert.equal(onDisk.theme, 'dark', 'unknown keys written by hand are not dropped');
    assert.equal(onDisk.myOwn, 42);
    assert.deepEqual(fs.readdirSync(home4).filter(name => name.endsWith('.tmp')), [],
      'the temporary file is renamed into place, not left next to the config');
    assert.doesNotMatch(fs.readFileSync(configPath(), 'utf8'), /"diagnostics"/,
      'derived diagnostics are not persisted as settings');
  } finally {
    fs.rmSync(home4, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = previous;
  }
});
