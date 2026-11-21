import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-skill-package-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory, '--cache', path.join(directory, 'cache')], { encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', path.join(directory, packed[0].filename), '-C', directory]);
  const base = path.join(directory, 'package');
  const load = file => import(pathToFileURL(path.join(base, 'dist', file)).href);
  const { verifyBundledSkills, bundledSkills, readBundledSkill } = await load('agent/bundled-skills.js');
  verifyBundledSkills();
  assert.equal(bundledSkills().length, 17);
  const { ToolRegistry, defaultTools } = await load('tools/registry.js');
  const { runAgentLoop } = await load('agent/loop.js');
  const { FixedModel } = await load('model/fixed.js');
  const model = new FixedModel([
    [{ type: 'tool-call', call: { id: 'reference', name: 'read_skill', args: { name: 'kiokuko-ui-design-soul', resource: 'references/accessibility-and-navigation.md' } } }, { type: 'finish', stopReason: 'tool-calls' }],
    [{ type: 'finish', stopReason: 'stop' }],
  ]);
  const messages = [{ role: 'user', content: 'fix a bug' }];
  const result = await runAgentLoop(messages, { model, registry: new ToolRegistry(defaultTools()), root: directory, signal: new AbortController().signal, approval: { approve: async () => false } });
  assert.equal(result.outcome, 'complete');
  assert.ok(model.requests[0].system.includes(readBundledSkill('coding-ideal-routine-skill')));
  assert.ok(model.requests[0].system.includes('[kiokuko-ui-design-soul]'));
  assert.equal(messages.find(m => m.role === 'tool').results[0].status, 'ok');
  assert.ok(!model.requests[0].system.includes('/Users/'));
  // Fault only the disposable package to prove integrity checks reject damaged resources.
  fs.appendFileSync(path.join(base, 'skills/kiokuko-dsh/kiokuko-soul/SKILL.md'), '\nCORRUPTED');
  assert.throws(() => readBundledSkill('kiokuko-soul'), /integrity mismatch/);
  console.log('Packaged skill acceptance: 17 skills, 43 resources, routed core/UI, reference tool, corruption rejection passed');
  console.log(`Package integrity: ${packed[0].integrity}`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
