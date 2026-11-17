import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = process.env.MODKH_TEST_ENTRY ?? fileURLToPath(new URL('../src/index.ts', import.meta.url));
const chat = process.env.MODKH_TEST_CHAT ?? new URL('../src/cli/chat.ts', import.meta.url).href;
const fixed = process.env.MODKH_TEST_FIXED ?? new URL('../src/model/fixed.ts', import.meta.url).href;
test('install, status and ordinary chat use the installed Stateright front agent', { timeout: 240000 }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-stateright-install-')));
  const env = { ...process.env, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0',
    CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: fileURLToPath(new URL('../native/stateright/target/install-acceptance', import.meta.url)) };
  const run = (args: string[], input?: string) => {
    const result = spawnSync(process.execPath, args, { cwd: root, env, input, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  try {
    assert.match(run([entry, 'stateright', 'install']), /利用可能/);
    assert.match(run([entry, 'stateright', 'status']), /stateright\/bin\/modkh-stateright/);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ permissions: 'all', language: { autoInstall: false } }));
    for (const name of ['good', 'bad']) fs.copyFileSync(new URL(`./fixtures/formal/${name}.json`, import.meta.url), path.join(root, `${name}.json`));
    const step = (id: string, name: string, args: object) => [{ type: 'tool-call', call: { id, name, args } }, { type: 'finish', stopReason: 'tool-calls' }];
    const script = [step('catalog', 'list_subagents', {}), ...['good', 'bad'].map(name => step(name, 'run_subagent', {
      pluginId: 'modkh-micro-zenki', task: `Verify ${name}`, formalInput: { path: `${name}.json` },
    })), [{ type: 'text-delta', text: 'checked' }, { type: 'finish', stopReason: 'stop' }]];
    const harness = `import {runChat} from ${JSON.stringify(chat)};
      import {FixedModel} from ${JSON.stringify(fixed)};
      import fs from 'node:fs';
      const model = new FixedModel(${JSON.stringify(script)});
      await runChat({args:{cwd:${JSON.stringify(root)}, model:'fixed/scripted'},modelFactory:()=>model});
      fs.writeFileSync('requests.json',JSON.stringify(model.requests));`;
    run(['--input-type=module', '-e', harness], '状態モデルを検証してください\n/exit\n');
    const requests = fs.readFileSync(path.join(root, 'requests.json'), 'utf8');
    assert.match(requests, /前鬼（modkh-micro-zenki）が利用可能/);
    const logs = fs.readdirSync(path.join(root, 'sessions')).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(path.join(root, 'sessions', f), 'utf8')).join('\n');
    assert.match(logs, /verify_stateright/);
    assert.match(logs, /passed/);
    assert.match(logs, /failed/);
    assert.match(logs, /counterexample/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
