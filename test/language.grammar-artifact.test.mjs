import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildGrammars, GRAMMARS } from '../scripts/build-grammars.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const scratch = path.join(repo, '.dkh-feasibility');
fs.mkdirSync(scratch, { recursive: true });
function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, 'grammar-test-'));
  const pkg = path.join(root, 'package'); fs.mkdirSync(path.join(pkg, 'out'), { recursive: true });
  const installed = path.join(repo, 'node_modules/tree-sitter-wasms');
  for (const name of ['package.json','LICENSE']) fs.copyFileSync(path.join(installed,name),path.join(pkg,name));
  for (const id of GRAMMARS) fs.symlinkSync(path.join(installed,'out',`tree-sitter-${id}.wasm`),path.join(pkg,'out',`tree-sitter-${id}.wasm`));
  return { root,pkg,target:path.join(root,'output') };
}

test('grammar build rejects a missing input before publishing a success manifest', () => {
  const f=fixture();
  try {
    fs.unlinkSync(path.join(f.pkg,'out/tree-sitter-typescript.wasm'));
    assert.throws(()=>buildGrammars(f.pkg,f.target), /ENOENT/);
    assert.equal(fs.existsSync(path.join(f.target,'manifest.json')),false);
  } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
});

test('grammar build rejects corrupt WASM and records actual package identity and byte digests', () => {
  const f=fixture();
  try {
    const result=buildGrammars(f.pkg,f.target);
    assert.equal(result.source,`tree-sitter-wasms@${JSON.parse(fs.readFileSync(path.join(f.pkg,'package.json'))).version}`);
    assert.equal(result.grammars.length,12);
    for (const item of result.grammars) assert.match(item.sha256,/^[a-f0-9]{64}$/);
    const bad=path.join(f.pkg,'out/tree-sitter-css.wasm');fs.unlinkSync(bad);fs.writeFileSync(bad,'invalid');
    assert.throws(()=>buildGrammars(f.pkg,path.join(f.root,'bad-output')),/Invalid WASM header: css/);
  } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
});

test('packed artifact loads its own real WASM and rejects tampering without poisoning other grammars', () => {
  const root=fs.mkdtempSync(path.join(scratch,'grammar-pack-'));
  const run=(command,args,cwd=root)=>{
    const r=spawnSync(command,args,{cwd,encoding:'utf8',timeout:60000,env:{...process.env,npm_config_cache:path.join(root,'npm-cache'),TMPDIR:root}});
    assert.equal(r.status,0,r.stdout+'\n'+r.stderr);return r.stdout;
  };
  try {
    const pack=JSON.parse(run('npm',['pack','--ignore-scripts','--offline','--json','--pack-destination',root],repo))[0];
    run('/usr/bin/tar',['-xzf',path.join(root,pack.filename),'-C',root]);
    const script=String.raw`
      import assert from 'node:assert/strict';import fs from 'node:fs';
      import {outline,verifyGrammar} from './package/dist/language/syntax/parser.js';
      import {grammarPaths} from './package/dist/language/syntax/assets.js';
      assert.ok(grammarPaths('typescript').wasm.startsWith(fs.realpathSync('package')));
      for (const [id,source,name] of [['typescript','const 日本 = 1;\r\nfunction 挨拶() {}','挨拶'],['javascript','function hello(){}','hello'],['php','<?php function hello() {}','hello'],['html','<p>日本</p>','p'],['css','/* 日本 */ .card { color:red; }','.card']]) {
        const result=await outline(id,source);assert.equal(result.status,'ok',JSON.stringify(result));assert.ok(result.nodes.some(n=>n.name===name),JSON.stringify({id,result}));assert.equal(result.errorCount,0);
        if(id==='typescript')assert.deepEqual(result.nodes.find(n=>n.name===name),{kind:'program',name:'挨拶',startLine:2,startColumn:10,endLine:2,endColumn:12});
        if(id==='css')assert.equal(result.nodes.find(n=>n.name===name).startColumn,10);
      }
      assert.equal((await verifyGrammar('commonlisp')).ok,false);
      assert.equal((await verifyGrammar('svelte')).ok,false);
    `;
    run(process.execPath,['--input-type=module','-e',script]);
    // Exercise packaged presets with real SBCL and use the packaged entry in actual child turns.
    run(process.execPath,['--input-type=module','-e',String.raw`
      import fs from 'node:fs';import assert from 'node:assert/strict';
      import {loadLispConfiguration,REQUIRED_SKILLS} from './package/dist/lisp/config.js';
      import {sha256} from './package/dist/lisp/runtime.js';
      import {readBundledSkill} from './package/dist/agent/bundled-skills.js';
      for(const language of ['php','common-lisp','js','ts','svelte','tailwindcss','html','css','formal']) {
        const file='./package/experiments/presets/'+language+'.lisp';
        const config=await loadLispConfiguration(file,sha256(fs.readFileSync(file)));
        assert.ok(config.entries.length>0);
        for(const role of config.entries)for(const skill of REQUIRED_SKILLS)assert.ok(role.definition.system.includes(readBundledSkill(skill,'SKILL.md',false)));
        if(language==='formal')assert.deepEqual(config.entries.map(e=>e.descriptor.title),['前鬼','後鬼']);
      }
    `]);
    const env={...process.env,TMPDIR:root,
      MODKH_TEST_CHAT:pathToFileURL(path.join(root,'package/dist/cli/chat.js')).href,
      MODKH_TEST_FIXED:pathToFileURL(path.join(root,'package/dist/model/fixed.js')).href,
      MODKH_TEST_PACKAGE_ROOT:path.join(root,'package')};
    delete env.NODE_TEST_CONTEXT;
    const entry=spawnSync(process.execPath,['--test',path.join(repo,'test/lisp.cli.test.ts')],{cwd:root,env,encoding:'utf8',timeout:30000});
    assert.equal(entry.status,0,entry.stdout+'\n'+entry.stderr);

    const wasm=path.join(root,'package/dist/language/grammars/tree-sitter-typescript.wasm');
    const bytes=fs.readFileSync(wasm);bytes[bytes.length-1]^=1;fs.writeFileSync(wasm,bytes);
    run(process.execPath,['--input-type=module','-e',String.raw`
      import assert from 'node:assert/strict';
      import {outline} from './package/dist/language/syntax/parser.js';
      const result=await outline('typescript','function hello() {}');
      assert.equal(result.status,'error');assert.match(result.detail,/digest mismatch/);
      assert.equal((await outline('css','.x {}')).status,'ok');
    `]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
