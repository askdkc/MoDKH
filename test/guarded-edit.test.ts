import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentLoop, type AgentLoopOptions } from '../src/agent/loop.ts';
import type { AgentMessage, ApprovalRequest, ModelEvent, ToolCall, ToolResult } from '../src/agent/types.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { editFileTool } from '../src/tools/edit.ts';
import { runCommandTool } from '../src/tools/run.ts';
import { JobRegistry } from '../src/tools/jobs.ts';

type Mode = 'happy' | 'failed' | 'denied-edit' | 'denied-command' | 'invalid-order' | 'extra'
  | 'background' | 'malformed' | 'no-edit' | 'unknown' | 'followup' | 'during-approval' | 'abort'
  | 'cached' | 'old-unknown-command' | 'repeated' | 'hook' | 'terminal' | 'journal-error' | 'child' | 'job' | 'disabled';

for (const mode of ['happy', 'failed', 'denied-edit', 'denied-command', 'invalid-order', 'extra',
  'background', 'malformed', 'no-edit', 'unknown', 'followup', 'during-approval', 'abort',
  'cached', 'old-unknown-command', 'repeated', 'hook', 'terminal', 'journal-error', 'child', 'job', 'disabled'] as const satisfies readonly Mode[]) {
  test(`edit guard: ${mode}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-edit-guard-'));
    try {
      fs.writeFileSync(path.join(root, 'state.txt'), 'before');
      const edit: ToolCall = { id: 'e', name: 'edit_file', args: {
        path: 'state.txt', old_string: mode === 'failed' ? 'missing' : 'before', new_string: 'after',
      } };
      const check: ToolCall = { id: 'c', name: 'run_command', args: {
        command: 'test "$(cat state.txt)" = after && printf x >> count.txt',
        if_edit_succeeds: mode !== 'malformed' ? true : 'true',
        ...(mode === 'background' ? { run_in_background: true } : {}),
      } };
      const batch = mode === 'invalid-order' ? [check, edit] : mode === 'no-edit' ? [check]
        : mode === 'extra' ? [edit, { ...check, id: 'other' }, check] : [edit, check];
      const messages: AgentMessage[] = [{ role: 'user', content: 'Edit the fixture and then verify it' }];
      if (mode === 'cached' || mode === 'unknown') messages.unshift(
        { role: 'assistant', content: '', toolCalls: [edit] },
        ...(mode === 'cached' ? [{ role: 'tool' as const, results: [{ callId: 'e', name: 'edit_file', status: 'ok' as const, output: 'old' }] }] : []),
      );
      if (mode === 'old-unknown-command') messages.unshift({ role: 'assistant', content: '', toolCalls: [check] });
      const toolResults: ToolResult[] = [];
      const approvals: ApprovalRequest['kind'][] = [];
      const persisted: string[] = [];
      const controller = new AbortController();
      let pending = new AbortController();
      let backgroundNotice = false;
      let requests = 0;
      let sawUserInput = false;
      let sawBackgroundNotice = false;
      let terminal = false;
      const opts: AgentLoopOptions = {
        registry: new ToolRegistry([editFileTool, runCommandTool]),
        root, signal: controller.signal, skills: false, guardedEditCheck: mode !== 'disabled',
        approval: { async approve(req) {
          approvals.push(req.kind);
          if (req.kind === 'command') {
            assert.equal(persisted.at(-1), 'tool:edit_file', 'edit result must be checkpointed before command approval');
            if (mode === 'during-approval') pending.abort();
          }
          return !(mode === 'denied-edit' && req.kind === 'edit' || mode === 'denied-command' && req.kind === 'command');
        } },
        checkpoint() {
          const last = messages.at(-1);
          if (last?.role === 'tool') {
            persisted.push(`tool:${last.results[0].name}`);
            if (mode === 'journal-error' && last.results[0].name === 'edit_file') throw new Error('write failed');
          }
        },
        hooks: { onToolResult(result) {
          toolResults.push(result);
          if (result.name === 'edit_file' && result.status === 'ok') {
            if (mode === 'followup') pending.abort();
            if (mode === 'abort') controller.abort();
            if (mode === 'terminal') terminal = true;
            if (mode === 'child' || mode === 'job') backgroundNotice = true;
          }
        } },
        followupSignal: () => pending.signal,
        takeFollowups() { if (!pending.signal.aborted) return []; pending = new AbortController(); return ['Wait; use another check']; },
        ...(mode === 'terminal' ? { terminalToolBlock: () => terminal ? 'blocked by trusted workflow' : undefined } : {}),
        ...(mode === 'hook' ? { afterToolBatch: async () => undefined } : {}),
        model: { id: 'fixture/guard', async *stream(req): AsyncGenerator<ModelEvent> {
          requests++;
          sawUserInput ||= req.messages.some(m => m.role === 'user' && m.content === 'Wait; use another check');
          sawBackgroundNotice ||= req.messages.some(m => m.role === 'user' && m.content.includes('new report'));
          if (requests === 1 || (mode === 'repeated' && requests === 2)) {
            for (const call of batch) yield { type: 'tool-call', call };
            yield { type: 'finish', stopReason: 'tool-calls' };
          } else {
            yield { type: 'text-delta', text: 'done' };
            yield { type: 'finish', stopReason: 'stop' };
          }
        } },
      };
      const notices = {
        get hasNotices() { return backgroundNotice; },
        takeNotices() { if (!backgroundNotice) return []; backgroundNotice = false; return ['new report']; },
        hasUnknown: false, hasPending: false, async cancelAll() {},
      };
      if (mode === 'child') opts.subagents = notices as unknown as AgentLoopOptions['subagents'];
      if (mode === 'job') opts.jobs = notices as unknown as AgentLoopOptions['jobs'];
      if (mode === 'journal-error') await assert.rejects(runAgentLoop(messages, opts), /write failed/);
      else {
        const result = await runAgentLoop(messages, opts);
        assert.equal(result.outcome, mode === 'terminal' ? 'error'
          : ['unknown', 'abort', 'old-unknown-command'].includes(mode) ? 'interrupted' : 'complete');
      }
      const starts = fs.existsSync(path.join(root, 'count.txt')) ? fs.readFileSync(path.join(root, 'count.txt'), 'utf8') : '';
      assert.equal(starts, mode === 'happy' || mode === 'repeated' ? 'x' : '', JSON.stringify(toolResults));
      if (['followup', 'during-approval'].includes(mode)) assert.equal(sawUserInput, true);
      if (['child', 'job'].includes(mode)) assert.equal(sawBackgroundNotice, true);
      assert.equal(approvals.filter(k => k === 'command').length,
        ['happy', 'repeated', 'denied-command', 'during-approval'].includes(mode) ? 1 : 0);
      if (mode === 'old-unknown-command') assert.equal(toolResults.at(-1)?.status, 'unknown');
      if (mode === 'during-approval') assert.match(toolResults.at(-1)?.output ?? '', /NOT_EXECUTED/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('edit guard: a started verification keeps running as a job at its deadline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-edit-guard-timeout-'));
  const jobs = new JobRegistry();
  try {
    fs.writeFileSync(path.join(root, 'state.txt'), 'before');
    const results: ToolResult[] = [];
    let requests = 0;
    const messages: AgentMessage[] = [{ role: 'user', content: 'Edit the fixture and then verify it' }];
    const outcome = await runAgentLoop(messages, {
      registry: new ToolRegistry([editFileTool, runCommandTool]),
      root, signal: new AbortController().signal, skills: false, guardedEditCheck: true, jobs,
      approval: { async approve() { return true; } },
      hooks: { onToolResult(result) { results.push(result); } },
      model: { id: 'fixture/timeout', async *stream(): AsyncGenerator<ModelEvent> {
        requests++;
        if (requests === 1) {
          yield { type: 'tool-call', call: { id: 'e', name: 'edit_file', args: {
            path: 'state.txt', old_string: 'before', new_string: 'after' } } };
          yield { type: 'tool-call', call: { id: 'c', name: 'run_command', args: {
            command: 'sleep 2; printf VERIFIED_AFTER_DEADLINE', timeoutMs: 200, if_edit_succeeds: true } } };
          yield { type: 'finish', stopReason: 'tool-calls' };
        } else {
          yield { type: 'text-delta', text: 'done' };
          yield { type: 'finish', stopReason: 'stop' };
        }
      } },
    });
    const check = results.at(-1);
    // A deadline on a command that already started must not become a lost result.
    assert.equal(check?.status, 'ok', JSON.stringify(results));
    assert.match(check?.output ?? '', /バックグラウンドジョブへ移した/);
    assert.equal(check?.output.includes('if_edit_succeeds'), false);
    const view = jobs.list()[0];
    assert.ok(view, 'the verification must stay reachable as a job');
    assert.equal(fs.readFileSync(path.join(root, 'state.txt'), 'utf8'), 'after');
    assert.equal(outcome.outcome, 'complete');
    // The command keeps running after the call returned; poll the registry the way job_output does.
    let read: ReturnType<JobRegistry['read']> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      read = jobs.read(view.id);
      if (read.job.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(read?.job.status, 'completed', JSON.stringify(read?.job));
    assert.match(read?.stdout ?? '', /VERIFIED_AFTER_DEADLINE/);
  } finally {
    await jobs.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
