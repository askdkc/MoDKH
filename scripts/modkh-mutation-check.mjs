#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=process.argv[2];if(!output)throw new Error('Output JSON path required');
const cases=[
  ['acceptance-reuse','src/subagents/verification.ts',"if (this.consumed) throw new ToolError('STALE', 'Acceptance receipts are single-use; create a fresh snapshot');",';','test/lisp.edit-service.test.ts'],
  ['restored-verifier','src/subagents/verification.ts','current.stat.ctimeMs === original.stat.ctimeMs && current.stat.mtimeMs === original.stat.mtimeMs &&','', 'test/lisp.edit-service.test.ts'],
  ['pull-report-shape','src/language/lsp/client.ts','if (report && Array.isArray(report.items))','if (report && (report.items ??= []))','test/language.lsp.test.ts'],
  ['typescript-semantic-api','src/language/typescript-capability.ts',"if (result.state !== 'exited' || result.exitCode !== 0 || result.stdout !== 'MODKH_TYPESCRIPT_API_OK')",'if (false)','test/language.typescript-capability.test.ts'],
  ['typescript-fallback','src/language/install.ts',"if (!recommended) throw",'if (true) throw','test/language.install-fallback.test.ts'],
  ['child-language-tools','src/cli/chat.ts','tools: [...tools, ...languageTools(language), ...formalTools','tools: [...tools, ...formalTools','test/lisp.cli.test.ts'],
  ['target-allowlist','src/subagents/verification.ts',"if (typeof args.path !== 'string' || !this.targets.includes(args.path))",'if (false)','test/lisp.edit-service.test.ts'],
  ['exit-zero','src/subagents/verification.ts',"receipt.exitCode === 0 ? 'passed' : 'failed'","true ? 'passed' : 'failed'",'test/lisp.edit-service.test.ts'],
  ['tsserver-api','src/language/install.ts',"if (!fs.existsSync(api) || !fs.statSync(api).isFile())",'if (false)','test/language.install-platform.test.ts'],
  ['lean-unverified','src/tools/formal.ts',"status: receipt.cleanup === 'unknown' ? 'unknown' as const : verifier === 'tla' && complete ? 'ok' as const : 'error' as const","status: accepted ? 'ok' as const : 'error' as const",'test/formal.proof-status.test.ts'],
];
const results=[];
for(const [name,file,from,to,test] of cases){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'modkh-mutation-'));
 try {
  for(const folder of ['src','test','skills','plugins','experiments','dist'])fs.cpSync(path.join(root,folder),path.join(tmp,folder),{recursive:true});
  for(const file of ['package.json','tsconfig.json'])fs.copyFileSync(path.join(root,file),path.join(tmp,file));
  fs.symlinkSync(fs.realpathSync(path.join(root,'node_modules')),path.join(tmp,'node_modules'));
  const target=path.join(tmp,file);const original=fs.readFileSync(target,'utf8');if(!original.includes(from))throw new Error(`Missing mutation seam: ${name}`);
  fs.writeFileSync(target,original.replace(from,to));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.MODKH_TEST_CHAT;delete env.MODKH_TEST_FIXED;
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap',test],{cwd:tmp,env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
  const failed=[...run.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1]);
  results.push({name,status:run.status!==0&&failed.length?'detected':'survived-or-infrastructure-error',exitCode:run.status,failedTests:failed,error:run.error?.message});
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
fs.writeFileSync(output,JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
if(results.some(r=>r.status!=='detected'))process.exitCode=1;
