import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JobRegistry } from '../src/tools/jobs.ts';
import { jobTools } from '../src/tools/job-tools.ts';
import { ToolRegistry, defaultToolsWithJobs } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { FixedModel } from '../src/model/fixed.ts';
import type { AgentMessage, ApprovalGate, ToolResult } from '../src/agent/types.ts';

const yes: ApprovalGate = { approve: async () => true };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function root(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-jobs-')));
}

function registry(dir: string) {
  const jobs = new JobRegistry();
  const tools = new ToolRegistry(defaultToolsWithJobs(jobs));
  const call = (name: string, args: Record<string, unknown>) =>
    tools.executeOne({ id: `${name}-${Math.random()}`, name, args }, { root: dir, approval: yes, jobs });
  return { jobs, tools, call };
}

test('a background command returns immediately and its output is read later', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const start = await call('run_command', { command: 'printf ONE; while [ ! -f release ]; do sleep 0.02; done; printf TWO', run_in_background: true });
    assert.equal(start.status, 'ok');
    // Completion is impossible until the caller releases the child: no scheduling assumption.
    assert.equal(fs.existsSync(path.join(dir, 'release')), false);
    const id = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(start.output)?.[1];
    assert.ok(id, start.output);

    // A read right after start races the child's first write; `wait` is how a caller asks
    // for output rather than for the current buffer.
    const first = await call('job_output', { job_id: id, wait: true, timeout_ms: 3000 });
    assert.match(first.output, /\[status: (running|completed)\]/);
    assert.match(first.output, /ONE/);

    // A second read returns only what is new, not the whole log again.
    fs.writeFileSync(path.join(dir, 'release'), '');
    const second = await call('job_output', { job_id: id, wait: true, timeout_ms: 3000 });
    assert.match(second.output, /TWO/);
    assert.doesNotMatch(second.output, /ONE/, 'reads are incremental');
    // Output wakes job_output before the process close event can arrive.
    let settled = second;
    const deadline = Date.now() + 5000;
    while (settled.output.includes('[status: running]') && Date.now() < deadline) {
      settled = await call('job_output', { job_id: id, wait: true, timeout_ms: Math.max(1, deadline - Date.now()) });
      assert.doesNotMatch(settled.output, /ONE|TWO/, 'already consumed output is not repeated');
    }
    assert.match(settled.output, /\[status: completed\]/);
    assert.match(settled.output, /\[exit code: 0\]/);
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('wait blocks until the job settles or the timeout expires', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const start = await call('run_command', { command: 'sleep 0.25; printf DONE', run_in_background: true });
    const id = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(start.output)![1];
    const began = Date.now();
    const waited = await call('job_output', { job_id: id, wait: true, timeout_ms: 5000 });
    const elapsed = Date.now() - began;
    assert.ok(elapsed >= 200, `waited ${elapsed}ms`);
    assert.match(waited.output, /DONE/);
    // wait returns on new output as well as settlement, so the status may still be running;
    // a further wait carries the terminal state.
    const settled = await call('job_output', { job_id: id, wait: true, timeout_ms: 5000 });
    assert.match(settled.output, /completed/);

    // A wait with a short timeout returns control instead of hanging.
    const long = await call('run_command', { command: 'sleep 5', run_in_background: true });
    const longId = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(long.output)![1];
    const beganShort = Date.now();
    const shortWait = await call('job_output', { job_id: longId, wait: true, timeout_ms: 150 });
    assert.ok(Date.now() - beganShort < 1500);
    assert.match(shortWait.output, /running/);
    await jobs.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('job_kill stops the process group and reports the settled state', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const start = await call('run_command', { command: 'printf STARTED; sleep 30', run_in_background: true });
    const id = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(start.output)![1];
    await delay(100);
    const killed = await call('job_kill', { job_id: id, reason: 'no longer needed' });
    assert.equal(killed.status, 'ok', killed.output);
    assert.match(killed.output, /\[status: killed\]/);
    assert.match(killed.output, /STARTED/, 'output produced before the kill is kept');
    // The record stays readable after settlement.
    const after = jobs.get(id);
    assert.equal(after?.status, 'killed');
    assert.equal(after?.detail, 'no longer needed');
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('job_list shows every job and an unknown id is an error, not an empty answer', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const a = await call('run_command', { command: 'sleep 0.2', run_in_background: true, description: 'first task' });
    const b = await call('run_command', { command: 'sleep 0.2', run_in_background: true, description: 'second task' });
    assert.equal(a.status, 'ok');
    assert.equal(b.status, 'ok');
    const listed = await call('job_list', {});
    assert.match(listed.output, /first task/);
    assert.match(listed.output, /second task/);

    const unknown = await call('job_output', { job_id: 'bash-0000000000000000' });
    assert.equal(unknown.status, 'error');
    assert.match(unknown.output, /不明なジョブ/);
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closing the registry stops live jobs instead of orphaning them', async () => {
  const dir = root();
  const jobs = new JobRegistry();
  try {
    const view = jobs.start({ command: 'sleep 30', cwd: dir, shell: 'sh' });
    await delay(100);
    const began = Date.now();
    await jobs.close();
    assert.ok(Date.now() - began < 5000, 'close waits for the group to disappear');
    assert.equal(jobs.get(view.id), undefined, 'the registry keeps no records after close');
    // Starting after close is refused rather than silently doing nothing.
    assert.throws(() => jobs.start({ command: 'true', cwd: dir, shell: 'sh' }), /終了済み/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a missing registry refuses background execution instead of running inline', async () => {
  const dir = root();
  try {
    const tools = new ToolRegistry(defaultToolsWithJobs(new JobRegistry()));
    const result = await tools.executeOne(
      { id: 'bg', name: 'run_command', args: { command: 'printf FORBIDDEN', run_in_background: true } },
      { root: dir, approval: yes },
    );
    assert.equal(result.status, 'error');
    assert.match(result.output, /バックグラウンド実行が有効でない/);
    assert.doesNotMatch(result.output, /FORBIDDEN/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a job that fails reports failed, and its stderr is readable', async () => {
  const dir = root();
  const { jobs, call } = registry(dir);
  try {
    const start = await call('run_command', { command: 'printf BOOM >&2; exit 4', run_in_background: true });
    const id = /\[job_id: (bash-[0-9a-f]{16})\]/.exec(start.output)![1];
    await delay(200);
    const read = await call('job_output', { job_id: id });
    assert.match(read.output, /\[status: completed\]/);
    assert.match(read.output, /\[exit code: 4\]/, 'a failing exit is still a completed job');
    assert.match(read.output, /BOOM/);
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a completed job reaches the model as a notice even after the answer finished', async () => {
  const dir = root();
  const jobs = new JobRegistry();
  try {
    const messages: AgentMessage[] = [{ role: 'user', content: 'start it' }];
    const model = new FixedModel([
      [
        { type: 'tool-call', call: { id: 'bg', name: 'run_command', args: { command: 'sleep 0.2; printf JOB_DONE', run_in_background: true } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      // The model answers immediately; the job is still running at this point.
      [{ type: 'text-delta', text: 'started' }, { type: 'finish', stopReason: 'stop' }],
      // After the notice arrives the model can look at the output.
      [{ type: 'text-delta', text: 'saw the notice' }, { type: 'finish', stopReason: 'stop' }],
    ]);
    const outcome = await runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultToolsWithJobs(jobs)), root: dir,
      signal: new AbortController().signal, approval: yes, jobs, maxTurns: 6,
    });
    await delay(400);
    // A second turn must surface the unread completion rather than ending silently.
    const second = await runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultToolsWithJobs(jobs)), root: dir,
      signal: new AbortController().signal, approval: yes, jobs, maxTurns: 6,
    });
    assert.equal(outcome.outcome, 'complete');
    assert.equal(second.outcome, 'complete');
    const noticeText = messages.filter(m => m.role === 'user').map(m => m.role === 'user' ? m.content : '').join('\n');
    assert.match(noticeText, /バックグラウンドジョブの完了通知/);
    assert.match(noticeText, /JOB_DONE/);
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the model is never shown a job id it cannot use', async () => {
  const dir = root();
  const { jobs } = registry(dir);
  try {
    const view = jobs.start({ command: 'sleep 0.1', cwd: dir, shell: 'sh' });
    assert.match(view.id, /^bash-[0-9a-f]{16}$/);
    const tools = jobTools(jobs);
    assert.deepEqual(tools.map(t => t.name).sort(), ['job_kill', 'job_list', 'job_output']);
  } finally { await jobs.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
