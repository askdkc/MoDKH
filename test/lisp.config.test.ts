import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadLispConfiguration, REQUIRED_SKILLS } from '../src/lisp/config.ts';
import { routeIntent, routeRole } from '../src/lisp/routing.ts';
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
  ['empty head instruction', '(set-head-instruction "   ")'],
  ['oversized head instruction', '(set-head-instruction (make-string 8193 :initial-element #\\a))'],
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
test('formal preset configures the head workflow and registers both checkers', async () => {
  const config = await load(fs.readFileSync(new URL('../experiments/presets/formal.lisp', import.meta.url), 'utf8'));
  assert.match(config.headInstruction ?? '', /MoA/);
  assert.match(config.headInstruction ?? '', /start_subagent/);
  assert.deepEqual(config.entries.map(({ descriptor }) => descriptor.id).sort(), ['micro-goki', 'micro-zenki']);
});

test('the combined language roster composes with the Enno-Oduno formal preset', async () => {
  const preset = (name: string) => fs.readFileSync(new URL(`../experiments/presets/${name}.lisp`, import.meta.url), 'utf8');
  const config = await load(preset('formal') + '\n' + preset('language-microagents'));
  assert.match(config.headInstruction ?? '', /役小角/);
  assert.equal(config.entries.length, 37);
  const manager = new PluginManager('/does-not-exist');
  manager.registerSessionDefinitions(config.entries, config.digest);
  const available = manager.discover().registry.list().filter(role => role.enabled);
  assert.equal(routeRole('ts', 'outline', 'Inspect src/app.ts', available)?.pluginId, 'micro-ts-outline');
  assert.equal(routeRole('ts', 'syntax-search', 'Find reserve in src/app.ts', available)?.pluginId, 'micro-ts-syntax-search');
  assert.equal(routeIntent('src/app.ts の reserve を宣言検索', available)?.pluginId, 'micro-ts-syntax-search');
  assert.deepEqual(config.entries.find(entry => entry.descriptor.id === 'micro-ts-syntax-search')?.definition.tools,
    ['code_syntax_search']);
  assert.equal(routeRole('svelte', 'syntax-search', 'Find reserve in App.svelte', available), undefined);
  assert.equal(routeRole('tailwindcss', 'hover', 'Inspect utility', available)?.pluginId, 'micro-tailwindcss-hover');
  const outline = config.entries.find(entry => entry.descriptor.id === 'micro-ts-outline')!;
  assert.equal(outline.descriptor.title, 'TypeScript構造担当');
  assert.equal(outline.definition.maxTurns, 30);
  for (const entry of config.entries) {
    assert.equal(entry.definition.tools.length, 1);
    assert.ok(entry.definition.tools[0].startsWith('code_') || entry.definition.tools[0].startsWith('verify_'));
  }
});
