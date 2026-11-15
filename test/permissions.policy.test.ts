import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalApprovalGate } from '../src/cli/approval.ts';
import { defaultTools } from '../src/tools/registry.ts';
import { ToolError } from '../src/agent/types.ts';

/** defaultTools() returns an array; look tools up by name for a readable call site. */
const tools = new Map(defaultTools().map(tool => [tool.name, tool]));

function gate(policy: 'all' | 'workspace' | 'none') {
  const written: string[] = [];
  const gate = new TerminalApprovalGate({ ask: async () => 'y', write: text => { written.push(text); } }, policy);
  return { gate, written };
}

test('workspace policy runs an in-root command without prompting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-policy-'));
  try {
    const { gate: approval, written } = gate('workspace');
    let asked = 0;
    const spy = { approve: async (req: Parameters<typeof approval.approve>[0]) => { asked++; return approval.approve(req); } };
    const result = await tools.get('run_command')!.execute({ command: 'echo policy-ok' },
      { root: home, approval: spy, signal: new AbortController().signal });
    assert.match(String(typeof result === 'string' ? result : result.output), /policy-ok/);
    assert.equal(asked, 1, 'approve is consulted so the decision is auditable');
    assert.match(written.join(''), /自動承認/, 'the automatic effect is still reported');
    assert.doesNotMatch(written.join(''), /承認要求/, 'no prompt is shown');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('workspace policy still prompts when the request leaves the root', async () => {
  const { gate: approval, written } = gate('workspace');
  const allowed = await approval.approve({ kind: 'command', title: '外のコマンド', detail: 'ls /', outsideWorkspace: true });
  assert.equal(allowed, true, 'the prompt answer is honoured');
  assert.match(written.join(''), /承認要求/);
  // Omitting the flag must be treated as outside: an unproven target never runs silently.
  written.length = 0;
  await approval.approve({ kind: 'command', title: '未証明', detail: '' });
  assert.match(written.join(''), /承認要求/);
});

test('none asks even for in-root effects, and a refusal is terminal', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-policy-none-'));
  try {
    const written: string[] = [];
    const refusing = new TerminalApprovalGate({ ask: async () => 'n', write: t => { written.push(t); } }, 'none');
    await assert.rejects(
      tools.get('run_command')!.execute({ command: 'touch should-not-exist' }, { root, approval: refusing, signal: new AbortController().signal }),
      (error: ToolError) => error.code === 'DENIED');
    assert.equal(fs.existsSync(path.join(root, 'should-not-exist')), false);
    assert.match(written.join(''), /承認要求/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('all runs in-root edits without prompting, and the edit still applies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-policy-all-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'before\n');
    const { gate: approval, written } = gate('all');
    const result = await tools.get('edit_file')!.execute({ path: 'a.txt', old_string: 'before', new_string: 'after' },
      { root, approval, signal: new AbortController().signal });
    assert.match(String(typeof result === 'string' ? result : result.output), /a\.txt/);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after\n');
    assert.match(written.join(''), /自動承認/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('changing the policy affects later requests only', async () => {
  const { gate: approval, written } = gate('none');
  approval.setPolicy('workspace');
  assert.equal(approval.currentPolicy(), 'workspace');
  assert.match(written.join(''), /workspace — ワークスペース内は自動/);
  written.length = 0;
  await approval.approve({ kind: 'edit', title: '内側', detail: '', outsideWorkspace: false });
  assert.match(written.join(''), /自動承認/);
  approval.setPolicy('none');
  written.length = 0;
  await approval.approve({ kind: 'edit', title: '内側', detail: '', outsideWorkspace: false });
  assert.match(written.join(''), /承認要求/);
});
