import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentLoop } from '../src/agent/loop.ts';
import { SubagentService, subagentTools, type SubagentOptions } from '../src/subagents/service.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { SessionStore } from '../src/session/store.ts';
import { JobRegistry } from '../src/tools/jobs.ts';
import { FixedModel, type FixedStep } from '../src/model/fixed.ts';
import { defaultTools, ToolRegistry } from '../src/tools/registry.ts';
import { TerminalApprovalGate } from '../src/cli/approval.ts';
import { parseAgentSettings } from '../src/subagents/settings.ts';

const done: FixedStep = [{ type: 'text-delta', text: 'Observed result' }, { type: 'finish', stopReason: 'stop' }];
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-subagents-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = fs.realpathSync(directory);
  const store = new SessionStore(path.join(root, 'sessions'));
  const parent = store.create(root, 'fixed/scripted');
  const manager = new PluginManager(path.join(root, 'home'));
  const models: FixedModel[] = [];
  const approvals: string[] = [];
  const opts: SubagentOptions = {
    manager, store, parent, root, tools: defaultTools(),
    approval: { approve: async req => { approvals.push(req.title); return true; } },
    connection: () => ({ ref: 'fixed/scripted', create: () => { const model = new FixedModel([done]); models.push(model); return model; } }),
  };
  return { root, store, parent, manager, models, approvals, opts };
}
const owner = (callId = 'call-1', signal = new AbortController().signal) => ({ callId, signal });
const request = { pluginId: 'modkh-explorer', task: 'Read current sources' };
function externalFixture(root: string, manager: PluginManager, body: string): string {
  const directory = path.join(root, 'external');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ apiVersion: 1, id: 'external-test', version: '1', title: 'External', description: 'Managed fixture', kind: 'external', entry: './index.mjs' }));
  fs.writeFileSync(path.join(directory, 'index.mjs'), body);
  manager.install(directory, manager.preview(directory).digest);
  return 'external-test';
}

test('child owns a fresh model and history; exact replay never executes again', async t => {
  const f = fixture(t);
  f.parent.append({ role: 'user', content: 'parent-only-private' });
  const service = new SubagentService(f.opts);
  const result = await (await service.start(request, owner())).result;
  assert.equal(result.status, 'completed');
  assert.equal(f.models.length, 1);
  assert.deepEqual(f.models[0].requests[0].messages, [{ role: 'user', content: request.task }]);
  assert.deepEqual(f.models[0].requests[0].tools.map(tool => tool.name), ['list_files', 'search_files', 'read_file', 'list_skills', 'read_skill']);
  assert.equal(f.parent.messages.length, 1);
  assert.deepEqual(f.parent.delegations()[0].effectiveTools, ['list_files', 'search_files', 'read_file', 'list_skills', 'read_skill']);
  const child = f.store.load(result.agentId);
  assert.equal(child.parentSessionId, f.parent.id);
  assert.equal(child.rootSessionId, f.parent.id);
  assert.deepEqual(await (await service.start(request, owner())).result, result);
  assert.equal(f.models.length, 1);
  await assert.rejects(service.start({ ...request, task: 'changed' }, owner()), /同じID/);
  const nested = new SubagentService({ ...f.opts, parent: child });
  await assert.rejects(nested.start(request, owner()), /再委譲/);
});

test('read-only plugin cannot execute writes, shell commands or delegation even when requested by its model', async t => {
  const f = fixture(t);
  const steps: FixedStep[] = [[
    { type: 'tool-call', call: { id: 'write', name: 'create_file', args: { path: 'forbidden', content: 'bad' } } },
    { type: 'tool-call', call: { id: 'shell', name: 'run_command', args: { command: 'touch forbidden' } } },
    { type: 'tool-call', call: { id: 'nested', name: 'run_subagent', args: request } },
    { type: 'finish', stopReason: 'tool-calls' },
  ], done];
  const service = new SubagentService({ ...f.opts, connection: () => ({ ref: 'fixed/scripted', create: () => new FixedModel(steps) }) });
  const result = await (await service.start(request, owner())).result;
  const messages = f.store.load(result.agentId).messages;
  const errors = messages.flatMap(m => m.role === 'tool' ? m.results : []);
  assert.equal(errors.length, 3);
  assert.ok(errors.every(r => r.status === 'error'));
  assert.equal(fs.existsSync(path.join(f.root, 'forbidden')), false);
  assert.deepEqual(f.approvals, []);
});

