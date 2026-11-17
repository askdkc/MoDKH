import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolRegistry, defaultTools } from '../../src/tools/registry.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const registry = new ToolRegistry(defaultTools());
const evidence = [];
for (const [name, code, status] of [['good', 0, 'passed'], ['bad', 1, 'failed']]) {
  const result = await registry.executeOne({
    id: `stateright-${name}`, name: 'run_command',
    args: { command: `cargo run --quiet --locked --offline --manifest-path experiments/stateright-zenki/Cargo.toml -- ${name}`, timeoutMs: 60_000 },
  }, { root, approval: { approve: async () => true } });
  assert.equal(result.status, 'ok', result.output);
  assert.equal(result.output.split('\n')[0], `[exit code: ${code}]`);
  const report = JSON.parse(result.output.split('--- stdout ---\n')[1]);
  assert.equal(report.status, status);
  assert.equal(report.verifier, 'stateright');
  assert.equal(report.model, 'Counter-v1');
  assert.equal(report.exploredStates, 3);
  assert.deepEqual(report.counterexample, name === 'bad' ? [0, 1, 2] : null);
  evidence.push({ case: name, toolStatus: result.status, exitCode: code, report });
}
const files = ['experiments/stateright-zenki/src/lib.rs', 'experiments/stateright-zenki/Cargo.lock',
  'test/fixtures/formal/Counter.tla', 'test/fixtures/formal/good.cfg', 'test/fixtures/formal/bad.cfg'];
const hashes = Object.fromEntries(files.map(file => [file,
  createHash('sha256').update(readFileSync(new URL(`../../${file}`, import.meta.url))).digest('hex')]));
console.log(JSON.stringify({ status: 'passed', route: 'run_command -> cargo -> Stateright', hashes, evidence }, null, 2));
