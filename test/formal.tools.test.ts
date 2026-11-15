import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { formalTools } from '../src/tools/formal.ts';
for(const [config,expected] of [['good.cfg','passed'],['bad.cfg','failed']]) test(`real TLC ${config}`, {skip: !(process.env.MODKH_TEST_JAVA && process.env.MODKH_TEST_TLA_JAR) && 'Java/TLC host settings not supplied'},async()=>{
  const tool=formalTools({java:process.env.MODKH_TEST_JAVA,tlaJar:process.env.MODKH_TEST_TLA_JAR})[1];
  const r=await tool.execute({path:'Counter.tla',config},{root:fileURLToPath(new URL('./fixtures/formal',import.meta.url)),approval:{approve:async()=>true}});
  assert.notEqual(typeof r,'string');if(typeof r==='string')return;assert.equal(JSON.parse(r.output).status,expected);
});