test('worker approval names the exact child, and denied edits leave no file', async t => {
  const f = fixture(t);
  const steps: FixedStep[] = [[{ type: 'tool-call', call: { id: 'write', name: 'create_file', args: { path: 'denied', content: 'bad' } } }, { type: 'finish', stopReason: 'tool-calls' }], done];
  const service = new SubagentService({ ...f.opts, approval: { approve: async req => { f.approvals.push(req.title); return false; } }, connection: () => ({ ref: 'fixed/scripted', create: () => new FixedModel(steps) }) });
  const result = await (await service.start({ ...request, pluginId: 'modkh-worker' }, owner())).result;
  assert.match(f.approvals[0], new RegExp(`modkh-worker / ${result.agentId}`));
  assert.equal(fs.existsSync(path.join(f.root, 'denied')), false);
});

test('child cancellation releases only its approval waiter and returns to the parent', async t => {
  const f = fixture(t);
  let requested!: () => void;
  const reached = new Promise<void>(resolve => { requested = resolve; });
  // The subject is an approval waiter, so use the policy that always prompts.
  const gate = new TerminalApprovalGate({ write: () => {}, ask: (_prompt, signal) => new Promise<string>(resolve => { requested(); signal?.addEventListener('abort', () => resolve(''), { once: true }); }) }, 'none');
  const model = new FixedModel([[{ type: 'tool-call', call: { id: 'write', name: 'create_file', args: { path: 'cancelled', content: 'bad' } } }, { type: 'finish', stopReason: 'tool-calls' }], done]);
  const service = new SubagentService({ ...f.opts, maxConcurrent: 1, approval: gate, connection: () => ({ ref: 'fixed/scripted', create: () => model }) });
  const handle = await service.start({ ...request, pluginId: 'modkh-worker' }, owner('call-1', AbortSignal.timeout(3000)));
  try {
    await reached;
    await assert.rejects(service.start(request, owner('other')), /1つまで/);
  } finally {
    await handle.cancel('test cleanup');
  }
  assert.equal((await handle.result).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(f.root, 'cancelled')), false);
});

test('uncertain child effects propagate through the public tool and block new IDs', async t => {
  const f = fixture(t);
  const tool = { name: 'create_file', description: 'uncertain write', parameters: { type: 'object', properties: {} }, execute: async () => { fs.appendFileSync(path.join(f.root, 'effects'), 'once'); throw new Error('lost receipt'); } };
  const steps: FixedStep[] = [[{ type: 'tool-call', call: { id: 'effect', name: 'create_file', args: {} } }, { type: 'finish', stopReason: 'tool-calls' }]];
  const service = new SubagentService({ ...f.opts, tools: [tool], connection: () => ({ ref: 'fixed/scripted', create: () => new FixedModel(steps) }) });
  const registry = new ToolRegistry(subagentTools(service));
  const call = { id: 'delegate', name: 'run_subagent', args: { ...request, pluginId: 'modkh-worker' } };
  const ctx = { root: f.root, approval: f.opts.approval, signal: new AbortController().signal };
  const first = await registry.executeOne(call, ctx);
  assert.equal(first.status, 'unknown');
  assert.equal((await registry.executeOne({ ...call, id: 'new-id' }, ctx)).status, 'unknown');
  assert.equal(fs.readFileSync(path.join(f.root, 'effects'), 'utf8'), 'once');
});

test('lost parent result persistence remains pending on cold resume and is never replayed', async t => {
  const f = fixture(t);
  const original = f.parent.recordDelegation.bind(f.parent);
  f.parent.recordDelegation = record => { if (record.state === 'finished') throw new Error('disk full'); original(record); };
  const service = new SubagentService(f.opts);
  await assert.rejects((await service.start(request, owner())).result, /disk full/);
  const parent = f.store.load(f.parent.id);
  assert.equal(parent.delegations()[0].result, undefined);
  const resumed = new SubagentService({ ...f.opts, parent });
  assert.equal((await (await resumed.start(request, owner())).result).status, 'unknown');
  await assert.rejects(resumed.start(request, owner('new-id')), /結果が不明/);
  assert.equal(f.models.length, 1);
});

