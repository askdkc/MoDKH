import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hostPlatform, phpAsset } from '../src/language/platform.ts';
import { ensureInstalled, verifyTsserver } from '../src/language/install.ts';
import { languageById } from '../src/language/catalog.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';
test('Darwin/Linux x64/arm64 target selection and official checksum requirement',()=>{
  for(const os of ['darwin','linux']) for(const arch of ['x64','arm64']) {
    const platform=hostPlatform(os,arch)!;assert.ok(platform);
    const asset={name:`phpantom_lsp-${platform.target}.tar.gz`,browser_download_url:'https://github.com/PHPantom-dev/phpantom_lsp/releases/download/test/test.tar.gz',size:100,digest:`sha256:${'a'.repeat(64)}`};
    assert.equal(phpAsset([asset],platform).name,asset.name);
    assert.throws(()=>phpAsset([{...asset,digest:undefined}],platform),/SHA256/);
    assert.throws(()=>phpAsset([{...asset,browser_download_url:'https://evil.invalid/test'}],platform),/origin/);
  }
  assert.equal(hostPlatform('win32','x64'),undefined);assert.equal(hostPlatform('linux','riscv64'),undefined);
});
test('autoInstall=false creates no prefix; TypeScript requires actual tsserver capability',async()=>{
  const dir=temporaryDirectory('modkh-installer-test-');const prior=process.env.DKH_HOME;process.env.DKH_HOME=path.join(dir,'home');
  try {
    assert.equal((await ensureInstalled(languageById('typescript')!,{autoInstall:false})).status,'unavailable');
    assert.equal(fs.existsSync(process.env.DKH_HOME),false);
    assert.throws(()=>verifyTsserver(dir),/tsserver.js/);
    const api=path.join(dir,'node_modules/typescript/lib');fs.mkdirSync(api,{recursive:true});fs.writeFileSync(path.join(api,'tsserver.js'),'// fixture');
    assert.doesNotThrow(()=>verifyTsserver(dir));
  } finally {if(prior===undefined)delete process.env.DKH_HOME;else process.env.DKH_HOME=prior;fs.rmSync(dir,{recursive:true,force:true});}
});

test('PHP native download rejects checksum mismatch before extraction or publication',async()=>{
  const {installPhpantom}=await import('../src/language/native.ts');
  const dir=temporaryDirectory('modkh-php-digest-');const fetch_=globalThis.fetch;
  const platform=hostPlatform()!;const bytes=Buffer.from('not a tar archive');let requests=0;
  globalThis.fetch=async()=>{
    requests++;
    return requests===1?new Response(JSON.stringify({tag_name:'fixture',assets:[{name:`phpantom_lsp-${platform.target}.tar.gz`,browser_download_url:'https://github.com/PHPantom-dev/phpantom_lsp/releases/download/fixture/server.tar.gz',size:bytes.length,digest:`sha256:${'0'.repeat(64)}`}]})):new Response(bytes);
  };
  try {await assert.rejects(installPhpantom(path.join(dir,'server')),/SHA256/);assert.equal(fs.existsSync(path.join(dir,'server')),false);assert.deepEqual(fs.readdirSync(dir),[]);}
  finally {globalThis.fetch=fetch_;fs.rmSync(dir,{recursive:true,force:true});}
});
