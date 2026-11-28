import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCompacted } from '../src/agent/compaction.ts';
import type { AgentMessage, ToolCall, ToolResult } from '../src/agent/types.ts';

function exchange(call: ToolCall, output: string): AgentMessage[] {
  return [{ role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', results: [{ name: call.name, callId: call.id, status: 'ok', output }] }];
}

test('compacted shell ranges carry their purpose into a later native read and only resend changed lines', () => {
  const line = 'const geometry = ' + '1 + '.repeat(100) + '0;';
  const before: AgentMessage[] = [{ role: 'user', content: 'Inspect the fish renderer' },
    ...exchange({ id: 'range', name: 'run_command', args: { command: "sed -n '20,23p' index.html", description: 'inspect fish geometry' } },
      '[exit code: 0]\n--- stdout ---\n' + [line, line, line, line].join('\n'))];
  const state = { workFrom: 0, from: before.length, summary: 'Earlier work' };
  const output = 'index.html (80行中 21行目から3行)\n21: ' + line + '\n22: NEW\n23: ' + line + '\n\nAnalysis: diagnostic';
  const call = { id: 'again', name: 'read_file', args: { path: 'index.html', offset: 21, limit: 3 } };
  const project = (read: ToolCall): string => {
    const messages = [...before, ...exchange(read, output)];
    const view = projectCompacted(messages, state);
    assert.match(JSON.stringify(view[0]), /index.html.*20-23.*inspect fish geometry/);
    assert.equal((messages.at(-1) as { results: ToolResult[] }).results[0].output, output);
    return (view.at(-1) as { results: ToolResult[] }).results[0].output;
  };
  const projected = project(call);
  assert.match(projected, /22: NEW/);
  assert.match(projected, /Analysis: diagnostic/);
  assert.ok(!projected.includes(line));
  assert.equal(project({ ...call, args: { ...call.args, full_text: true } }), output);
});

test('search receipts cover only complete matching lines, and compound shell commands supply no range evidence', () => {
  const body = 'a'.repeat(250);
  const before: AgentMessage[] = [{ role: 'user', content: 'Check marker' },
    ...exchange({ id: 'find', name: 'search_files', args: { pattern: 'marker', path: '.' } },
      '検索 "marker": 2 件\n対象: git\nfile.ts:2: marker' + body + '\nfile.ts:4: marker [行の一部省略]'),
    ...exchange({ id: 'shell', name: 'run_command', args: { command: "sed -n '1,4p' file.ts | sort", description: 'sorted preview' } },
      '[exit code: 0]\n--- stdout ---\n' + body)];
  const state = { workFrom: 0, from: before.length, summary: 'Summary' };
  const page = 'file.ts (4行中 1行目から4行)\n1: first\n2: marker' + body + '\n3: middle\n4: final';
  const after = exchange({ id: 'page', name: 'read_file', args: { path: 'file.ts', purpose: 'check marker branch' } }, page);
  const view = projectCompacted([...before, ...after], state);
  assert.match(JSON.stringify(view[0]), /file.ts:2.*marker/);
  assert.doesNotMatch(JSON.stringify(view[0]), /file.ts:4|sorted preview/);
  const result = (view.at(-1) as { results: ToolResult[] }).results[0];
  assert.match(result.output, /1: first\n3: middle\n4: final/);
  assert.ok(!result.output.includes(body));
  const second = projectCompacted([...before, ...after], { ...state, from: before.length + after.length });
  assert.match(JSON.stringify(second[0]), /file.ts:1-4.*check marker branch/);
});

test('repeated reads are matched by actual lines across tools and allow new source and one exact read', async t => {
  const { RepeatedReads } = await import('../src/agent/read-history.ts');
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await fs.mkdtemp(join(tmpdir(), 'modkh-read-loop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tracker = new RepeatedReads();
  const file = join(root, 'source.txt');
  await fs.writeFile(file, 'one\ntwo\nthree\n');
  const read = { id: 'read', name: 'read_file', args: { path: 'source.txt' } };
  const receipt: ToolResult = { callId: read.id, name: read.name, status: 'ok',
    output: 'source.txt (3行中 1行目から3行)\n1: one\n2: two\n3: three' };
  for (let n = 0; n < 3; n++) tracker.observe(read, receipt);
  const shell = (command: string) => ({ id: 'shell', name: 'run_command', args: { command } });
  for (const command of ['cat source.txt', 'head -2 source.txt', "sed -n '2,3p' source.txt"]) {
    assert.match(tracker.block(root, shell(command))!, /REPEATED_READ/);
  }
  assert.equal(tracker.block(root, shell('cat source.txt && echo done')), undefined);
  const exact = { ...read, args: { ...read.args, full_text: true } };
  assert.equal(tracker.block(root, exact), undefined);
  tracker.observe(exact, receipt);
  assert.match(tracker.block(root, exact)!, /REPEATED_READ/);
  await fs.writeFile(file, 'one\ntwo\n');
  assert.equal(tracker.block(root, read), undefined);
  await fs.writeFile(file, 'one\nupdated\nthree\n');
  assert.equal(tracker.block(root, read), undefined);
  assert.match(tracker.block(root, shell('head -1 source.txt'))!, /REPEATED_READ/);
});