test('invalid requests, pre-start Stop and disabled plugins create no child sessions', async t => {
  const f = fixture(t);
  const service = new SubagentService(f.opts);
  await assert.rejects(service.start({ ...request, extra: true }, owner()), /Unknown field/);
  await assert.rejects(service.start({ ...request, task: 'x'.repeat(32769) }, owner()), /Invalid task/);
  await assert.rejects(service.start(request, owner('stop', AbortSignal.abort())), /中断済み/);
  f.manager.setEnabled('modkh-explorer', false);
  await assert.rejects(service.start(request, owner()), /利用できない/);
  assert.equal(f.store.list().length, 1);
  assert.deepEqual(f.parent.delegations(), []);
});

test('legacy sessions remain readable and gain an append-only format event when delegating', async t => {
  const f = fixture(t);
  const file = path.join(f.root, 'sessions', `${f.parent.id}.jsonl`);
  const header = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete header.version;
  const legacy = JSON.stringify(header) + '\n';
  fs.writeFileSync(file, legacy);
  const parent = f.store.load(f.parent.id);
  await (await new SubagentService({ ...f.opts, parent }).start(request, owner())).result;
  const contents = fs.readFileSync(file, 'utf8');
  assert.ok(contents.startsWith(legacy));
  assert.ok(contents.includes('\"type\":\"format\",\"version\":2'));
  assert.equal(f.store.load(f.parent.id).delegations()[0].result?.status, 'completed');
});

test('malformed per-plugin settings fail closed without changing another plugin', () => {
  const parsed = parseAgentSettings({ 'modkh-worker': { tools: 'all' }, 'modkh-explorer': { tools: ['read_file'] } });
  assert.equal(parsed.settings['modkh-worker'].disabled, true);
  assert.deepEqual(parsed.settings['modkh-explorer'].tools, ['read_file']);
  assert.equal(parseAgentSettings(null).unavailable, true);
});

test('external adapters see only the host facade; process credentials and results stay managed', async t => {
  const f = fixture(t);
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-never-inherit';
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
  const id = externalFixture(f.root, f.manager, `export async function start(request, host) {
    if (Object.keys(host).sort().join(',') !== 'run,signal') throw new Error('owner leaked');
    return { result: host.run({command: process.execPath, args: ['-e', 'console.log(process.env.OPENAI_API_KEY ?? \"NO_KEY\")']}).then(r => ({text:r.output})), stop: async () => {} };
  }`);
  const result = await (await new SubagentService(f.opts).start({ pluginId: id, task: 'Report environment isolation' }, owner())).result;
  assert.equal(result.status, 'completed', result.diagnostic);
  assert.match(result.text, /NO_KEY/);
  assert.equal(result.cleanup, 'settled');
  assert.equal(f.approvals.length, 2);
  assert.equal(result.text.includes('test-never-inherit'), false);
});

test('external nonzero exit cannot be overwritten by a plugin claiming completion', async t => {
  const f = fixture(t);
  const id = externalFixture(f.root, f.manager, `export async function start(request, host) { return { result: host.run({command:process.execPath,args:['-e','process.exit(7)']}).then(() => ({text:'claimed success'})), stop: async () => {} }; }`);
  const result = await (await new SubagentService(f.opts).start({ pluginId: id, task: 'Run fixture' }, owner())).result;
  assert.equal(result.status, 'error');
  assert.equal(result.text, 'claimed success');
});

for (const failure of ['throw', 'reject', 'missing-handle']) {
  test(`external ${failure} during startup retains its unreconciled lease and blocks replay`, async t => {
    const f = fixture(t);
    const marker = path.join(f.root, 'startup-effects');
    const fail = failure === 'throw' ? "throw new Error('startup failed')" : failure === 'reject' ? "return Promise.reject(new Error('startup failed'))" : 'return undefined';
    const id = externalFixture(f.root, f.manager, `import fs from 'node:fs'; export function start() {
      fs.appendFileSync(${JSON.stringify(marker)}, 'once'); ${fail};
    }`);
    const service = new SubagentService(f.opts);
    const task = { pluginId: id, task: 'Probe startup failure' };
    const result = await (await service.start(task, owner())).result;
    assert.equal(result.status, 'unknown');
    assert.equal(result.cleanup, 'unknown');
    assert.throws(() => f.manager.remove(id), /unreconciled lease/);
    assert.deepEqual(await (await service.start(task, owner())).result, result);
    await assert.rejects(service.start(task, owner('new-id')), /結果が不明/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'once');
    assert.equal(f.store.load(f.parent.id).delegations()[0].result?.cleanup, 'unknown');
  });
}

