import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeBounded, privateEnvironment, temporaryDirectory, sha256 } from '../src/lisp/runtime.ts';
import { formalTools } from '../src/tools/formal.ts';
const lean=process.env.MODKH_TEST_LEAN;
const skip=!lean && 'Official Lean executable unavailable; real kernel/counterexample tests not run';

test('real Lean transitive sorry remains unverified even when its consumer is accepted', {skip}, async()=>{
 const root=fs.realpathSync(temporaryDirectory('modkh-lean-import-'));
 try {
  const producer='theorem unfinished : False := by sorry\n';
  const consumer='import Unfinished\ntheorem consumer : False := unfinished\n#print axioms consumer\n';
  fs.writeFileSync(path.join(root,'Unfinished.lean'),producer);fs.writeFileSync(path.join(root,'Consumer.lean'),consumer);
  const run=(args:string[])=>executeBounded(lean!,args,{cwd:root,env:{...privateEnvironment(root),LEAN_PATH:root},timeoutMs:30000,inputDigest:sha256(producer+consumer)});
  const built=await run(['-o','Unfinished.olean','Unfinished.lean']);assert.equal(built.state,'exited');assert.equal(built.exitCode,0,built.stderr);
  const accepted=await run(['-DwarningAsError=true','Consumer.lean']);assert.equal(accepted.exitCode,0,accepted.stderr);assert.match(accepted.stdout,/sorryAx/);
  await assert.rejects(formalTools({lean})[0].execute({path:'Consumer.lean'},{root,approval:{approve:async()=>true}}),/dependency closure/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
for(const [label,source] of [
 ['sorry','theorem unfinished : False := by sorry'],
 ['false theorem','theorem falseGoal : False := by trivial'],
 ['custom axiom','axiom assumption : False\ntheorem falseGoal : False := assumption'],
 ['generated axiom','import Lean\nopen Lean Elab Command in\nrun_elab addDecl (.axiomDecl {name := `fake, levelParams := [], type := mkConst ``False, isUnsafe := false})\ntheorem forged : False := fake'],
]) test(`real Lean ${label} cannot be certified by compiler acceptance`,{skip},async()=>{
 const root=fs.realpathSync(temporaryDirectory('modkh-lean-counterexample-'));
 try {
  fs.writeFileSync(path.join(root,'Input.lean'),source);
  const result=await formalTools({lean})[0].execute({path:'Input.lean'},{root,approval:{approve:async()=>true}});
  assert.notEqual(typeof result,'string');if(typeof result==='string')return;
  assert.equal(result.status,'error');const evidence=JSON.parse(result.output);assert.equal(evidence.proofStatus,'unverified');
  assert.equal(evidence.status,label==='sorry'||label==='false theorem'?'failed':'accepted');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
