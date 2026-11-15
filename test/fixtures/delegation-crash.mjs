import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../../src/session/store.ts';
import { PluginManager } from '../../src/plugins/manager.ts';
import { SubagentService } from '../../src/subagents/service.ts';
import { FixedModel } from '../../src/model/fixed.ts';

const [root, phase] = process.argv.slice(2);
const store = new SessionStore(path.join(root, 'sessions'));
const parent = store.create(root, 'fixed/crash');
fs.writeFileSync(path.join(root, 'parent-id'), parent.id);
parent.append({ role: 'assistant', origin: 'manual', content: '', toolCalls: [{ id: 'crash-call', name: 'run_subagent', args: { pluginId: 'modkh-worker', task: 'Crash boundary' } }] });
const record = parent.recordDelegation.bind(parent);
parent.recordDelegation = event => {
  record(event);
  if (event.state === phase) process.exit(23);
};
const create = store.create.bind(store);
store.create = (...args) => {
  const child = create(...args);
  if (phase === 'child') process.exit(23);
  return child;
};
const service = new SubagentService({
  store, parent, root, manager: new PluginManager(path.join(root, 'home')),
  approval: { approve: async () => true },
  tools: [{ name: 'create_file', description: 'crash probe', parameters: { type: 'object', properties: {} }, execute: async () => {
    fs.appendFileSync(path.join(root, 'effect-count'), 'once\n', { flush: true });
    if (phase === 'effect') process.exit(23);
    return 'written';
  } }],
  connection: () => ({ ref: 'fixed/crash', create: () => new FixedModel([
    [{ type: 'tool-call', call: { id: 'effect', name: 'create_file', args: {} } }, { type: 'finish', stopReason: 'tool-calls' }],
    [{ type: 'text-delta', text: 'Captured output' }, { type: 'finish', stopReason: 'stop' }],
  ]) }),
});
await (await service.start({ pluginId: 'modkh-worker', task: 'Crash boundary' }, { callId: 'crash-call', signal: new AbortController().signal })).result;
throw new Error('Crash boundary was not reached');