test('external close cancels an unawaited process approval without aborting the parent', async t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'must-not-run');
  const id = externalFixture(f.root, f.manager, `export function start(request, host) {
    void host.run({command:process.execPath,args:['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`)}]});
    return { result: Promise.resolve({text:'captured'}), stop: async () => {} };
  }`);
  let prompts = 0;
  let processSignal: AbortSignal | undefined;
  const gate = new TerminalApprovalGate({ write: () => {}, ask: async (_prompt, signal) => {
    if (++prompts !== 2) return 'y';
    processSignal = signal;
    return new Promise<string>(resolve => {
      if (signal?.aborted) resolve('');
      else signal?.addEventListener('abort', () => resolve(''), { once: true });
    });
  } });
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort('test watchdog'), 5000);
  try {
    const service = new SubagentService({ ...f.opts, approval: gate });
    const result = await (await service.start({ pluginId: id, task: 'Finish with pending approval' }, owner('pending', controller.signal))).result;
    assert.equal(controller.signal.aborted, false, 'cleanup must finish without cancelling the parent');
    assert.equal(processSignal?.aborted, true);
    assert.equal(result.status, 'error', 'an unexecuted managed process cannot be reported as success');
    assert.equal(result.cleanup, 'settled');
    assert.equal(result.text, 'captured');
    assert.equal(prompts, 2);
    assert.equal(fs.existsSync(marker), false);
    const child = f.store.load(result.agentId);
    const receipts = child.messages.flatMap(m => m.role === 'tool' ? m.results : []);
    assert.equal(receipts.find(r => r.name === 'external_process')?.status, 'not-executed');
    assert.equal(await gate.approve({ kind: 'command', title: 'Next parent approval', detail: 'true' }), true);
    f.manager.remove(id);
  } finally {
    clearTimeout(watchdog);
    controller.abort();
  }
});

test('external teardown failure preserves captured output but is unknown, retaining the lease', async t => {
  const f = fixture(t);
  const id = externalFixture(f.root, f.manager, `export async function start() { return {result:Promise.resolve({text:'captured'}),stop:async()=>{throw new Error('teardown failed')}}; }`);
  const result = await (await new SubagentService(f.opts).start({ pluginId: id, task: 'Run fixture' }, owner())).result;
  assert.equal(result.status, 'unknown');
  assert.equal(result.cleanup, 'unknown');
  assert.equal(result.text, 'captured');
  assert.throws(() => f.manager.remove(id), /unreconciled lease/);
});

test('Stop during asynchronous module loading does not claim settled cleanup', async t => {
  const f = fixture(t);
  const id = externalFixture(f.root, f.manager, 'await new Promise(resolve => setTimeout(resolve, 200)); export async function start() { return {result:Promise.resolve({text:\"late\"}),stop:async()=>{}}; }');
  const result = await (await new SubagentService(f.opts).start({ pluginId: id, task: 'Stop during load' }, owner('loading', AbortSignal.timeout(40)))).result;
  assert.equal(result.status, 'unknown');
  assert.equal(result.cleanup, 'unknown');
  assert.deepEqual(f.approvals, []);
  assert.throws(() => f.manager.remove(id), /unreconciled lease/);
});

test('parent model delegates through the ordinary agent loop and consumes a persisted child result', async t => {
  const f = fixture(t);
  f.parent.append({ role: 'user', content: 'Delegate a bounded investigation' });
  const service = new SubagentService(f.opts);
  const parentModel = new FixedModel([[{ type: 'tool-call', call: { id: 'model-delegation', name: 'run_subagent', args: request } }, { type: 'finish', stopReason: 'tool-calls' }], done]);
  const result = await runAgentLoop(f.parent.messages, { model: parentModel, registry: new ToolRegistry([...defaultTools(), ...subagentTools(service)]), root: f.root, approval: f.opts.approval, signal: new AbortController().signal, checkpoint: () => f.parent.persistFrom(0) });
  assert.equal(result.outcome, 'complete');
  assert.equal(parentModel.requests.length, 2);
  assert.equal(f.models.length, 1);
  const receipt = parentModel.requests[1].messages.flatMap(m => m.role === 'tool' ? m.results : []).find(r => r.name === 'run_subagent')!;
  assert.equal(receipt.status, 'ok');
  assert.equal(JSON.parse(receipt.output).runId, f.parent.delegations()[0].runId);
  assert.equal(f.store.load(f.parent.id).delegations()[0].result?.status, 'completed');
});

test('effective permissions are the intersection of parent, user and plugin policy', async t => {
  const f = fixture(t);
  const service = new SubagentService({ ...f.opts, tools: defaultTools().filter(t => ['read_file', 'create_file'].includes(t.name)), settings: { 'modkh-explorer': { tools: ['read_file', 'run_command'] } } });
  await (await service.start(request, owner())).result;
  assert.deepEqual(f.models[0].requests[0].tools.map(t => t.name), ['read_file']);
  assert.deepEqual(f.parent.delegations()[0].effectiveTools, ['read_file']);
});

test('async delegation lets the parent work with two live children, then collects both before completion', async t => {
  const f = fixture(t);
  const releases: (() => void)[] = [];
  const service = new SubagentService({ ...f.opts, connection: () => ({ ref: 'fixed/scripted', create: () => ({
    id: 'fixed/child', async *stream() {
      await new Promise<void>(resolve => { releases.push(resolve); });
      yield* done;
    },
  }) }) });
  const registry = new ToolRegistry([...subagentTools(service), {
    name: 'parent_work', readOnly: true, description: 'Independent parent work', parameters: { type: 'object', properties: {} },
    execute: async () => {
      // Starting returns before the child even reaches its model; wait only in the fixture.
      for (let i = 0; releases.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(f.parent.delegations().filter(r => !r.result).length, 2);
      releases.forEach(release => release());
      return 'parent progressed while both children were running';
    },
  }]);
  const parentModel = new FixedModel([
    [{ type: 'tool-call', call: { id: 'one', name: 'start_subagent', args: request } },
      { type: 'tool-call', call: { id: 'two', name: 'start_subagent', args: request } },
      { type: 'finish', stopReason: 'tool-calls' }],
    [{ type: 'tool-call', call: { id: 'parent', name: 'parent_work', args: {} } }, { type: 'finish', stopReason: 'tool-calls' }], done, done, done,
  ]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  t.after(() => clearTimeout(timeout));
  f.parent.append({ role: 'user', content: 'Investigate two independent parts and integrate them' });
  const result = await runAgentLoop(f.parent.messages, { model: parentModel, registry, root: f.root,
    approval: f.opts.approval, signal: controller.signal, subagents: service, skills: false });
  assert.equal(result.outcome, 'complete');
  assert.equal(f.parent.delegations().length, 2);
  assert.ok(f.parent.delegations().every(r => r.result?.status === 'completed'));
  assert.ok(parentModel.requests.some(r => r.messages.some(m => m.role === 'user' && m.content.includes('子エージェントの完了通知'))));
});

for (const wake of ['followup', 'job'] as const) {
  test(`parent resumes for a ${wake} during child wait and still integrates the child`, async t => {
    const f = fixture(t);
    let releaseChild!: () => void;
    const child = new Promise<void>(resolve => { releaseChild = resolve; });
    const service = new SubagentService({ ...f.opts, connection: () => ({ ref: 'fixed/child', create: () => ({
      id: 'fixed/child', async *stream() { await child; yield* done; },
    }) }) });
    const jobs = new JobRegistry();
    t.after(() => jobs.close());
    const queued: string[] = [];
    const arrived = new AbortController();
    const model = new FixedModel([done, done, done]);
    await service.start(request, owner());
    let handledWhilePending = false;
    const timeout = setTimeout(releaseChild, 5000);
    t.after(() => clearTimeout(timeout));
    let submitted = false;
    const result = await runAgentLoop(f.parent.messages, {
      model, registry: new ToolRegistry([]), root: f.root, approval: f.opts.approval,
      signal: new AbortController().signal, subagents: service, jobs, skills: false,
      followupSignal: () => arrived.signal,
      takeFollowups: () => queued.splice(0),
      hooks: {
        onSubagentWait() {
          if (submitted) return;
          submitted = true;
          setImmediate(() => {
            if (wake === 'job') jobs.start({ command: 'echo independent-result', cwd: f.root, shell: 'sh' });
            else { queued.push('independent-result'); arrived.abort(); }
          });
        },
        onModelRequest() {
          if (f.parent.messages.some(m => m.role === 'user' && m.content.includes('independent-result'))) {
            if (service.hasPending) handledWhilePending = true;
            releaseChild();
          }
        },
      },
    });
    assert.equal(handledWhilePending, true);
    assert.equal(result.outcome, 'complete');
    assert.ok(model.requests.at(-1)?.messages.some(m => m.role === 'user' && m.content.includes('子エージェントの完了通知')));
  });
}

test('async tools enforce two slots, expose running status, cancel independently and preserve cold receipts', async t => {
  const f = fixture(t);
  const service = new SubagentService({ ...f.opts, connection: () => ({ ref: 'fixed/scripted', create: () => ({
    id: 'fixed/blocked', async *stream(_request, signal) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      yield { type: 'finish' as const, stopReason: 'aborted' as const };
    },
  }) }) });
  const registry = new ToolRegistry(subagentTools(service));
  const controller = new AbortController();
  const ctx = { root: f.root, approval: f.opts.approval, signal: controller.signal };
  t.after(async () => { controller.abort(); await service.cancelAll('test cleanup'); });
  const call = async (id: string, name: string, args: Record<string, unknown>) => registry.executeOne({ id, name, args }, ctx);
  const first = await call('one', 'start_subagent', request);
  assert.equal(first.status, 'ok');
  const second = await call('two', 'start_subagent', request);
  assert.equal(second.status, 'ok');
  assert.match((await call('three', 'start_subagent', request)).output, /CAPACITY/);
  const runId = JSON.parse(first.output).runId;
  assert.equal(JSON.parse((await call('read', 'subagent_output', { runId })).output).status, 'running');
  assert.equal((await call('stop', 'cancel_subagent', { runId })).status, 'ok');
  assert.equal(service.hasPending, true);
  const cold = new ToolRegistry(subagentTools(new SubagentService(f.opts)));
  const receipt = await cold.executeOne({ id: 'cold', name: 'subagent_output', args: { runId } }, ctx);
  assert.equal(JSON.parse(receipt.output).status, 'cancelled');
  assert.equal((await call('foreign', 'subagent_output', { runId: 'not-owned' })).status, 'error');
});

for (const ending of ['error', 'turn-limit', 'stop'] as const) {
  test(`parent ${ending} reaps both asynchronous children`, async t => {
    const f = fixture(t);
    const controller = new AbortController();
    let started = 0;
    const service = new SubagentService({ ...f.opts, connection: () => ({ ref: 'fixed/scripted', create: () => ({
      id: 'fixed/blocked', async *stream(_request, signal) {
        started++;
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
        yield { type: 'finish' as const, stopReason: 'aborted' as const };
      },
    }) }) });
    const registry = new ToolRegistry([...subagentTools(service), { name: 'await_started', readOnly: true, description: 'Fixture barrier', parameters: { type: 'object', properties: {} }, execute: async () => {
      for (let i = 0; started < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(started, 2);
      if (ending === 'stop') controller.abort();
      return 'both started';
    } }]);
    const model = new FixedModel([[{ type: 'tool-call', call: { id: 'a', name: 'start_subagent', args: request } },
      { type: 'tool-call', call: { id: 'b', name: 'start_subagent', args: request } },
      { type: 'tool-call', call: { id: 'barrier', name: 'await_started', args: {} } }, { type: 'finish', stopReason: 'tool-calls' }],
      [{ type: 'finish', stopReason: 'error', errorMessage: 'provider failed' }]]);
    const result = await runAgentLoop(f.parent.messages, { model, registry, root: f.root, approval: f.opts.approval,
      signal: controller.signal, subagents: service, maxTurns: ending === 'turn-limit' ? 1 : 10, skills: false });
    assert.equal(result.outcome, ending === 'stop' ? 'interrupted' : ending);
    assert.equal(service.hasPending, false);
    assert.equal(f.parent.delegations().length, 2);
    assert.ok(f.parent.delegations().every(r => r.result?.status === 'cancelled' && r.result.cleanup === 'settled'));
  });
}

test('a child writer blocks conflicting effects but permits parent reads and another explorer', async t => {
  const f = fixture(t);
  let writerReady!: () => void;
  const ready = new Promise<void>(resolve => writerReady = resolve);
  const service = new SubagentService({ ...f.opts, maxConcurrent: 3, connection: () => ({ ref: 'fixed/scripted', create: () => ({
    id: 'fixed/blocked', async *stream(req, signal) {
      if (req.tools.some(t => t.name === 'edit_file')) writerReady();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
      yield { type: 'finish' as const, stopReason: 'aborted' as const };
    },
  }) }) });
  t.after(() => service.cancelAll('test cleanup'));
  const writer = await service.start({ ...request, pluginId: 'modkh-worker' }, owner('writer'));
  await ready;
  const reader = await service.start(request, owner('reader'));
  const conflicting = await service.start({ ...request, pluginId: 'modkh-worker' }, owner('conflict'));
  assert.match((await conflicting.result).diagnostic ?? '', /競合/);
  const registry = new ToolRegistry(service.parentTools(defaultTools()));
  const ctx = { root: f.root, approval: f.opts.approval, signal: new AbortController().signal };
  assert.equal((await registry.executeOne({ id: 'read', name: 'list_files', args: {} }, ctx)).status, 'ok');
  assert.match((await registry.executeOne({ id: 'write', name: 'create_file', args: { path: 'parent.txt', content: 'write' } }, ctx)).output, /BUSY/);
  assert.equal(fs.existsSync(path.join(f.root, 'parent.txt')), false);
  await writer.cancel('done');
  assert.equal((await registry.executeOne({ id: 'write-after', name: 'create_file', args: { path: 'parent.txt', content: 'write' } }, ctx)).status, 'ok');
  await reader.cancel('done');
});

test('lowering the limit preserves live children; raising it admits another and exact replay consumes no slot', async t => {
  const f = fixture(t);
  const service = new SubagentService({ ...f.opts, connection: () => ({ ref: 'fixed/scripted', create: () => ({ id: 'fixed/wait', async *stream(_r, signal) {
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    yield { type: 'finish' as const, stopReason: 'aborted' as const };
  } }) }) });
  t.after(() => service.cancelAll('test cleanup'));
  const one = await service.start(request, owner('one'));
  const two = await service.start(request, owner('two'));
  service.setMaxConcurrent(1);
  assert.equal((await service.start(request, owner('one'))).runId, one.runId);
  await assert.rejects(service.start(request, owner('three')), /1つまで/);
  assert.equal(f.parent.delegations().filter(r => !r.result).length, 2);
  service.setMaxConcurrent(3);
  const three = await service.start(request, owner('three'));
  assert.notEqual(two.runId, three.runId);
  assert.throws(() => service.setMaxConcurrent(0), /1〜16/);
});

test('async result persistence failure produces an unknown receipt and prevents replay', async t => {
  const f = fixture(t);
  const original = f.parent.recordDelegation.bind(f.parent);
  f.parent.recordDelegation = record => { if (record.state === 'finished') throw new Error('disk full'); original(record); };
  const service = new SubagentService(f.opts);
  const handle = await service.start(request, owner('async-failure'));
  await assert.rejects(handle.result, /disk full/);
  const receipt = await service.output(handle.runId, 0, new AbortController().signal);
  assert.equal(receipt.status, 'unknown');
  assert.equal(service.hasUnknown, true);
  await assert.rejects(service.start(request, owner('new')), /結果が不明/);
  assert.equal(f.models.length, 1);
});

test('cold resume re-supplies asynchronous completion evidence without another child model', async t => {
  const f = fixture(t);
  f.parent.append({ role: 'assistant', content: '', toolCalls: [{ id: 'async-saved', name: 'start_subagent', args: request }] });
  const service = new SubagentService(f.opts);
  const handle = await service.start(request, owner('async-saved'));
  f.parent.append({ role: 'tool', results: [{ callId: 'async-saved', name: 'start_subagent', status: 'ok', output: JSON.stringify({ runId: handle.runId, status: 'started' }) }] });
  await handle.result;
  const parent = f.store.load(f.parent.id);
  const resumed = new SubagentService({ ...f.opts, parent });
  const notices = resumed.takeNotices();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Observed result/);
  assert.equal(JSON.parse(notices[0]).runId, handle.runId);
  assert.deepEqual(resumed.takeNotices(), []);
  assert.equal(f.models.length, 1);
});

test('the same editor repairs a rejected patch and applies it without a final model response', async t => {
  const f = fixture(t);
  const digest = 'a'.repeat(64);
  const id = 'micro-test-editor';
  fs.writeFileSync(path.join(f.root, 'source.txt'), 'before\n');
  fs.writeFileSync(path.join(f.root, 'protected.txt'), 'after\n');
  f.manager.registerSessionDefinitions([{
    descriptor: { id, version: '1', title: 'Editor', description: 'Editor fixture', kind: 'local', apiVersion: 1, digest, enabled: true, builtin: false, entry: './index.mjs' },
    definition: {
      system: 'Edit the source', tools: ['read_file', 'edit_file'], workflow: 'edit-verify', requireAllTools: true,
      verificationCommand: 'cmp source.txt protected.txt',
      verificationManifest: { sources: ['source.txt'], protected: ['protected.txt'] },
    },
  }], digest);
  const script = new FixedModel([[
    { type: 'tool-call', call: { id: 'read', name: 'read_file', args: { path: 'source.txt' } } },
    { type: 'finish', stopReason: 'tool-calls' },
  ], done, [
    { type: 'tool-call', call: { id: 'bad-edit', name: 'edit_file', args: { path: 'source.txt', old_string: 'before', new_string: 'wrong' } } },
    { type: 'finish', stopReason: 'tool-calls' },
  ], [
    { type: 'tool-call', call: { id: 'edit', name: 'edit_file', args: { path: 'source.txt', old_string: 'wrong', new_string: 'after' } } },
    { type: 'finish', stopReason: 'tool-calls' },
  ]]);
  const setTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) =>
    setTimer(callback, delay === 120_000 ? 2000 : delay));
  let checks = 0;
  const service = new SubagentService({
    ...f.opts,
    headInputs: { model: 'Model.json', lean: 'Proof.lean', editor: { id, path: 'source.txt' } },
    headUserRequest: () => 'Use the word after, preserving the trailing newline.',
    connection: () => ({ ref: script.id, create: () => script }),
    approval: { approve: async req => {
      if (req.kind === 'command') {
        checks++;
        assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'before\n');
        await new Promise(resolve => setTimer(resolve, 2100));
      }
      return true;
    } },
  });
  const result = await (await service.start({ pluginId: id, task: 'Fix source', targetPaths: ['source.txt'], behaviorChange: { before: 'Returns before', after: 'Returns after' } }, owner())).result;
  assert.equal(result.verification?.application, 'applied', JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8'), 'after\n');
  assert.equal(f.parent.delegations().length, 1);
  assert.equal(checks, 2);
  assert.match(JSON.stringify(script.requests[0].messages), /preserving the trailing newline/);
  assert.ok(script.requests[0].messages.some(m => m.role === 'tool' && m.results.some(r => r.name === 'read_file')));
  assert.equal(script.requests.length, 4);
  assert.match(JSON.stringify(script.requests[3].messages), /保護テスト.*不合格/);
  assert.doesNotMatch(JSON.stringify(script.requests[3].messages), /protected\.txt/);
  assert.match(JSON.stringify(script.requests[2].messages), /ホストの編集完了確認/);
  assert.equal(f.store.load(result.agentId).messages.filter(m => m.role === 'tool').length, 4);
});

test('bound Lisp editor rejects an assignment without an observable behavior change before creating a child', async t => {
  const f = fixture(t);
  const id = 'micro-editor';
  const digest = 'b'.repeat(64);
  f.manager.registerSessionDefinitions([{
    descriptor: { id, version: '1', title: 'Editor', description: 'Editor fixture', kind: 'local', apiVersion: 1, digest, enabled: true, builtin: false, entry: './index.mjs' },
    definition: {
      system: 'Edit the source', tools: ['edit_file'], workflow: 'edit-verify',
      verificationCommand: 'exit 0',
      verificationManifest: { sources: ['source.txt'], protected: ['check.txt'] },
    },
  }], digest);
  fs.writeFileSync(path.join(f.root, 'source.txt'), 'before');
  fs.writeFileSync(path.join(f.root, 'check.txt'), 'protected');
  const service = new SubagentService({ ...f.opts, headInputs: {
    model: 'Model.json', lean: 'Proof.lean', editor: { id, path: 'source.txt' },
  } });
  const request = { pluginId: id, task: 'Confirm the change', targetPaths: ['source.txt'] };
  await assert.rejects(service.start(request, owner()), /behaviorChange/);
  assert.deepEqual(f.parent.delegations(), []);
  await assert.rejects(service.start({ ...request, behaviorChange: { before: 'works as expected', after: 'works correctly' } }, owner()), /observable/);
  await assert.rejects(service.start({ ...request, targetPaths: ['check.txt'], behaviorChange: { before: 'At capacity reserve increments the count', after: 'At capacity reserve leaves the count unchanged' } }, owner()), /source.txt/);
  assert.deepEqual(f.models, []);
  assert.deepEqual(f.parent.delegations(), []);
});
