import test from 'node:test';
import assert from 'node:assert/strict';
import { formalTools } from '../src/tools/formal.ts';

test('front verifier uses Stateright and exposes no Java/TLC tool', () => {
  const names = formalTools({}).map(tool => tool.name);
  assert.ok(names.includes('verify_stateright'));
  assert.ok(!names.includes('verify_tla'));
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginManager } from '../src/plugins/manager.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';

test('installed Stateright makes the builtin front agent available; missing runtime does not', async () => {
  const home = temporaryDirectory('modkh-zenki-discovery-');
  const runtime = fileURLToPath(new URL('../native/stateright/target/debug/modkh-stateright', import.meta.url));
  try {
    assert.equal(new PluginManager(home, undefined, path.join(home, 'absent')).discover().registry.get('modkh-micro-zenki'), undefined);
    const manager = new PluginManager(home, undefined, runtime);
    const role = manager.discover().registry.get('modkh-micro-zenki');
    assert.ok(role?.enabled);
    const lease = await manager.acquire(role.id, role.digest);
    try { assert.deepEqual((lease.module.define as () => { tools: string[] })().tools, ['verify_stateright']); }
    finally { lease.release(); }
    manager.setEnabled(role.id, false);
    assert.equal(manager.discover().registry.get(role.id)?.enabled, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
