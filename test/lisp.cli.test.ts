import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { temporaryDirectory, sha256, privateEnvironment } from '../src/lisp/runtime.ts';
const chat = process.env.MODKH_TEST_CHAT ?? new URL('../src/cli/chat.ts',import.meta.url).href;
const fixed = process.env.MODKH_TEST_FIXED ?? new URL('../src/model/fixed.ts',import.meta.url).href;
const step=(id:string,name:string,args:Record<string,unknown>)=>[{type:'tool-call',call:{id,name,args}},{type:'finish',stopReason:'tool-calls'}];
const done=[{type:'text-delta',text:'integrated'},{type:'finish',stopReason:'stop'}];

for (const mode of ['compile-only', 'proved', 'rejected']) test(`ordinary chat returns formal receipts to the Enno-Oduno MoA head: ${mode}`, {
  skip: mode !== 'compile-only' && !process.env.MODKH_TEST_LEAN && 'Real Lean executable not supplied',
}, async () => {
  const root = fs.realpathSync(temporaryDirectory('modkh-formal-chat-'));
  try {
    const preset = new URL('../experiments/presets/formal.lisp', import.meta.url);
    const source = fs.readFileSync(preset, 'utf8') + (mode === 'proved' ? '\n(set-head-check-inputs "Model.json" "Proof.lean")\n' : '');
    fs.writeFileSync(path.join(root, 'agents.lisp'), source);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ permissions: 'all', language: { autoInstall: false } }));
    fs.copyFileSync(new URL('./fixtures/formal/good.json', import.meta.url), path.join(root, 'Model.json'));
    fs.writeFileSync(path.join(root, 'Proof.lean'), mode === 'rejected'
      ? 'theorem goal : True := trivial'
      : 'theorem goal (n : Nat) : n + 0 = n := rfl');
    fs.writeFileSync(path.join(root, 'Expected.lean'), 'def modkhExpected : Prop := ∀ n : Nat, n + 0 = n');
    const stateright = fileURLToPath(new URL('../native/stateright/target/debug/modkh-stateright', import.meta.url));
    const lean = path.join(root, 'lean');
    fs.writeFileSync(lean, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const coordination = 'Confirm the request within each formal input’s scope, then combine the receipts.';
    const nextRequest = '更新された証明を使い、前鬼と後鬼で検証してください。';
    const bound = mode !== 'compile-only';
    const formal = (path: string, config?: string) => bound ? { formalInput: { path, ...(config ? { config } : {}) } } : {};
    const scripts = [
      [step('catalog', 'list_subagents', {}),
        ...(mode === 'proved' ? [step('wrong-path', 'run_subagent', { pluginId: 'micro-goki', task: 'Verify the expected proposition', formalInput: { path: 'Expected.lean' } })] : []),
        step('zenki', 'run_subagent', { pluginId: 'micro-zenki', task: 'Check the finite model', context: coordination, ...formal('Model.json') }),
        ...(mode === 'proved' ? [done] : []), ...(mode === 'proved' ? [] : [
          step('goki', 'run_subagent', { pluginId: 'micro-goki', task: 'Check the standalone contract', context: coordination, ...formal('Proof.lean') }),
        ]), ...(mode === 'rejected' ? [
          step('retry', 'run_subagent', { pluginId: 'micro-zenki', task: 'Retry after the Lean verdict', ...formal('Model.json') }),
        ] : []), ...(mode === 'rejected' ? [
          step('next-read', 'read_file', { path: 'Proof.lean' }),
          step('next-zenki', 'run_subagent', { pluginId: 'micro-zenki', task: 'Check the new request', ...formal('Model.json') }),
          step('next-goki', 'run_subagent', { pluginId: 'micro-goki', task: 'Verify the corrected proof', ...formal('Proof.lean') }),
        ] : []), done],
      [step('tlc', 'verify_stateright', { path: 'Model.json' }), done],
      [step('lean', 'verify_lean', { path: 'Proof.lean' }), done],
    ];
    const args = { cwd: root, model: 'fixed/scripted', routing: 'auto', 'lisp-config': 'agents.lisp',
      'trust-lisp-sha256': sha256(source), stateright,
      ...(mode === 'compile-only' ? { lean } : { lean: process.env.MODKH_TEST_LEAN, 'lean-contract': 'Expected.lean', 'lean-theorem': 'goal' }) };
    const harness = `import {runChat} from ${JSON.stringify(chat)};
      import {FixedModel} from ${JSON.stringify(fixed)};
      import fs from 'node:fs';
      const models = ${JSON.stringify(scripts)}.map(script => new FixedModel(script));
      let index = 0;
      await runChat({args:${JSON.stringify(args)},modelFactory:()=>models[index++]});
      fs.writeFileSync('requests.json', JSON.stringify(models.map(model => model.requests)));`;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', harness], {
      cwd: root, env: { ...privateEnvironment(root), MODKH_HOME: root, MODKH_PLAIN: '1', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let nextSent = false;
    proc.stdout.on('data', chunk => {
      output += chunk;
      if (mode === 'rejected' && !nextSent && /形式検証は不合格.*TARGET_STATEMENT_MISMATCH/.test(output)) {
        nextSent = true;
        fs.writeFileSync(path.join(root, 'Proof.lean'), 'theorem goal (n : Nat) : n + 0 = n := rfl');
        proc.stdin.end(`${nextRequest}\n/exit\n`);
      }
    });
    proc.stderr.on('data', chunk => output += chunk);
    // The real Lean host phase can use up to 150 seconds before cleanup.
    const timer = setTimeout(() => proc.kill('SIGKILL'), mode === 'rejected' ? 320_000 : bound ? 165_000 : 35_000);
    const request = mode === 'compile-only' ? 'Model.json を検証して。' : mode === 'rejected'
      ? '加算の既存の定理を前鬼と後鬼で検証してください。'
      : '加算のコードを修正してください。どの自然数にも 0 を足すと元の数になることを既存の定理で検証して。';
    if (mode === 'rejected') proc.stdin.write(`${request}\n`);
    else proc.stdin.end(`${request}\n/exit\n`);
    try {
      assert.equal(await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); }), 0, output);
    } finally { clearTimeout(timer); }
    const [requests, zenkiRequests, gokiRequests] = JSON.parse(fs.readFileSync(path.join(root, 'requests.json'), 'utf8'));
    const instruction = source.match(/\(set-head-instruction\s+"([^"]+)"/)?.[1];
    assert.ok(instruction);
    assert.match(instruction, /役小角 \(enno-oduno\)/);
    assert.ok(requests[0].system.includes(instruction));
    assert.doesNotMatch(requests[0].system, /Delegate independent work with start_subagent|\[coding-ideal-routine-skill\]/);
    if (bound) {
      if (mode === 'proved') assert.ok(requests.some((request: { messages: { content?: string }[] }) => request.messages.some(message =>
        message.content?.includes('後鬼の検証が未確認'))), output);
      assert.equal(zenkiRequests.length + gokiRequests.length, 0, 'Bound formal inputs execute without a second model selecting paths');
    }
    for (const childRequests of bound ? [] : [zenkiRequests, gokiRequests]) {
      assert.ok(childRequests[0].messages.some(({ role, content }: { role: string; content?: string }) =>
        role === 'user' && content?.includes(coordination)));
    }
    const messages = requests.at(-1).messages;
    const nextIndex = messages.findIndex((m: { role: string; content?: string }) => m.role === 'user' && m.content === nextRequest);
    const toolResults = (items: { role: string; results?: unknown[] }[]) => items.flatMap(m => m.role === 'tool' ? m.results ?? [] : []) as {
      callId: string; name: string; status: string; output: string;
    }[];
    const results = toolResults(nextIndex < 0 ? messages : messages.slice(0, nextIndex));
    if (mode === 'proved') {
      const refusal = results.find((r: { callId: string }) => r.callId === 'wrong-path');
      assert.ok(refusal);
      assert.match(refusal.output, /configured formalInput.*Proof\.lean/);
    }
    const delegations = results.filter((r: { name: string; output: string }) => r.name === 'run_subagent' && r.output.startsWith('{'));
    assert.equal(delegations.length, 2, output);
    const [tlc, leanResult] = delegations.map((r: { output: string }) => JSON.parse(r.output).formalEvidence[0]);
    assert.equal(JSON.parse(tlc.output).status, 'passed');
    const proof = JSON.parse(leanResult.output);
    assert.equal(proof.status, 'accepted');
    assert.equal(proof.proofStatus, mode === 'compile-only' ? 'unverified' : mode);
    assert.equal(proof.code, { 'compile-only': 'PROOF_UNVERIFIED', proved: 'TARGET_PROVED', rejected: 'TARGET_STATEMENT_MISMATCH' }[mode]);
    assert.equal(JSON.parse(delegations[1].output).status, mode === 'proved' ? 'completed' : 'error');
    if (mode === 'rejected') {
      const [rejectedOutput, correctedOutput] = output.split(`▶ You: ${nextRequest}`);
      assert.match(rejectedOutput!, /形式検証は不合格.*TARGET_STATEMENT_MISMATCH/);
      assert.doesNotMatch(rejectedOutput!, /形式検証は合格/);
      assert.doesNotMatch(correctedOutput!, /形式検証は不合格/);
      assert.equal(results.find(result => result.callId === 'retry')?.status, 'not-executed');
      assert.ok(nextIndex >= 0, output);
      const nextResults = toolResults(messages.slice(nextIndex));
      assert.equal(nextResults.find(result => result.callId === 'next-read')?.status, 'ok');
      const nextProof = nextResults.find(result => result.callId === 'next-goki');
      assert.equal(nextProof?.status, 'ok');
      assert.equal(JSON.parse(JSON.parse(nextProof!.output).formalEvidence[0].output).proofStatus, 'proved');
      assert.match(output, /状態: complete/);
    }
    if (bound) {
      assert.match(output, /形式検証は合格.*前鬼.*Stateright.*passed.*後鬼.*Lean.*proved/);
      assert.doesNotMatch(output, /目標達成の検証は未確認/);
    } else {
      assert.doesNotMatch(output, /形式検証は合格/);
      assert.match(output, /目標達成の検証は未確認/);
    }
    if (mode === 'proved') assert.match(output, /状態: complete/);
    if (mode !== 'compile-only') {
      assert.equal(proof.proofPath, 'Proof.lean');
      assert.deepEqual(proof.target, { expectedPropositionPath: 'Expected.lean', theorem: 'goal' });
      assert.equal(proof.hashes.contract, sha256(fs.readFileSync(path.join(root, 'Expected.lean'))));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const isolation of ['integrity-only', 'required']) test(isolation === 'required' ? 'real chat entry: required isolation returns not-executed receipt to head' : 'real chat entry: trusted Lisp head delegates bounded edit and receives independent Node receipt',async()=>{
  const root=fs.realpathSync(temporaryDirectory('modkh-cli-entry-')); const home=path.join(root,'home');fs.mkdirSync(home);
  fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'test'));
  fs.writeFileSync(path.join(root,'src/add.mjs'),'export const add=(a,b)=>a-b;');
  fs.writeFileSync(path.join(root,'test/add.test.mjs'),'import {add} from "../src/add.mjs";import assert from "node:assert/strict";assert.equal(add(2,3),5);');
  const before=sha256(fs.readFileSync(path.join(root,'test/add.test.mjs')));
  const source=`(in-package :modkh)
(defmicroagent micro-js-edit :title "JS編集担当" :tool "edit_file" :workflow "edit-verify" :language "js" :task-kind "edit" :instruction "Fix addition" :max-turns 8)
(defmicroagent micro-js-outline :tool "code_outline" :language "js" :task-kind "outline" :instruction "Inspect structure")
(set-agent-check "micro-js-edit" "node --test test/add.test.mjs" :sources '("src/add.mjs") :protected '("test/add.test.mjs"))`;
  fs.writeFileSync(path.join(root,'agents.lisp'),source);
  fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({permissions:'all',language:{autoInstall:false}}));
  const head=[step('list','list_subagents',{}),step('outline-delegate','run_subagent',{pluginId:'micro-js-outline',task:'Inspect src/add.mjs'}),step('delegate','run_subagent',{pluginId:'micro-js-edit',task:'Fix add',targetPaths:['src/add.mjs']}),done];
  const observer=[step('outline','code_outline',{path:'src/add.mjs'}),done];
  const child=[step('read','read_file',{path:'src/add.mjs'}),step('edit','edit_file',{path:'src/add.mjs',old_string:'a-b',new_string:'a+b'}),done];
  const harness=`import {runChat} from ${JSON.stringify(chat)};import {FixedModel} from ${JSON.stringify(fixed)};import fs from 'node:fs';const head=new FixedModel(${JSON.stringify(head)}),observer=new FixedModel(${JSON.stringify(observer)}),child=new FixedModel(${JSON.stringify(child)});let count=0;await runChat({args:${JSON.stringify({cwd:root,model:'fixed/scripted','verification-isolation':isolation,'lisp-config':'agents.lisp','trust-lisp-sha256':sha256(source)})},modelFactory:()=>[head,observer,child][count++]});fs.writeFileSync(${JSON.stringify(path.join(root,'requests.json'))},JSON.stringify({head:head.requests,child:child.requests}));`;
  try {
    const process_=spawn(process.execPath,['--input-type=module','-e',harness],{cwd:root,env:{...privateEnvironment(home),MODKH_HOME:home,MODKH_PLAIN:'1',NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
    let output='';process_.stdout.on('data',b=>output+=b);process_.stderr.on('data',b=>output+=b);
    const timer=setTimeout(()=>process_.kill('SIGKILL'),10000);process_.stdin.end('Fix addition\n/exit\n');
    const exit=await new Promise<number|null>((resolve,reject)=>{process_.on('error',reject);process_.on('close',resolve);});clearTimeout(timer);
    assert.equal(exit,0,output);assert.match(fs.readFileSync(path.join(root,'src/add.mjs'),'utf8'),isolation==='required'?/a-b/:/a\+b/);
    assert.equal(sha256(fs.readFileSync(path.join(root,'test/add.test.mjs'))),before);
    const requests=JSON.parse(fs.readFileSync(path.join(root,'requests.json'),'utf8'));
    const names=requests.head[0].tools.map((t:{name:string})=>t.name);
    for(const denied of ['edit_file','create_file','run_command','verify_lean','verify_stateright'])assert.ok(!names.includes(denied),denied);
    const receipts=requests.head.at(-1).messages.flatMap((m:{role:string;results?:unknown[]})=>m.role==='tool'?m.results:[]);
    const delegations=receipts.filter((r:{name:string})=>r.name==='run_subagent');
    assert.equal(JSON.parse(delegations[0].output).status,'completed');
    const result=JSON.parse(delegations.at(-1).output);
    assert.equal(result.status,isolation==='required'?'error':'completed');
    assert.equal(result.verification.status,isolation==='required'?'not-executed':'passed');
    assert.equal(result.verification.receipt.exitCode,isolation==='required'?null:0);
    assert.equal(result.verification.receipt.state,isolation==='required'?'not-started':'exited');
    assert.equal(result.verification.receipt.cleanup,'settled');
    assert.equal(result.verification.isolationRequirement,isolation);
    assert.match(result.verification.receipt.inputDigest,/^[a-f0-9]{64}$/);
    assert.equal(result.verification.sourceDigests['src/add.mjs'],sha256('export const add=(a,b)=>a+b;'));
    const packageRoot=process.env.MODKH_TEST_PACKAGE_ROOT ?? new URL('..',import.meta.url).pathname;
    for(const skill of ['kiokuko-single-purpose-functions','one-shot-software-completion']) {
      const body=fs.readFileSync(path.join(packageRoot,'skills/kiokuko-dsh',skill,'SKILL.md'),'utf8');
      assert.ok(requests.child[0].system.includes(body),skill+' full body reaches actual child model request');
    }
    assert.deepEqual(requests.child[0].tools.map((t:{name:string})=>t.name),['read_file','edit_file']);
    for (const tool of requests.child[0].tools) assert.deepEqual(tool.parameters.properties.path.enum, ['src/add.mjs']);
    assert.match(requests.child[0].system, /The host runs the fixed acceptance test/);
    assert.match(requests.child[0].system, /Do not read protected tests/);
    assert.doesNotMatch(JSON.stringify(requests.child[0]), /test\/add\.test\.mjs/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

for (const ending of ['retry', 'stop', 'length']) test(`ordinary chat fails when the same editor exhausts its turns without editing: ${ending}`, async () => {
  const root = fs.realpathSync(temporaryDirectory('modkh-editor-limit-'));
  const content = 'export const add = (a, b) => a - b;\n';
  const marker = path.join(root, 'acceptance-ran');
  try {
    const source = fs.readFileSync(new URL('../experiments/presets/formal.lisp', import.meta.url), 'utf8') + `
(defmicroagent micro-editor :tool "edit_file" :workflow "edit-verify" :language "js" :task-kind "edit" :instruction "Fix addition" :max-turns 4)
(set-agent-check "micro-editor" ${JSON.stringify(`touch '${marker}'`)} :sources '("add.mjs") :protected '("protected.txt"))
(set-head-check-inputs "Model.json" "Proof.lean" "micro-editor")
`;
    fs.writeFileSync(path.join(root, 'agents.lisp'), source);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ permissions: 'all', language: { autoInstall: false } }));
    fs.writeFileSync(path.join(root, 'add.mjs'), content);
    fs.writeFileSync(path.join(root, 'protected.txt'), 'protected');
    const assignment = { pluginId: 'micro-editor', task: 'Implement addition in add', targetPaths: ['add.mjs'],
      behaviorChange: { before: 'add(2, 3) returns -1', after: 'add(2, 3) returns 5' } };
    const length = [{type: 'text-delta', text: 'unfinished planning'}, {type: 'finish', stopReason: 'length'}];
    const head = [...(ending === 'length' ? [length] : []), step('first', 'run_subagent', assignment),
      ...(ending === 'retry' ? [step('retry', 'run_subagent', assignment)] : []), ending === 'length' ? length : done];
    const child = [step('read-1', 'read_file', { path: 'add.mjs' }), done, step('read-2', 'read_file', { path: 'add.mjs' }), done];
    const args = { cwd: root, model: 'fixed/scripted', 'lisp-config': 'agents.lisp', 'trust-lisp-sha256': sha256(source) };
    const harness = `import {runChat} from ${JSON.stringify(chat)};
      import {FixedModel} from ${JSON.stringify(fixed)};
      const head = new FixedModel(${JSON.stringify(head)});
      await runChat({args:${JSON.stringify(args)}, modelFactory: () => head.requests.length ? new FixedModel(${JSON.stringify(child)}) : head});
      if (${ending === 'length'}) {
        const request = head.requests[1];
        if (request.tools.map(tool => tool.name).join(',') !== 'run_subagent' ||
            !JSON.stringify(request.messages).includes('export const add = (a, b) => a - b;')) {
          throw new Error('Recovery must give the head only delegation and the configured source');
        }
      }`;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', harness], {
      cwd: root, env: { ...privateEnvironment(root), MODKH_HOME: root, MODKH_PLAIN: '1', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout.on('data', chunk => output += chunk);
    proc.stderr.on('data', chunk => output += chunk);
    const timeout = setTimeout(() => proc.kill('SIGKILL'), 15_000);
    proc.stdin.end('Fix addition\n/exit\n');
    try {
      assert.equal(await new Promise((resolve, reject) => { proc.on('error', reject); proc.on('close', resolve); }), 0, output);
    } finally { clearTimeout(timeout); }
    const readJournal = (id: string) => fs.readFileSync(path.join(root, 'sessions', id), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const journal = fs.readdirSync(path.join(root, 'sessions')).filter(name => name.endsWith('.jsonl'))
      .map(readJournal).find(events => events[0]?.type === 'session' && !events[0].parentSessionId);
    assert.ok(journal, 'the parent session journal must exist');
    if (ending === 'length') {
      assert.equal(journal.filter(row => row.message?.content?.startsWith('(ホストの出力上限からの続行)')).length, 1, output);
      assert.match(output, /EDIT_TURN_LIMIT/);
    }
    const delegations = journal.filter(row => row.type === 'delegation');
    assert.equal(delegations.filter(row => row.record.state === 'starting').length, 1, output);
    const finished = delegations.find(row => row.record.state === 'finished').record;
    assert.equal(finished.result.code, 'EDIT_TURN_LIMIT');
    assert.equal(finished.result.verification, undefined);
    assert.equal(finished.result.status, 'error');
    const childJournal = readJournal(finished.childSessionId + '.jsonl');
    const receipts = childJournal.flatMap(row => row.message?.role === 'tool' ? row.message.results : []);
    assert.deepEqual(receipts.map(r => [r.name, r.status]), [
      ['read_file', 'ok'], // Host preloads the authorized source before the first model call.
      ['read_file', 'ok'], ['read_file', 'ok'],
    ]);
    assert.deepEqual(receipts.slice(1).map(r => r.callId), ['read-1', 'read-2']);
    assert.ok(childJournal.slice(0, -1).some(row => row.message?.content?.startsWith('(ホストの編集完了確認)')));
    const results = journal.flatMap(row => row.message?.role === 'tool' ? row.message.results : []);
    assert.ok(results.some(r => r.callId === 'first' && JSON.parse(r.output).code === 'EDIT_TURN_LIMIT'));
    if (ending === 'retry') assert.equal(results.find(r => r.callId === 'retry')?.status, 'not-executed');
    assert.match(output, /編集は不合格.*上限/);
    assert.equal(journal.at(-1).status, 'error');
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(path.join(root, 'add.mjs'), 'utf8'), content);
    assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'protected');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
