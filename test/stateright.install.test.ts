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

for (const mode of ['unverified', 'proved', 'rejected', 'zenki-first', 'goki-first'] as const) test('pstack dispatches both formal roles: ' + mode, {
  skip: ['proved', 'rejected'].includes(mode) && !process.env.MODKH_TEST_LEAN && 'Real Lean executable not supplied',
}, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-pstack-formal-')));
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ permissions: 'all', language: { autoInstall: false } }));
    fs.copyFileSync(new URL('./fixtures/formal/good.json', import.meta.url), path.join(root, 'Model.json'));
    fs.writeFileSync(path.join(root, 'Proof.lean'), 'theorem exampleGoal : True := trivial');
    const paired = mode === 'zenki-first' || mode === 'goki-first';
    const compileOnly = mode === 'unverified' || (paired && !process.env.MODKH_TEST_LEAN);
    const proofStatus = compileOnly ? 'unverified' : paired ? 'proved' : mode;
    const lean = compileOnly ? path.join(root, 'lean') : process.env.MODKH_TEST_LEAN!;
    if (compileOnly) fs.writeFileSync(lean, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'Expected.lean'), 'def modkhExpected : Prop := ' + (mode === 'rejected' ? 'False' : 'True'));
    const target = compileOnly ? {} : { 'lean-contract': 'Expected.lean', 'lean-theorem': 'exampleGoal' };
    const stateright = fileURLToPath(new URL('../native/stateright/target/debug/modkh-stateright', import.meta.url));
    const end = [{ type: 'text-delta', text: 'finished' }, { type: 'finish', stopReason: 'stop' }];
    const script = [end, [{ type: 'tool-call', call: { id: 'need', name: 'require_formal_checks',
      args: { model: 'Model.json', lean: 'Proof.lean' } } }, { type: 'finish', stopReason: 'tool-calls' }], end, end, end];
    const pair = ['zenki', 'goki'].map(role => ({ type: 'tool-call', call: { name: 'start_subagent', id: role,
      args: { pluginId: 'modkh-micro-' + role, task: 'Verify input', formalInput: { path: role === 'zenki' ? 'Model.json' : 'Proof.lean' } } } }));
    const steps = paired ? [...script.slice(0, 2), [...(mode === 'goki-first' ? pair.reverse() : pair),
      { type: 'finish', stopReason: 'tool-calls' }], ...script.slice(2), end, end, end] : script;
    const harness = `import {runChat} from ${JSON.stringify(chat)};
      import {FixedModel} from ${JSON.stringify(fixed)};
      const model = new FixedModel(${JSON.stringify(steps)});
      await runChat({args:${JSON.stringify({ cwd: root, model: 'fixed/scripted', lean, stateright, ...target })},modelFactory:()=>model});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness], { cwd: root,
      env: { ...process.env, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0' },
      input: '/pstack on\nFix the typo.\nVerify the queue invariant.\n/exit\n', encoding: 'utf8', timeout: 165000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [ordinary, formal] = result.stdout.split('▶ You: Verify the queue invariant.');
    assert.doesNotMatch(ordinary!, /▶ run_subagent/);
    assert.match(formal!, /modkh-micro-zenki/);
    assert.match(formal!, /modkh-micro-goki/);
    if (proofStatus === 'proved') assert.match(formal!, /形式検証は合格/);
    else {
      assert.match(formal!, mode === 'rejected' ? /形式検証は不合格/ : /未検証|未完了/);
      assert.doesNotMatch(formal!, /形式検証は合格/);
    }
    const logs = fs.readdirSync(path.join(root, 'sessions')).filter(f => f.endsWith('.jsonl'))
      .flatMap(f => fs.readFileSync(path.join(root, 'sessions', f), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    if (paired) {
      const lifecycle = logs.filter(e => e.type === 'delegation' && ['starting', 'finished'].includes(e.record.state))
        .map(e => [e.record.pluginId, e.record.state]);
      assert.deepEqual(lifecycle, ['zenki', 'goki'].flatMap(role => ['starting', 'finished'].map(state => ['modkh-micro-' + role, state])));
    }
    const checks = logs.flatMap(event => event.message?.results ?? []).filter(r => ['verify_stateright', 'verify_lean'].includes(r.name));
    assert.deepEqual(checks.map(r => [r.name, JSON.parse(r.output).proofStatus ?? JSON.parse(r.output).status]).sort(),
      [['verify_lean', proofStatus], ['verify_stateright', 'passed']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
