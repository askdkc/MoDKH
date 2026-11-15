import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { temporaryDirectory, sha256, privateEnvironment } from '../src/lisp/runtime.ts';
const chat = process.env.MODKH_TEST_CHAT ?? new URL('../src/cli/chat.ts',import.meta.url).href;
const fixed = process.env.MODKH_TEST_FIXED ?? new URL('../src/model/fixed.ts',import.meta.url).href;
const step=(id:string,name:string,args:Record<string,unknown>)=>[{type:'tool-call',call:{id,name,args}},{type:'finish',stopReason:'tool-calls'}];
const done=[{type:'text-delta',text:'integrated'},{type:'finish',stopReason:'stop'}];
test('real chat entry: trusted Lisp head delegates bounded edit and receives independent Node receipt',async()=>{
  const root=fs.realpathSync(temporaryDirectory('modkh-cli-entry-')); const home=path.join(root,'home');fs.mkdirSync(home);
  fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'test'));
  fs.writeFileSync(path.join(root,'src/add.mjs'),'export const add=(a,b)=>a-b;');
  fs.writeFileSync(path.join(root,'test/add.test.mjs'),'import {add} from "../src/add.mjs";import assert from "node:assert/strict";assert.equal(add(2,3),5);');
  const before=sha256(fs.readFileSync(path.join(root,'test/add.test.mjs')));
  const source=`(in-package :dkh)
(defmicroagent micro-js-edit :title "JS編集担当" :tool "edit_file" :workflow "edit-verify" :language "js" :task-kind "edit" :instruction "Fix addition" :max-turns 8)
(defmicroagent micro-js-outline :tool "code_outline" :language "js" :task-kind "outline" :instruction "Inspect structure")
(set-agent-check "micro-js-edit" "node --test test/add.test.mjs" :sources '("src/add.mjs") :protected '("test/add.test.mjs"))`;
  fs.writeFileSync(path.join(root,'agents.lisp'),source);
  fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({permissions:'all',language:{autoInstall:false}}));
  const head=[step('list','list_subagents',{}),step('outline-delegate','run_subagent',{pluginId:'micro-js-outline',task:'Inspect src/add.mjs'}),step('delegate','run_subagent',{pluginId:'micro-js-edit',task:'Fix add',targetPaths:['src/add.mjs']}),done];
  const observer=[step('outline','code_outline',{path:'src/add.mjs'}),done];
  const child=[step('read','read_file',{path:'src/add.mjs'}),step('edit','edit_file',{path:'src/add.mjs',old_string:'a-b',new_string:'a+b'}),done];
  const harness=`import {runChat} from ${JSON.stringify(chat)};import {FixedModel} from ${JSON.stringify(fixed)};import fs from 'node:fs';const head=new FixedModel(${JSON.stringify(head)}),observer=new FixedModel(${JSON.stringify(observer)}),child=new FixedModel(${JSON.stringify(child)});let count=0;await runChat({args:${JSON.stringify({cwd:root,model:'fixed/scripted','lisp-config':'agents.lisp','trust-lisp-sha256':sha256(source)})},modelFactory:()=>[head,observer,child][count++]});fs.writeFileSync(${JSON.stringify(path.join(root,'requests.json'))},JSON.stringify({head:head.requests,child:child.requests}));`;
  try {
    const process_=spawn(process.execPath,['--input-type=module','-e',harness],{cwd:root,env:{...privateEnvironment(home),DKH_HOME:home,DKH_PLAIN:'1',NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
    let output='';process_.stdout.on('data',b=>output+=b);process_.stderr.on('data',b=>output+=b);
    const timer=setTimeout(()=>process_.kill('SIGKILL'),10000);process_.stdin.end('Fix addition\n/exit\n');
    const exit=await new Promise<number|null>((resolve,reject)=>{process_.on('error',reject);process_.on('close',resolve);});clearTimeout(timer);
    assert.equal(exit,0,output);assert.match(fs.readFileSync(path.join(root,'src/add.mjs'),'utf8'),/a\+b/);
    assert.equal(sha256(fs.readFileSync(path.join(root,'test/add.test.mjs'))),before);
    const requests=JSON.parse(fs.readFileSync(path.join(root,'requests.json'),'utf8'));
    const names=requests.head[0].tools.map((t:{name:string})=>t.name);
    for(const denied of ['edit_file','create_file','run_command','verify_lean','verify_tla'])assert.ok(!names.includes(denied),denied);
    const receipts=requests.head.at(-1).messages.flatMap((m:{role:string;results?:unknown[]})=>m.role==='tool'?m.results:[]);
    const delegations=receipts.filter((r:{name:string})=>r.name==='run_subagent');
    assert.equal(JSON.parse(delegations[0].output).status,'completed');
    const result=JSON.parse(delegations.at(-1).output);
    assert.equal(result.status,'completed');assert.equal(result.verification.status,'passed');assert.equal(result.verification.receipt.exitCode,0);
    assert.deepEqual(requests.child[0].tools.map((t:{name:string})=>t.name),['read_file','edit_file']);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
