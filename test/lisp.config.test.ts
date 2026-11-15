import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadLispConfiguration, REQUIRED_SKILLS } from '../src/lisp/config.ts';
import { temporaryDirectory, sha256, executeBounded, privateEnvironment } from '../src/lisp/runtime.ts';
import { readBundledSkill } from '../src/agent/bundled-skills.ts';
import { PluginManager } from '../src/plugins/manager.ts';
async function load(source: string, timeoutMs?: number) {
  const dir = temporaryDirectory('modkh-config-test-');
  try { const file = path.join(dir, 'agents.lisp'); fs.writeFileSync(file, source); return await loadLispConfiguration(file, sha256(source), { timeoutMs }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const role = '(defmicroagent micro-test :tool "code_outline" :instruction "Inspect source")';
test('real Lisp conditions, loop and registry management; full skills and session isolation', async () => {
  const config = await load(`(in-package :modkh) (format t "not protocol") (when (= 2 (+ 1 1)) ${role}) (register-agent "micro-remove" :tool "code_hover" :instruction "x") (remove-agent "micro-remove") (register-agent "micro-disabled" :tool "code_hover" :instruction "x") (disable-agent "micro-disabled") (assert (= 2 (length (list-agents))))`);
  assert.equal(config.entries.length, 2);
  assert.equal(config.entries[1].descriptor.enabled, false);
  for (const name of REQUIRED_SKILLS) assert.ok(config.entries[0].definition.system.includes(readBundledSkill(name, 'SKILL.md', false)));
  const manager = new PluginManager('/does-not-exist'); manager.registerSessionDefinitions(config.entries, config.digest);
  config.entries[0].descriptor.title = 'mutated';
  assert.notEqual(manager.discover().registry.get('micro-test')!.title, 'mutated');
  assert.equal(manager.discover().registry.list().some(d=>d.id==='modkh-worker'), false);
  const lease = await manager.acquire('micro-test', config.digest);
  const first = (lease.module.define as () => {tools: string[]})(); first.tools.push('run_command');
  assert.deepEqual((lease.module.define as () => {tools: string[]})().tools, ['code_outline']);
});
test('hash mismatch never evaluates code', async () => {
  const dir = temporaryDirectory('modkh-trust-test-');
  try { const file=path.join(dir,'x.lisp');fs.writeFileSync(file,'(error "EVALUATED")');await assert.rejects(loadLispConfiguration(file,'0'.repeat(64)), /digest mismatch/); }
  finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
for (const [label, source] of [
  ['duplicate', `${role} ${role}`], ['unknown field', '(register-agent "micro-x" :bogus t)'],
  ['unknown tool', '(register-agent "micro-x" :tool "run_command" :instruction "x")'],
  ['max turns', '(register-agent "micro-x" :tool "code_outline" :instruction "x" :max-turns 33)'],
  ['too many', '(loop for n below 65 do (register-agent (format nil "micro-~d" n) :tool "code_outline" :instruction "x"))'],
]) test(`rejects ${label} without partial registration`, async () => { await assert.rejects(load(`(in-package :modkh) ${source}`)); });
test('timeout and output limit are never success; minimal environment excludes secrets', async () => {
  await assert.rejects(load('(loop)', 100), /timed-out/);
  const dir = temporaryDirectory('modkh-process-test-');
  try {
    const r = await executeBounded(process.execPath,['-e','console.log(process.env.OPENAI_API_KEY ?? "absent")'],{cwd:dir,env:privateEnvironment(dir),inputDigest:'test',timeoutMs:1000});
    assert.equal(r.state,'exited');assert.equal(r.stdout.trim(),'absent');
    const flood = await executeBounded(process.execPath,['-e','console.log("x".repeat(10000))'],{cwd:dir,env:privateEnvironment(dir),inputDigest:'test',timeoutMs:1000,maxOutputBytes:100});
    assert.equal(flood.state,'output-limit');assert.ok(flood.stdout.length<=100);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('all eight presets evaluate in real SBCL; 30 observers plus 8 disabled editors', async () => {
  const languages=['php','common-lisp','js','ts','svelte','tailwindcss','html','css'];
  const configs=await Promise.all(languages.map(async lang => {
    const file=new URL(`../experiments/presets/${lang}.lisp`,import.meta.url);
    return load(fs.readFileSync(file,'utf8'));
  }));
  const roles=configs.flatMap(c=>c.entries);assert.equal(roles.length,38);assert.equal(roles.filter(r=>r.descriptor.enabled).length,30);
  const enabled=await load(fs.readFileSync(new URL('../experiments/presets/ts.lisp',import.meta.url),'utf8')+'\n(set-agent-check "micro-ts-edit" "node --test test/addition.test.mjs" :sources \'("src/addition.mjs") :protected \'("test/addition.test.mjs"))');
  assert.equal(enabled.entries.find(e=>e.descriptor.id==='micro-ts-edit')!.descriptor.enabled,true);
});
