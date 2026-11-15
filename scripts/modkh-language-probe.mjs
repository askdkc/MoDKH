#!/usr/bin/env node
// Reproducible real-server probe. Explicit binaries only; no installation or user project access.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { offsetToPosition } from '../dist/language/positions.js';
import { commonLispReader } from '../dist/language/commonlisp-reader.js';
import { LspServer } from '../dist/language/lsp/client.js';
const [id, command, output, ...args] = process.argv.slice(2);
if (!id || !command || !output || !path.isAbsolute(command)) throw new Error('Usage: node scripts/modkh-language-probe.mjs LANGUAGE ABSOLUTE_BINARY OUTPUT_JSON [ARGS...]');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-real-lsp-')));
const inputs = {
  typescript: ['input.ts', 'const answer: number = "wrong";\nfunction add(a: number, b: number) { return a + b; }\nadd(1, 2);\n'],
  javascript: ['input.js', 'function add(a, b) { return a + b; }\nadd(1,2);\n'],
  tailwind: ['index.html', '<div class="flex">Hello</div>\n'],
  php: ['input.php', '<?php\nfunction add(int $a, int $b): int { return $a + $b; }\nadd(1, 2);\n'],
  commonlisp: ['input.lisp', '(defun add (a b) (+ a b))\n(let ((value 1)) value)\n'],
  svelte: ['Input.svelte', '<script lang="ts">let message: string = "hello";</script>\n<p>{message}</p>\n'],
};
if (!inputs[id]) throw new Error('Unsupported probe language');
const [name,text] = inputs[id]; const file = path.join(root,name); fs.writeFileSync(file,text);
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({private:true,devDependencies:id==='tailwind'?{tailwindcss:'latest'}:{}}));
fs.writeFileSync(path.join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true},include:['*.ts']}));
if (id==='tailwind') fs.writeFileSync(path.join(root,'tailwind.config.js'),'module.exports={content:["./index.html"]};');
const logs=[];
const server = new LspServer({log:message=>{if(logs.length<20)logs.push(message);},id,command,args,root,requestTimeoutMs:10000,inheritEnv:false,env:{PATH:process.env.PATH ?? '/usr/bin:/bin',HOME:root,TMPDIR:root,LANG:'C.UTF-8'}});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const report={platform:process.platform,arch:process.arch,id,binary:fs.realpathSync(command),binarySha256:hash(fs.readFileSync(command)),sourceSha256:hash(text),initialized:false,status:'unverified',startedAt:new Date().toISOString()};
try {
  await server.start(); report.initialized=true; report.capabilities=server.capabilities;report.logs=logs;
  const sync=await server.synchronize(file,text);report.diagnostics=sync;
  const position=id==='commonlisp'?offsetToPosition(text,text.lastIndexOf('value')):id==='tailwind'?{line:0,character:13}:['typescript','php'].includes(id)?{line:2,character:1}:{line:0,character:1};
  report.hover=await server.hover(file,position);
  if (id!=='tailwind') report.definition=await server.definition(file,position);
  if (id==='php') {
    const invalid='<?php\nfunction broken( {\n';
    const invalidFile=path.join(root,'invalid.php');fs.writeFileSync(invalidFile,invalid);
    report.invalidSourceSha256=hash(invalid);
    report.invalidDiagnostics=await server.synchronize(invalidFile,invalid);
    report.diagnosticChannels=server.diagnosticEvidence;
    report.status=report.invalidDiagnostics.status==='observed'&&report.invalidDiagnostics.diagnostics.some(d=>d.severity==='error')?'passed':'unverified';
    report.scope='Syntax error diagnostics only; project-wide semantics and file watching are not verified';
  } else if (id==='commonlisp') {
    report.definitionScope='Lexical binding only; project code is never loaded/evaluated by this probe';
    const invalid='; 日本語\n(defun broken (x)\n (+ x 1)';
    const invalidFile=path.join(root,'invalid.lisp');fs.writeFileSync(invalidFile,invalid);
    report.invalidSourceSha256=hash(invalid);
    report.invalidDiagnostics=await server.synchronize(invalidFile,invalid);
    report.diagnosticChannels=server.diagnosticEvidence;
    report.reader=await commonLispReader(invalid);
    report.status=report.definition.some(d=>d.file===file&&d.line===2&&d.character===8)
      &&report.invalidDiagnostics.status==='observed'&&report.invalidDiagnostics.diagnostics.some(d=>d.severity==='error')?'passed':'unverified';
  } else report.status = id==='tailwind' ? /display:\s*flex/.test(report.hover??'')?'passed':'unverified'
    : id==='typescript' ? sync.status==='observed' && sync.diagnostics.length>0 && report.definition.length>0?'passed':'unverified' : 'initialized-only';
} catch(e) { report.error=String(e); report.status='failed'; }
finally {
  try {await server.dispose();report.cleanup='settled';} catch(e) {report.cleanup=String(e);report.status='unverified';}
  report.finishedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  fs.rmSync(root,{recursive:true,force:true});
}
console.log(JSON.stringify({id,status:report.status,initialized:report.initialized,output}));
if(report.status!=='passed') process.exitCode=1;
