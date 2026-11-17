import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { TerminalApprovalGate } from '../src/cli/approval.ts';
import { ShellProcess } from '../src/tools/shell-process.ts';
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
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-stop-ready-')));
  const readyFile = path.join(directory, 'ready.json');
  const ac = new AbortController();
  const watcher = fs.watch(directory);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('change', () => { if (fs.existsSync(readyFile)) resolve(); });
    timer = setTimeout(() => reject(new Error('Child did not become ready')), 5000);
  });
  // Publish readiness atomically only after installing the TERM handler. A live
  // interval has no natural exit: the host must escalate and reap the process.
  const script = `const fs=require("node:fs"); process.on("SIGTERM",()=>{}); console.log("READY");
    fs.writeFileSync(${JSON.stringify(readyFile + '.tmp')},JSON.stringify({pid:process.pid}));
    fs.renameSync(${JSON.stringify(readyFile + '.tmp')},${JSON.stringify(readyFile)}); setInterval(()=>{},1000);`;
  const pending = run(`${nodeCommand(script)} & wait`, ac.signal);
  try {
    await Promise.race([ready, pending.then(result => { throw new Error(`Child exited before readiness: ${result.output}`); })]);
    clearTimeout(timer);
    const { pid } = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as { pid: number };
    ac.abort();
    const result = await pending;
    assert.equal(result.status, 'unknown');
    assert.match(result.output, /READY/);
    assert.doesNotMatch(result.output, /停止を確認できない/);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    clearTimeout(timer);
    watcher.close();
    ac.abort();
    await pending;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('shell exit reports confirmed descendant cleanup as a recoverable error', async () => {
  const result = await run('(sleep 0.4; printf CHILD_SURVIVED) &');
  assert.equal(result.status, 'error');
  assert.match(result.output, /RUN_FAILED.*shell終了後/);
  assert.match(result.output, /終了コードだけで成功と判断しない/);
  assert.doesNotMatch(result.output, /CHILD_SURVIVED/);
});

test('Stop during descendant cleanup remains an interruption', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cleanup-stop-')));
  const script = `const fs=require("node:fs");
    process.on("SIGTERM",()=>console.log("CLEANING"));
    fs.writeFileSync("ready", "ready"); setInterval(()=>{},1000);`;
  const child = new ShellProcess(`${nodeCommand(script)} & while [ ! -f ready ]; do sleep 0.01; done; exit 0`, dir);
  const outcome = child.result.then(() => null, (error: Error) => error);
  try {
    const deadline = Date.now() + 5000;
    while (!child.out.text().includes('CLEANING') && Date.now() < deadline && !child.isSettled) await delay(10);
    assert.match(child.out.text(), /CLEANING/, 'automatic cleanup has started');
    child.stop('abort');
    const error = await outcome;
    assert.ok(error);
    assert.match(error.message, /コマンドを中断した/);
    assert.equal((error as Error & { code: string }).code, 'ABORTED');
  } finally {
    child.stop('abort');
    await outcome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a nonzero exit is a reported result, while a signalled shell stays a failure', async () => {
  // A failing command is ordinary evidence: grep with no match, a red test. It must reach the
  // model as a result so the agent can read the output and decide, not as a tool error.
  const failed = await run('printf FAILURE; exit 7');
  assert.equal(failed.status, 'ok');
  assert.match(failed.output, /\[exit code: 7\]/);
  assert.match(failed.output, /FAILURE/);
  // A shell killed by a signal is an infrastructure stop, not a result to interpret.
  const signalled = await run('kill -TERM $$');
  assert.equal(signalled.status, 'error');
  assert.match(signalled.output, /SIGTERM/);
  assert.doesNotMatch(signalled.output, /\[exit code: 0\]/);
  const ok = await run('true');
  assert.equal(ok.status, 'ok');
  assert.match(ok.output, /\[exit code: 0\]/);
});

test('captured output keeps both ends when it exceeds the cap', async () => {
  const large = await run(nodeCommand('process.stdout.write("HEAD" + "x".repeat(100000) + "TAIL")'));
  assert.match(large.output, /HEAD/, 'the start of the output survives');
  assert.match(large.output, /TAIL/, 'the end survives, where failures usually appear');
  assert.match(large.output, /文字省略/);
  assert.ok(Buffer.byteLength(large.output) <= 32 * 1024 + 400, 'the whole result stays bounded');
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
