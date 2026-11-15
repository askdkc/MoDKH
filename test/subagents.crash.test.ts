import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SessionStore } from '../src/session/store.ts';
import { PluginManager } from '../src/plugins/manager.ts';
import { SubagentService } from '../src/subagents/service.ts';

for (const phase of ['starting', 'child', 'running', 'effect', 'finished']) {
  test(`cold resume after process exit at ${phase} never repeats a child effect`, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-crash-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const processResult = spawnSync(process.execPath, [new URL('./fixtures/delegation-crash.mjs', import.meta.url).pathname, root, phase], { encoding: 'utf8', timeout: 10000 });
    assert.equal(processResult.status, 23, processResult.stderr);
    const store = new SessionStore(path.join(root, 'sessions'));
    const parent = store.load(fs.readFileSync(path.join(root, 'parent-id'), 'utf8'));
    const parentReceipt = parent.messages.flatMap(m => m.role === 'tool' ? m.results : []).find(r => r.callId === 'crash-call');
    assert.equal(parentReceipt?.status, phase === 'finished' ? 'ok' : 'unknown');
    const manager = new PluginManager(path.join(root, 'home'));
    manager.setEnabled('modkh-worker', false);
    const service = new SubagentService({ parent, store, manager, root, tools: [], approval: { approve: async () => { throw new Error('Must not approve on replay'); } }, connection: () => { throw new Error('Must not create model on replay'); } });
    const result = await (await service.start({ pluginId: 'modkh-worker', task: 'Crash boundary' }, { callId: 'crash-call', signal: new AbortController().signal })).result;
    assert.equal(result.status, phase === 'finished' ? 'completed' : 'unknown');
    if (phase !== 'finished') await assert.rejects(service.start({ pluginId: 'modkh-worker', task: 'Crash boundary' }, { callId: 'new-id', signal: new AbortController().signal }), /結果が不明/);
    const marker = path.join(root, 'effect-count');
    assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', ['effect', 'finished'].includes(phase) ? 'once\n' : '');
    if (phase === 'finished') {
      const file = path.join(root, 'sessions', `${parent.id}.jsonl`);
      const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      events.find(e => e.message?.role === 'assistant').message.toolCalls[0].args.task = 'Different request';
      fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
      assert.equal(store.load(parent.id).unknownToolResults().length, 1, 'a mismatched request cannot borrow a finished receipt');
    }
  });
}
