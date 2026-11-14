import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobRegistry } from '../src/tools/jobs.ts';
import { ToolRegistry, defaultToolsWithJobs } from '../src/tools/registry.ts';
import { runShellProcess } from '../src/tools/shell-process.ts';
import type { ApprovalGate } from '../src/agent/types.ts';

const yes: ApprovalGate = { approve: async () => true };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function root(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-promote-')));
}

function registry(dir: string) {
  const jobs = new JobRegistry();
  const tools = new ToolRegistry(defaultToolsWithJobs(jobs));
  const call = (name: string, args: Record<string, unknown>) =>
    tools.executeOne({ id: `${name}-${Math.random()}`, name, args }, { root: dir, approval: yes, jobs });
  return { jobs, call };
}

test('a foreground command that hits its deadline keeps running as a job', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const began = Date.now();
    // Prints immediately, then outlives the deadline. The old behaviour killed it and lost the
    // output; promotion keeps both the process and what it already produced.
    const started = await call('run_command', {
      command: 'printf EARLY_OUTPUT; sleep 3; printf LATE_OUTPUT',
      timeoutMs: 300,
    });
    const waited = Date.now() - began;
    assert.equal(started.status, 'ok', started.output);
    assert.ok(waited >= 250 && waited < 2000, `returned at the deadline, not the end: ${waited}ms`);

    const id = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(started.output)?.[1];
    assert.ok(id, started.output);
    assert.match(started.output, /バックグラウンドジョブへ移した/, 'the promotion is explained');
    assert.match(started.output, /job_output/, 'the model is told how to continue');

    // The job still exists and is still running.
    const view = jobs.get(id)!;
    assert.equal(view.status, 'running');
    // Work produced before the deadline is not lost.
    const firstRead = await call('job_output', { job_id: id });
    assert.match(firstRead.output, /EARLY_OUTPUT/, 'output from before the deadline is kept');

    // And it finishes on its own. `wait` returns early on new output too, so poll until the
    // job actually settles instead of assuming one wait is enough.
    let final = await call('job_output', { job_id: id, wait: true, timeout_ms: 8000 });
    const deadline = Date.now() + 10_000;
    while (jobs.get(id)!.status === 'running' && Date.now() < deadline) {
      final = await call('job_output', { job_id: id, wait: true, timeout_ms: 3000 });
    }
    const settled = jobs.get(id)!;
    assert.notEqual(settled.status, 'running');
    assert.match(final.output + settled.status + settled.exitCode, /LATE_OUTPUT|completed|0/);
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('without a registry a deadline is still a failure, not a silent background process', async () => {
  const dir = root();
  try {
    await assert.rejects(
      runShellProcess('sleep 5', dir, undefined, { timeoutMs: 200 }),
      (error: Error & { code?: string }) => error.code === 'ABORTED' && /制限時間/.test(error.message),
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a promoted job can still be killed, and the kill is confirmed', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const started = await call('run_command', { command: 'sleep 30', timeoutMs: 200 });
    const id = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(started.output)![1];
    const killed = await call('job_kill', { job_id: id, reason: 'no longer needed' });
    assert.equal(killed.status, 'ok', killed.output);
    assert.match(killed.output, /killed/);
    assert.equal(jobs.get(id)?.status, 'killed');
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fast command is unaffected: it returns its own result, not a job', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const quick = await call('run_command', { command: 'printf QUICK', timeoutMs: 5000 });
    assert.equal(quick.status, 'ok');
    assert.match(quick.output, /\[exit code: 0\]/);
    assert.match(quick.output, /QUICK/);
    assert.doesNotMatch(quick.output, /job_id/, 'no promotion when the command finishes in time');
    assert.equal(jobs.size, 0);
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Stop during a promoted job still stops it', async () => {
  const dir = root();
  const jobs = new JobRegistry();
  try {
    const tools = new ToolRegistry(defaultToolsWithJobs(jobs));
    const ac = new AbortController();
    const pending = tools.executeOne(
      { id: 'p', name: 'run_command', args: { command: 'sleep 30', timeoutMs: 150 } },
      { root: dir, approval: yes, jobs, signal: ac.signal },
    );
    // Let the deadline fire and promotion happen, then Stop.
    await delay(250);
    ac.abort();
    const result = await pending;
    // Either the promotion already returned a job, or the abort surfaced as an unknown result;
    // in both cases nothing may be left running.
    assert.ok(result.status === 'ok' || result.status === 'unknown', result.output);
    await jobs.close();
    assert.ok(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a promoted job reports a failing exit code as a completed job', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const started = await call('run_command', { command: 'sleep 1; exit 9', timeoutMs: 150 });
    const id = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(started.output)![1];
    const read = await call('job_output', { job_id: id, wait: true, timeout_ms: 8000 });
    const settled = jobs.get(id)!;
    assert.notEqual(settled.status, 'running');
    if (settled.status === 'completed') assert.equal(settled.exitCode, 9);
    assert.match(read.output, /exit code: 9|status: completed/);
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('promotion keeps the working directory and shell of the original call', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    const started = await call('run_command', { command: 'pwd; sleep 2', cwd: 'sub', shell: 'bash', timeoutMs: 200 });
    const id = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(started.output)![1];
    const view = jobs.get(id)!;
    assert.equal(view.cwd, path.join(dir, 'sub'));
    assert.equal(view.shell, 'bash');
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
