import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadLispConfiguration, REQUIRED_SKILLS } from '../src/lisp/config.ts';
import { sha256, temporaryDirectory } from '../src/lisp/runtime.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { SubagentService, subagentTools } from '../src/subagents/service.ts';
import { SessionStore } from '../src/session/store.ts';
import { FixedModel, type FixedStep } from '../src/model/fixed.ts';
import { defaultTools, ToolRegistry } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { readBundledSkill } from '../src/agent/bundled-skills.ts';
import { routeIntent } from '../src/lisp/routing.ts';
const done:FixedStep=[{type:'text-delta',text:'done'},{type:'finish',stopReason:'stop'}];
const call=(id:string,name:string,args:Record<string,unknown>):FixedStep=>[{type:'tool-call',call:{id,name,args}},{type:'finish',stopReason:'tool-calls'}];
const approve={approve:async()=>true};
async function fixture() {
  const root=fs.realpathSync(temporaryDirectory('modkh-delegation-test-'));
  const file=path.join(root,'agents.lisp');
  const source='(in-package :dkh) (defmicroagent micro-ts-outline :title "構造担当" :tool "code_outline" :language "ts" :task-kind "outline" :instruction "Inspect source")';
  fs.writeFileSync(file,source);
  const config=await loadLispConfiguration(file,sha256(source));
  const manager=new PluginManager(path.join(root,'home')); manager.registerSessionDefinitions(config.entries,config.digest);
  const store=new SessionStore(path.join(root,'sessions'));const parent=store.create(root,'fixed/scripted');
  return {root,manager,store,parent};
}
test('head list → delegate → tool evidence → persisted result; exact skills in actual child model request',async()=>{
  const f=await fixture();try {
    const child=new FixedModel([call('outline','code_outline',{path:'a.ts'}),done]);
    const service=new SubagentService({...f,tools:[{name:'code_outline',readOnly:true,description:'fixture',parameters:{},execute:async()=>'a.ts:1:1 function add'}],approval:approve,connection:()=>({ref:'fixed/scripted',create:()=>child})});
    const head=new FixedModel([call('list','list_subagents',{}),call('delegate','run_subagent',{pluginId:'micro-ts-outline',task:'outline a.ts'}),done]);
    f.parent.append({role:'user',content:'Inspect a.ts'});
    await runAgentLoop(f.parent.messages,{model:head,registry:new ToolRegistry(subagentTools(service)),root:f.root,approval:approve,signal:new AbortController().signal,checkpoint:()=>f.parent.persistFrom(0)});
    const result=f.store.load(f.parent.id).delegations()[0].result!;
    assert.equal(result.status,'completed');assert.ok(f.store.load(result.agentId).messages.some(m=>m.role==='tool'));
    assert.deepEqual(child.requests[0].tools.map(t=>t.name),['code_outline']);
    for(const name of REQUIRED_SKILLS) assert.ok(child.requests[0].system!.includes(readBundledSkill(name,'SKILL.md',false)));
    assert.ok(!child.requests[0].system!.includes('--- veteran-programmer-skill'));
    assert.ok(head.requests[2].messages.some(m=>m.role==='tool'&&m.results.some(r=>r.name==='run_subagent'&&r.status==='ok')));
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
for(const variant of ['missing-tool','no-evidence','tool-error']) test(`${variant} cannot be overwritten by child done`,async()=>{
  const f=await fixture();try {
    let starts=0;
    const child=new FixedModel(variant==='tool-error'?[call('outline','code_outline',{path:'a.ts'}),done]:[done]);
    const service=new SubagentService({...f,tools:variant==='missing-tool'?defaultTools():[{name:'code_outline',readOnly:true,description:'fixture',parameters:{},execute:async()=>({status:'error' as const,output:'unavailable'})}],approval:approve,connection:()=>({ref:'fixed/scripted',create:()=>{starts++;return child;}})});
    const r=await(await service.start({pluginId:'micro-ts-outline',task:'Inspect'},{callId:'x',signal:new AbortController().signal})).result;
    assert.notEqual(r.status,'completed');if(variant==='missing-tool')assert.equal(starts,0);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
test('opt-in routing rejects ambiguity, negation, conditional, unknown and outside paths',async()=>{
  const f=await fixture();try {
    const roles=f.manager.discover().registry.list();assert.equal(routeIntent('outline src/a.ts',roles)?.pluginId,'micro-ts-outline');
    for(const task of ['do not outline a.ts','if needed outline a.ts','outline and edit a.ts','outline a.ts b.ts','outline a.unknown','outline ../a.ts','outline https://host/a.ts','outline /a.ts','outline']) assert.equal(routeIntent(task,roles),undefined,task);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
