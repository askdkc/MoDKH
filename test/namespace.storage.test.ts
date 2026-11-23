import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configDir, loadConfig, saveConfig, defaultConfig } from '../src/cli/config.ts';
import { defaultSessionDir, SessionStore } from '../src/session/store.ts';
import { chatGptAuthPath, hasChatGptConnection, markChatGptConnected } from '../src/model/chatgpt/tokens.ts';
import { workspaceRecordPath } from '../src/session/workspace.ts';
import { languageHome } from '../src/language/detect.ts';

test('MoDKH storage ignores legacy DKH settings and credentials and leaves legacy data untouched', () => {
  const base = path.resolve('.dkh-feasibility'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'namespace-'));
  const old = { MODKH_HOME: process.env.MODKH_HOME, DKH_HOME: process.env.DKH_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  try {
    delete process.env.MODKH_HOME;
    process.env.XDG_CONFIG_HOME = root;
    process.env.DKH_HOME = path.join(root, 'dkh');
    fs.mkdirSync(process.env.DKH_HOME);
    const legacyConfig = '{"model":"legacy/private-model"}';
    const legacyToken = '{"accessToken":"legacy-secret"}';
    fs.writeFileSync(path.join(process.env.DKH_HOME, 'config.json'), legacyConfig);
    fs.writeFileSync(path.join(process.env.DKH_HOME, 'chatgpt-auth.json'), legacyToken);
    const home = path.join(root, 'modkh');
    assert.equal(configDir(), home);
    assert.equal(defaultSessionDir(), path.join(home, 'sessions'));
    assert.equal(chatGptAuthPath(), path.join(home, 'chatgpt-auth.json'));
    assert.equal(languageHome(), path.join(home, 'language'));
    assert.equal(loadConfig().model, undefined);
    assert.equal(hasChatGptConnection(), false);
    saveConfig(defaultConfig());
    markChatGptConnected();
    new SessionStore().create(root, 'fixed/scripted');
    assert.equal(fs.readFileSync(path.join(process.env.DKH_HOME, 'config.json'), 'utf8'), legacyConfig);
    assert.equal(fs.readFileSync(path.join(process.env.DKH_HOME, 'chatgpt-auth.json'), 'utf8'), legacyToken);
    assert.deepEqual(fs.readdirSync(process.env.DKH_HOME).sort(), ['chatgpt-auth.json', 'config.json']);
    assert.equal(workspaceRecordPath(root, 'session'), path.join(root, '.modkh/sessions/session.md'));
    process.env.MODKH_HOME = path.join(root, 'custom');
    assert.equal(configDir(), process.env.MODKH_HOME);
    assert.equal(defaultSessionDir(), path.join(process.env.MODKH_HOME, 'sessions'));
    assert.equal(chatGptAuthPath(), path.join(process.env.MODKH_HOME, 'chatgpt-auth.json'));
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
