import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { TerminalApprovalGate } from '../src/cli/approval.ts';
import { LineSource } from '../src/cli/lines.ts';
import type { ApprovalGate } from '../src/agent/types.ts';

const yes: ApprovalGate = { approve: async () => true };
function run(command: string, signal?: AbortSignal, approval = yes) {
  return new ToolRegistry(defaultTools()).executeOne(
    { id: 'stop-test', name: 'run_command', args: { command } },
    { root: process.cwd(), signal, approval },
  );
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nodeCommand = (source: string) => `${JSON.stringify(process.execPath)} -e '${source}'`;

test('Stop during approval prevents spawning the approved command', async () => {
  const ac = new AbortController();
  const result = await run('printf FORBIDDEN', ac.signal, {
    approve: async () => { ac.abort(); return true; },
  });
  assert.equal(result.status, 'not-executed');
  assert.doesNotMatch(result.output, /FORBIDDEN/);
});

test('Stop terminates shell descendants, not only the shell', async () => {
  const ac = new AbortController();
  const pending = run('(sleep 0.4; printf CHILD_SURVIVED) & wait', ac.signal);
  const timer = setTimeout(() => ac.abort(), 100);
  try {
    const result = await pending;
    assert.equal(result.status, 'unknown');
    assert.doesNotMatch(result.output, /CHILD_SURVIVED/);
  } finally { clearTimeout(timer); }
});

test('Stop escalates for a descendant that ignores TERM after shell exit', async () => {
  const ac = new AbortController();
  const script = 'process.on("SIGTERM",()=>{}); console.log("READY"); setTimeout(()=>console.log("CHILD_SURVIVED"),1600)';
  const pending = run(`${nodeCommand(script)} & wait`, ac.signal);
  const timer = setTimeout(() => ac.abort(), 200);
  try {
    const result = await pending;
    assert.equal(result.status, 'unknown');
    assert.match(result.output, /READY/);
    assert.doesNotMatch(result.output, /CHILD_SURVIVED/);
  } finally { clearTimeout(timer); }
});

test('shell exit cannot abandon its background children and report success', async () => {
  const result = await run('(sleep 0.4; printf CHILD_SURVIVED) &');
  assert.equal(result.status, 'unknown');
  assert.doesNotMatch(result.output, /CHILD_SURVIVED/);
});

test('signal exit and nonzero exit are failures, never exit zero', async () => {
  const signalled = await run('kill -TERM $$');
  assert.equal(signalled.status, 'error');
  assert.match(signalled.output, /SIGTERM/);
  assert.doesNotMatch(signalled.output, /終了コード 0/);
  const failed = await run('printf FAILURE; exit 7');
  assert.equal(failed.status, 'error');
  assert.match(failed.output, /7/);
  assert.match(failed.output, /FAILURE/);
  assert.equal((await run('true')).status, 'ok');
});

test('captured output is bounded in bytes and exact capacity is not truncated', async () => {
  const large = await run(nodeCommand('process.stdout.write("x".repeat(100000))'));
  const output = large.output.split('--- 出力 ---\n')[1];
  assert.ok(output);
  assert.ok(Buffer.byteLength(output) <= 32 * 1024 + 100);
  assert.match(output, /出力を打ち切り/);
  const exact = await run(nodeCommand('process.stdout.write("x".repeat(32768))'));
  assert.doesNotMatch(exact.output, /出力を打ち切り/);
});

test('interrupting approval removes its input waiter and preserves next instruction', async () => {
  const stdin = new PassThrough();
  const lines = new LineSource(stdin);
  const gate = new TerminalApprovalGate({
    ask: async (_prompt, signal) => (await lines.next(signal)) ?? '',
    write: () => {},
  });
  try {
    const approval = gate.approve({ kind: 'command', title: 'run', detail: 'true' });
    gate.interrupt();
    assert.equal(await approval, false);
    const next = lines.next();
    stdin.write('NEXT_INSTRUCTION\n');
    assert.equal(await Promise.race([next, delay(100).then(() => 'LOST')]), 'NEXT_INSTRUCTION');
    const newApproval = gate.approve({ kind: 'command', title: 'next', detail: 'true' });
    stdin.write('y\n');
    assert.equal(await newApproval, true);
  } finally { stdin.end(); }
});

test('a cancelled line request does not consume already queued input', async () => {
  const stdin = new PassThrough();
  const lines = new LineSource(stdin);
  try {
    stdin.write('PRESERVED\n');
    const ac = new AbortController();
    ac.abort();
    assert.equal(await lines.next(ac.signal), null);
    assert.equal(await lines.next(), 'PRESERVED');
  } finally { stdin.end(); }
});

test('approval IO failure rejects promptly without leaving pending work', async () => {
  const gate = new TerminalApprovalGate({ ask: async () => { throw new Error('input failed'); }, write: () => {} });
  await assert.rejects(gate.approve({ kind: 'command', title: 'run', detail: 'true' }), /input failed/);
  gate.interrupt();
});
