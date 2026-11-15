import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hostPlatform } from '../src/language/platform.ts';
import { roswellAsset, installCommonLisp } from '../src/language/commonlisp-install.ts';
import { ensureInstalled } from '../src/language/install.ts';
import { languageById } from '../src/language/catalog.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';
const asset=(name:string)=>({name,browser_download_url:`https://github.com/roswell/roswell/releases/download/current/${name}`,size:3,digest:`sha256:${'0'.repeat(64)}`});

test('Roswell selection uses release metadata and actual glibc requirement for all four hosts',()=>{
 for(const os of ['darwin','linux'])for(const arch of ['x64','arm64']){
  const platform=hostPlatform(os,arch)!;
  const name=`roswell-current-${os}-${arch==='arm64'?'arm64':os==='darwin'?'x86-64':'x86_64'}${os==='linux'?'-glibc2.40':''}.tar.bz2`;
  assert.equal(roswellAsset([asset(name)],platform,'2.41').name,name);
  assert.throws(()=>roswellAsset([{...asset(name),digest:undefined}],platform,'2.41'),/SHA256/);
  if(os==='linux'){
   assert.throws(()=>roswellAsset([asset(name)],platform,'2.39'),/compatible/);
   assert.throws(()=>roswellAsset([asset(name)],platform),/compatible/);
  }
 }
});
test('disabled CL auto-install makes no fetch or directory; a DNS failure records the exact stage and retries are cooled down',async()=>{
 const root=temporaryDirectory('modkh-cl-install-');const oldHome=process.env.MODKH_HOME,oldFetch=globalThis.fetch;
 process.env.MODKH_HOME=path.join(root,'home');let fetches=0;
 globalThis.fetch=async()=>{fetches++;throw new Error('fixture DNS ENOTFOUND');};
 try {
  const language=languageById('commonlisp')!;
  assert.equal((await ensureInstalled(language,{autoInstall:false})).status,'unavailable');assert.equal(fetches,0);assert.equal(fs.existsSync(process.env.MODKH_HOME),false);
  const failed=await ensureInstalled(language,{autoInstall:true});assert.equal(failed.status,'error');assert.match(failed.detail!,/release-metadata.*ENOTFOUND/);
  assert.equal(fetches,1);
  const again=await ensureInstalled(language,{autoInstall:true});assert.equal(again.status,'unavailable');assert.equal(fetches,1);
  const target=path.join(process.env.MODKH_HOME,'language','servers','commonlisp');
  // Locate through the same public home helper: state remains failure-only.
  const {languageHome}=await import('../src/language/detect.ts');
  const home=languageHome();const report=JSON.parse(fs.readFileSync(path.join(home,'servers/commonlisp/last-failure.json'),'utf8'));
  assert.equal(report.status,'failed');assert.equal(report.stages.at(-1).name,'release-metadata');assert.equal(report.stages.at(-1).state,'failed');
  assert.equal(fs.readdirSync(path.join(home,'servers/commonlisp')).some(n=>n.startsWith('attempt-')),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'state.json'),'utf8')).servers.commonlisp,undefined);
  void target;
 } finally {globalThis.fetch=oldFetch;if(oldHome===undefined)delete process.env.MODKH_HOME;else process.env.MODKH_HOME=oldHome;fs.rmSync(root,{recursive:true,force:true});}
});
test('CL bootstrap abort never leaves a success receipt or attempts a download',async()=>{
 const root=temporaryDirectory('modkh-cl-abort-');const fetch_=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('must not fetch');};
 try {await assert.rejects(installCommonLisp(path.join(root,'cl'),AbortSignal.abort()),/compiler-capability/);assert.equal(calls,0);const report=JSON.parse(fs.readFileSync(path.join(root,'cl/last-failure.json'),'utf8'));assert.equal(report.status,'failed');}
 finally{globalThis.fetch=fetch_;fs.rmSync(root,{recursive:true,force:true});}
});

test('simultaneous CL installation attempts share the lock and do not repeat a failed download',async()=>{
 const root=temporaryDirectory('modkh-cl-lock-');const oldHome=process.env.MODKH_HOME,oldFetch=globalThis.fetch;
 process.env.MODKH_HOME=path.join(root,'home');let calls=0;
 globalThis.fetch=async()=>{calls++;throw new Error('fixture DNS ENOTFOUND');};
 try {
  const results=await Promise.all([1,2].map(()=>ensureInstalled(languageById('commonlisp')!,{autoInstall:true})));
  assert.ok(results.every(r=>r.status!=='ready'));assert.equal(calls,1);
 } finally {globalThis.fetch=oldFetch;if(oldHome===undefined)delete process.env.MODKH_HOME;else process.env.MODKH_HOME=oldHome;fs.rmSync(root,{recursive:true,force:true});}
});
test('CL compiler absence fails at its own stage before network access',async()=>{
 const root=temporaryDirectory('modkh-cl-no-cc-');const oldPath=process.env.PATH,oldFetch=globalThis.fetch;let calls=0;
 process.env.PATH=root;globalThis.fetch=async()=>{calls++;throw new Error('network must not run');};
 try {
  await assert.rejects(installCommonLisp(path.join(root,'cl')),/compiler-capability.*ENOENT/);
  assert.equal(calls,0);
 } finally{globalThis.fetch=oldFetch;if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;fs.rmSync(root,{recursive:true,force:true});}
});

test('an incomplete or modified managed CL prefix cannot be reused',async()=>{
 const {reusableCommonLisp}=await import('../src/language/commonlisp-install.ts');
 const {sha256}=await import('../src/lisp/runtime.ts');
 const root=temporaryDirectory('modkh-cl-reuse-'),command=path.join(root,'cl-lsp');
 try {
  fs.writeFileSync(command,'fixture launcher');const digest=sha256(fs.readFileSync(command));
  assert.equal(reusableCommonLisp(command,digest),false);
  fs.writeFileSync(path.join(root,'install-receipt.json'),JSON.stringify({status:'ready-for-lexical-definition',launcherSha256:digest,stages:[{name:'lsp-initialize',state:'passed'},{name:'lexical-definition',state:'passed'}]}));
  assert.equal(reusableCommonLisp(command,digest),true);
  fs.appendFileSync(command,'modified');assert.equal(reusableCommonLisp(command,digest),false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
