import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolDisplay } from '../src/cli/tool-display.ts';
import type { AgentMessage, ToolCall, ToolResult } from '../src/agent/types.ts';

test('file operations show the target, not serialized source, while details retain exact evidence', () => {
  const view = new ToolDisplay();
  const call: ToolCall = { id: '1', name: 'create_file', args: { path: 'index.html', content: '<html>\n' + 'SOURCE'.repeat(500) } };
  const result: ToolResult = { callId: '1', name: call.name, status: 'ok', output: 'index.html を作成した (3000バイト)' };
  const before = JSON.stringify({ call, result });
  const compact = view.call(call) + view.result(result);
  assert.match(compact, /作成 · index.html/);
  assert.match(compact, /3000バイト/);
  assert.doesNotMatch(compact, /SOURCE|content=/);
  assert.match(compact, /\/tools 1/);
  assert.match(view.details('1'), /SOURCE/);
  assert.equal(JSON.stringify({ call, result }), before);
});

test('structured metadata is summarized and unsuccessful shell exits remain unmistakable', () => {
  const view = new ToolDisplay();
  view.call({ id: '1', name: 'list_subagents', args: {} });
  const summary = view.result({ callId: '1', name: 'list_subagents', status: 'ok', output: JSON.stringify([{ digest: 'OPAQUE_DIGEST' }, {}]) });
  assert.match(summary, /2件/);
  assert.doesNotMatch(summary, /OPAQUE_DIGEST/);
  view.call({ id: '2', name: 'run_command', args: { command: 'npm test' } });
  const failed = view.result({ callId: '2', name: 'run_command', status: 'ok', output: '[exit code: 1]\n--- stdout ---\n' + 'passed\n'.repeat(40) + 'FAIL final assertion' });
  assert.match(failed, /FAIL final assertion/);
  assert.match(failed, /失敗 · exit 1/);
  assert.ok(failed.split('\n').length <= 10);
});

test('resumed results and unknown outcomes retain their identity in the detail list', () => {
  const messages: AgentMessage[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', args: { path: 'a.txt' } }] },
    { role: 'tool', results: [{ callId: 'a', name: 'read_file', status: 'unknown', output: 'Interrupted; result unknown' }] },
  ];
  const view = new ToolDisplay(messages);
  assert.match(view.details(''), /1\. 読む · a.txt · unknown/);
  assert.match(view.details('1'), /Interrupted; result unknown/);
  assert.match(view.details('0'), /使い方/);
  assert.match(view.details('2'), /ありません/);
});
