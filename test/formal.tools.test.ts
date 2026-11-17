import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formalTools } from '../src/tools/formal.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';
const runtime = fileURLToPath(new URL('../native/stateright/target/debug/modkh-stateright', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/formal/', import.meta.url));
for (const [name, expected] of [['good', 'passed'], ['bad', 'failed']]) test(`real Stateright ${name}`, async () => {
  const r = await formalTools({ stateright: runtime })[1].execute({ path: `${name}.json` }, { root: fixtures, approval: { approve: async () => true } });
  assert.notEqual(typeof r, 'string'); if (typeof r === 'string') return;
  const e = JSON.parse(r.output);
  assert.equal(e.status, expected); assert.equal(e.result.exploredStates, 3);
  assert.equal(r.status, expected === 'passed' ? 'ok' : 'error');
  assert.deepEqual(e.result.counterexample, name === 'bad' ? ['0', '1', '2'] : null);
  assert.equal(e.hashes.source, e.result.inputSha256);
});
test('Stateright rejects missing runtime, legacy config, denial, symlinks and invalid models', async () => {
  const root = fs.realpathSync(temporaryDirectory('modkh-stateright-boundary-'));
  const ctx = { root, approval: { approve: async () => true } };
  try {
    fs.copyFileSync(path.join(fixtures, 'good.json'), path.join(root, 'Model.json'));
    const tool = formalTools({ stateright: runtime })[1];
    await assert.rejects(formalTools({ stateright: path.join(root, 'absent') })[1].execute({ path: 'Model.json' }, ctx), /未導入/);
    await assert.rejects(tool.execute({ path: 'Model.json', config: 'old.cfg' }, ctx), /migrate/);
    await assert.rejects(tool.execute({ path: 'Model.json' }, { ...ctx, approval: { approve: async () => false } }), /approved/);
    fs.symlinkSync('Model.json', path.join(root, 'Link.json'));
    await assert.rejects(tool.execute({ path: 'Link.json' }, ctx), /symlink/);
    fs.writeFileSync(path.join(root, 'Model.json'), '{}');
    const r = await tool.execute({ path: 'Model.json' }, ctx);
    assert.notEqual(typeof r, 'string'); if (typeof r !== 'string') { assert.equal(r.status, 'error'); assert.equal(JSON.parse(r.output).status, 'unverified'); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('exit zero and an unrelated model report cannot establish Stateright success', async () => {
  const root = fs.realpathSync(temporaryDirectory('modkh-stateright-forged-'));
  try {
    fs.copyFileSync(path.join(fixtures, 'good.json'), path.join(root, 'Model.json'));
    const fake = path.join(root, 'checker');
    for (const output of ['passed', JSON.stringify({ schemaVersion: 1, verifier: 'stateright', inputSha256: 'wrong', status: 'passed', complete: true, exploredStates: 3, counterexample: null, actions: null, violatedInvariants: [], deadlock: false })]) {
      fs.writeFileSync(fake, `#!/bin/sh\ncat <<'RESULT'\n${output}\nRESULT\n`, { mode: 0o700 });
      const r = await formalTools({ stateright: fake })[1].execute({ path: 'Model.json' }, { root, approval: { approve: async () => true } });
      assert.notEqual(typeof r, 'string'); if (typeof r !== 'string') assert.equal(JSON.parse(r.output).status, 'unverified');
    }
    fs.writeFileSync(fake, '#!/bin/sh\nsleep 5\n');
    const r = await formalTools({ stateright: fake, timeoutMs: 50 })[1].execute({ path: 'Model.json' }, { root, approval: { approve: async () => true } });
    assert.notEqual(typeof r, 'string'); if (typeof r !== 'string') { assert.equal(r.status, 'unknown'); assert.equal(JSON.parse(r.output).status, 'unverified'); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
