import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formalTools } from '../src/tools/formal.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';
const approval={approve:async()=>true};
for(const [label,source] of [['empty',''],['true','theorem truth : True := by trivial'],['different goal','theorem wrongGoal : 1 = 1 := rfl'],['sorry','theorem unfinished : False := by sorry'],['generated axiom','import Lean\nopen Lean Elab Command in\nrun_elab addDecl (.axiomDecl {name := `fake, levelParams := [], type := mkConst ``False, isUnsafe := false})\ntheorem forged : False := fake']]) {
  test(`compiler exit0 remains unverified: ${label} (wrapper test with fake compiler)`,async()=>{
    const root=temporaryDirectory('modkh-formal-test-');
    try {
      const compiler=path.join(root,'compiler');
      fs.writeFileSync(compiler,`#!/bin/sh\nprintf 'PROOF_PASSED\\n#print axioms forged: []\\n[exit code: 0]\\n'\nexit 0\n`,{mode:0o700});
      fs.writeFileSync(path.join(root,'Input.lean'),source);
      const r=await formalTools({lean:compiler})[0].execute({path:'Input.lean'},{root:fs.realpathSync(root),approval,signal:new AbortController().signal});
      assert.notEqual(typeof r,'string');if(typeof r==='string')return;
      assert.equal(r.status,'error');const evidence=JSON.parse(r.output);
      assert.equal(evidence.status,'accepted');assert.equal(evidence.proofStatus,'unverified');assert.equal(evidence.code,'PROOF_UNVERIFIED');
      assert.equal(evidence.receipt.exitCode,0);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
}
test('formal missing runtime, denied execution, unsupported local imports and symlinks fail closed',async()=>{
  const root=fs.realpathSync(temporaryDirectory('modkh-formal-boundary-'));
  try {
    fs.writeFileSync(path.join(root,'Input.lean'),'');const ctx={root,approval,signal:new AbortController().signal};
    await assert.rejects(formalTools({})[0].execute({path:'Input.lean'},ctx),/Host must configure/);
    await assert.rejects(formalTools({lean:'/bin/true'})[0].execute({path:'Input.lean'},{...ctx,approval:{approve:async()=>false}}),/approved/);
    fs.writeFileSync(path.join(root,'Input.lean'),'import Local.Unfinished');
    await assert.rejects(formalTools({lean:'/bin/true'})[0].execute({path:'Input.lean'},ctx),/dependency closure/);
    fs.symlinkSync('Input.lean',path.join(root,'Link.lean'));
    await assert.rejects(formalTools({lean:'/bin/true'})[0].execute({path:'Link.lean'},ctx),/symlink/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('real Lean true theorem is accepted/unverified', {skip: !process.env.MODKH_TEST_LEAN && 'Official Lean executable not supplied'},async()=>{
  const root=fs.realpathSync(temporaryDirectory('modkh-real-lean-'));
  try {fs.writeFileSync(path.join(root,'Input.lean'),'theorem truth : True := by trivial');const r=await formalTools({lean:process.env.MODKH_TEST_LEAN})[0].execute({path:'Input.lean'},{root,approval});assert.notEqual(typeof r,'string');if(typeof r==='string')return;assert.equal(JSON.parse(r.output).status,'accepted');assert.equal(r.status,'error');}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('Lean compilation and target comparison have independent process deadlines', async () => {
  const root = fs.realpathSync(temporaryDirectory('modkh-lean-deadlines-'));
  try {
    const lean = path.join(root, 'lean');
    fs.writeFileSync(lean, '#!/bin/sh\nsleep 0.6\nif [ "$1" = "--run" ]; then printf "statement-mismatch\\n"; fi\n', { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'Input.lean'), 'theorem goal : True := trivial');
    fs.writeFileSync(path.join(root, 'Expected.lean'), 'def modkhExpected : Prop := False');
    const result = await formalTools({ lean, leanContract: 'Expected.lean', leanTheorem: 'goal', timeoutMs: 1500 })[0]
      .execute({ path: 'Input.lean' }, { root, approval });
    if (typeof result === 'string') throw new Error(result);
    const evidence = JSON.parse(result.output);
    assert.equal(evidence.status, 'accepted', result.output);
    assert.equal(evidence.code, 'TARGET_STATEMENT_MISMATCH', result.output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
