import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runAgentLoop } from '../src/agent/loop.ts';
import type { AgentMessage } from '../src/agent/types.ts';
import { FixedModel } from '../src/model/fixed.ts';
import { parseWorkspaceVerification, workspaceVerification } from '../src/cli/workspace-verification.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

const settings = { command: 'sh verify.sh', sources: ['candidate.txt'], protected: ['verify.sh'] };
function setup(t: TestContext, script = 'test "$(cat candidate.txt)" = fixed\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-verification-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (text: string) => fs.writeFileSync(path.join(root, 'candidate.txt'), text);
  write('original');
  fs.writeFileSync(path.join(root, 'verify.sh'), script);
  return { root, write };
}

test('ordinary loop verifies changed bytes, withholds false draft, and checks the revised candidate', async t => {
  const { root, write } = setup(t);
  const signal = new AbortController().signal;
  const approvals: string[] = [];
  const approval = { approve: async (request: { detail: string }) => { approvals.push(request.detail); return true; } };
  const checker = workspaceVerification(parseWorkspaceVerification({ ...settings, root: fs.realpathSync(root) })!, root, approval, signal)!;
  const model = new FixedModel([
    [{ type: 'tool-call', call: { id: '1', name: 'edit_fixture', args: { text: 'broken' } } }, { type: 'finish', stopReason: 'tool-calls' }],
    [{ type: 'text-delta', text: 'false success' }, { type: 'finish', stopReason: 'stop' }],
    [{ type: 'tool-call', call: { id: '2', name: 'edit_fixture', args: { text: 'fixed' } } }, { type: 'finish', stopReason: 'tool-calls' }],
    [{ type: 'text-delta', text: 'fixed now' }, { type: 'finish', stopReason: 'stop' }],
  ]);
  const messages: AgentMessage[] = [{ role: 'user', content: 'change the tracked input' }];
  const shown: string[] = [];
  const registry = new ToolRegistry([{ name: 'edit_fixture', description: '', parameters: { properties: { text: {} } },
    execute: async args => { write(String(args.text)); return 'edited'; } }]);
  const result = await runAgentLoop(messages, { model, registry, root, signal, approval, skills: false,
    beforeComplete: checker.beforeComplete, holdAnswerUntilComplete: true, hooks: { onText: text => shown.push(text) } });
  assert.equal(result.outcome, 'complete');
  assert.equal(checker.verdict(), 'passed');
  assert.match(checker.verifiedDigest() ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(shown, ['fixed now']);
  assert.equal(approvals.length, 2);
  assert.ok(approvals.every(x => x.includes('sh verify.sh')));
  assert.match(JSON.stringify(model.requests[2]?.messages), /固定検証が不合格/);
  assert.equal(await checker.beforeComplete(), undefined);
  assert.equal(approvals.length, 2, 'reuse evidence only for the same content fingerprint');
});

test('ordinary verifier does not run on no-change, altered protected checks, or missing approval', async t => {
  const { root, write } = setup(t);
  let calls = 0;
  const checker = workspaceVerification(parseWorkspaceVerification({ ...settings, root: fs.realpathSync(root) })!, root,
    { approve: async () => { calls++; return false; } }, new AbortController().signal)!;
  assert.equal(await checker.beforeComplete(), undefined);
  assert.equal(checker.verdict(), 'unverified');
  write('fixed');
  assert.match(JSON.stringify(await checker.beforeComplete()), /not-executed/);
  assert.equal(checker.verdict(), 'not-executed');
  assert.ok(await checker.beforeComplete());
  assert.equal(calls, 1);
  fs.writeFileSync(path.join(root, 'verify.sh'), 'exit 0\n');
  assert.ok(await checker.beforeComplete());
  assert.equal(checker.verdict(), 'stale');
  assert.equal(calls, 1);
});

test('success on changing verification inputs is stale, and identical failure never reruns', async t => {
  const { root, write } = setup(t, 'test "$(cat candidate.txt)" = fixed\n');
  let calls = 0;
  const signal = new AbortController().signal;
  const checker = workspaceVerification(parseWorkspaceVerification({ ...settings, root: fs.realpathSync(root) })!, root,
    { approve: async () => { calls++; if (calls === 2) write('raced'); return true; } }, signal)!;
  write('broken');
  assert.match(JSON.stringify(await checker.beforeComplete()), /continueWith/);
  assert.match(JSON.stringify(await checker.beforeComplete()), /errorMessage/);
  assert.equal(calls, 1);
  write('fixed');
  assert.match(JSON.stringify(await checker.beforeComplete()), /stale/);
  assert.equal(checker.verdict(), 'stale');
  assert.equal(calls, 2);
});

test('manifest validation rejects traversal, overlap and non-data config', () => {
  const config = { ...settings, root: fs.realpathSync(process.cwd()) };
  for (const bad of ['foo', { ...config, root: '.' }, { ...config, sources: ['../candidate.txt'] }, { ...config, protected: settings.sources },
    { ...config, sources: ['.git/config'] }, { ...config, command: '' }]) assert.equal(parseWorkspaceVerification(bad), undefined);
});

test('workspace checks are bound to a single real project and never drop required isolation', async t => {
  const { root, write } = setup(t);
  const cwd = fs.realpathSync(root);
  const config = parseWorkspaceVerification({ ...settings, root: cwd })!;
  const signal = new AbortController().signal;
  let calls = 0;
  const approval = { approve: async () => { calls++; return true; } };
  assert.equal(workspaceVerification(config, path.dirname(cwd), approval, signal), undefined);
  const checker = workspaceVerification(config, cwd, approval, signal, 'required')!;
  write('fixed');
  assert.match(JSON.stringify(await checker.beforeComplete()), /OS隔離が必須/);
  assert.equal(checker.verdict(), 'not-executed');
  assert.equal(calls, 0);
});
