import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageService } from '../src/language/lsp/service.ts';
import { languageTools } from '../src/tools/language.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';
const fake=fileURLToPath(new URL('./fixtures/fake-lsp.mjs',import.meta.url));
test('cold Tailwind selector starts only overlay and keeps HTML document language and 0-based position',async()=>{
  const root=fs.realpathSync(temporaryDirectory('modkh-overlay-'));
  fs.writeFileSync(path.join(root,'index.html'),'<div class="flex">x</div>');
  const service=new LanguageService({root,settings:{autoInstall:false,disabled:[],installTimeoutMs:1000,requestTimeoutMs:1000,servers:{tailwind:{command:process.execPath,args:[fake]},html:{command:'/not-a-real-html-server'}}}});
  try {
    const hover=languageTools(service).find(t=>t.name==='code_hover')!;
    const result=await hover.execute({path:'index.html',line:1,column:13,server:'tailwind'},{root,approval:{approve:async()=>true}});
    assert.match(String(result),/HOVER 0:12/);assert.equal(service.poolSize,1);assert.equal(service.poolFor(path.join(root,'index.html')),undefined);
    assert.equal(service.poolFor(path.join(root,'index.html'),'tailwind')?.id,'tailwind');
  } finally {await service.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('unavailable diagnostics is an error, never clean zero',async()=>{
  const root=fs.realpathSync(temporaryDirectory('modkh-no-lsp-'));fs.writeFileSync(path.join(root,'index.html'),'x');
  const service=new LanguageService({root,settings:{autoInstall:false,disabled:['tailwind'],servers:{},installTimeoutMs:100,requestTimeoutMs:100}});
  try {await assert.rejects(languageTools(service).find(t=>t.name==='code_diagnostics')!.execute({path:'index.html',server:'tailwind'},{root,approval:{approve:async()=>true}}),/無効/);}
  finally {await service.close();fs.rmSync(root,{recursive:true,force:true});}
});
