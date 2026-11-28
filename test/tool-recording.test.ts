import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { ResponsesApiModel } from '../src/model/chatgpt/responses.ts';
import path from 'node:path';
import test from 'node:test';
import { runAgentLoop } from '../src/agent/loop.ts';
import { adoptAgenticReplayToolTransport, fileToolRecording, type ToolRecording } from '../src/agent/tool-recording.ts';
import type { AgentMessage, ModelEvent } from '../src/agent/types.ts';
import { JobRegistry } from '../src/tools/jobs.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { runCommandTool } from '../src/tools/run.ts';
import { setTimeout as delay } from 'node:timers/promises';

type Row = Parameters<ToolRecording['write']>[0];

test('recorder-only tool states protect opaque IDs and respect the recording opt-out', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-record-destination-'));
  const frames = path.join(dir, 'frames');
  const local = path.join(dir, 'private.jsonl');
  fs.writeFileSync(frames, '');
  const keys = ['MODKH_TOOL_RECORD_FILE', 'AGENTICREPLAY_MODKH_FRAMES', 'MODKH_AGENTICREPLAY'];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    delete process.env.AGENTICREPLAY_MODKH_FRAMES;
    adoptAgenticReplayToolTransport();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  delete process.env.MODKH_TOOL_RECORD_FILE;
  delete process.env.MODKH_AGENTICREPLAY;
  process.env.AGENTICREPLAY_MODKH_FRAMES = frames;
  assert.equal(adoptAgenticReplayToolTransport(), true);
  assert.equal(process.env.AGENTICREPLAY_MODKH_FRAMES, undefined);
  const row: Row = { session: 'session', turn: 0, attempt: 'attempt', ordinal: 1,
    callId: 'opaque/private-id', state: 'unknown', reason: 'command_unconfirmed' };
  fileToolRecording('session', assert.fail)!.write(row);
  const captured = fs.readFileSync(frames, 'utf8');
  assert.match(JSON.parse(captured).callId, /^sha256-[a-f0-9]{64}$/);
  fileToolRecording('subagent', assert.fail)!.write({ ...row, session: 'subagent' });
  const lines = fs.readFileSync(frames, 'utf8').trimEnd().split('\n');
  assert.deepEqual(lines.map(line => JSON.parse(line).session), ['session', 'subagent']);
  fs.unlinkSync(frames);
  const warnings: string[] = [];
  for (const session of ['parent', 'child']) {
    fileToolRecording(session, warning => warnings.push(warning))?.write({ ...row, session });
  }
  assert.equal(warnings.length, 1);
  assert.equal(fs.existsSync(frames), false);
  process.env.MODKH_AGENTICREPLAY = '0';
  assert.equal(fileToolRecording('session', assert.fail), undefined);
  process.env.MODKH_TOOL_RECORD_FILE = local;
  fileToolRecording('session', assert.fail)!.write(row);
  assert.equal(JSON.parse(fs.readFileSync(local, 'utf8')).callId, row.callId);
  assert.equal(fs.existsSync(frames), false);
});

const modes = ['denied', 'before-start', 'guard', 'response-aborted', 'terminal', 'retry', 'reuse',
  'resumed', 'kill', 'background', 'promote', 'invalid', 'failure'] as const;
for (const mode of modes) test('tool record: ' + mode, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-state-'));
  const ac = new AbortController();
  const jobs = new JobRegistry();
  const rows: Row[] = [];
  const command = 'printf x >> marker' + (mode === 'kill' ? '; kill -KILL $$'
    : mode === 'promote' ? '; sleep 0.15' : mode === 'failure' ? '; exit 7' : '');
  const call = { id: 'repeat', name: 'run_command', args: { command, ...(mode === 'guard' && { if_edit_succeeds: true }),
    ...(mode === 'background' && { run_in_background: true }), ...(mode === 'promote' && { timeoutMs: 5 }),
    ...(mode === 'invalid' && { timeoutMs: -3 }) } };
  const messages: AgentMessage[] = [{ role: 'user', content: 'test' }];
  if (mode === 'resumed') messages.unshift({ role: 'assistant', content: '', toolCalls: [call] },
    { role: 'tool', results: [{ callId: call.id, name: call.name, status: 'ok', output: 'old receipt' }] });
  let posts = 0, approvals = 0;
  try {
    await runAgentLoop(messages, {
      root, jobs, skills: false, signal: ac.signal, registry: new ToolRegistry([runCommandTool]),
      toolRecording: { session: 'session', write(row) { rows.push(row); } },
      maxTurns: mode === 'reuse' || mode === 'kill' ? 2 : 1,
      approval: { async approve() {
        approvals++;
        if (mode === 'before-start') ac.abort();
        return mode !== 'denied';
      } },
      terminalToolBlock: () => mode === 'terminal' ? 'stop' : undefined,
      model: { id: 'fixture', async *stream(): AsyncGenerator<ModelEvent> {
        posts++;
        yield { type: 'tool-call', call };
        if (mode === 'terminal') yield { type: 'tool-call', call: { ...call, id: 'second' } };
        if (mode === 'retry' && posts === 1) yield { type: 'finish', stopReason: 'error', connectionLost: true };
        else yield { type: 'finish', stopReason: mode === 'response-aborted' ? 'aborted' : 'tool-calls' };
      } },
    });
    if (mode === 'background' || mode === 'promote') {
      for (let i = 0; i < 200 && !rows.some(r => r.state === 'completed'); i++) await delay(10);
      const accepted = rows.find(r => r.state === 'accepted');
      assert.match(accepted?.jobId ?? '', /^bash-/);
      assert.equal(rows.at(-1)?.jobId, accepted?.jobId);
      assert.equal(rows.at(-1)?.reason, 'command_exited');
      assert.equal(rows.filter(r => r.state === 'completed').length, 1);
    }
    const mark = path.join(root, 'marker');
    const starts = ['kill', 'background', 'promote', 'retry', 'reuse', 'failure'].some(m => m === mode);
    assert.equal(fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '', starts ? 'x' : '');
    assert.equal(rows.filter(r => r.reason === 'command_started').length, starts ? 1 : 0);
    const skipped = ['denied', 'before-start', 'guard', 'response-aborted', 'invalid', 'retry'].some(m => m === mode);
    assert.equal(rows.filter(r => r.state === 'not-executed').length, mode === 'terminal' ? 2 : Number(skipped));
    if (mode === 'retry') {
      assert.equal(posts, 2);
      const discarded = rows.find(r => r.reason === 'response_discarded');
      const completed = rows.find(r => r.state === 'completed');
      assert.equal(discarded?.callId, completed?.callId);
      assert.equal(discarded?.ordinal, 1);
      assert.equal(completed?.ordinal, 1);
      assert.notEqual(discarded?.attempt, completed?.attempt);
    }
    if (mode === 'kill') {
      assert.equal(rows.filter(r => r.reason === 'command_unconfirmed' && r.state === 'unknown').length, 1);
      assert.equal(approvals, 1);
    }
    if (mode === 'failure') assert.equal(rows.at(-1)?.reason, 'nonzero_exit');
    if (mode === 'reuse' || mode === 'resumed') {
      assert.equal(rows.at(-1)?.state, 'reused');
      const source = rows.at(-1)?.source;
      assert.equal(source?.message, mode === 'resumed' ? 1 : 2);
      assert.equal(source?.result, 0);
      if (mode === 'reuse') assert.equal(source?.attempt, rows[0].attempt);
    }
    if (mode === 'denied') {
      assert.equal(rows.at(-1)?.reason, 'approval_denied');
      const last = messages.at(-1);
      assert.ok(last?.role === 'tool' && last.results[0].status === 'error');
    }
    assert.doesNotMatch(JSON.stringify(rows), /marker|printf|exit code|kill -KILL|old receipt/);
  } finally {
    await jobs.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a lost HTTP response after a tool call keeps the retried occurrence separate', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-state-http-'));
  const rows: Row[] = [];
  let posts = 0;
  let disconnect: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the request */ }
    posts++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const item = { type: 'function_call', name: 'run_command', call_id: 'same',
      arguments: JSON.stringify({ command: 'printf x >> marker' }) };
    res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', item }) + '\n\n');
    if (posts === 1) disconnect = () => res.destroy();
    else res.end('data: {"type":"response.completed"}\n\n');
  });
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const model = new ResponsesApiModel({ accessToken: 'fixture', model: 'fixture', baseUrl: 'http://127.0.0.1:' + address.port });
  let approvals = 0;
  await runAgentLoop([{ role: 'user', content: 'Run the marker' }], {
    model, root, maxTurns: 1, skills: false, signal: AbortSignal.timeout(20000), registry: new ToolRegistry([runCommandTool]),
    approval: { async approve() { approvals++; return true; } },
    hooks: { onToolCall() { disconnect?.(); disconnect = undefined; } },
    toolRecording: { session: 'fixture', write(row) { rows.push(row); } },
  });
  assert.equal(posts, 2);
  assert.equal(approvals, 1);
  assert.equal(fs.readFileSync(path.join(root, 'marker'), 'utf8'), 'x');
  assert.deepEqual(rows.map(row => row.reason),
    ['received', 'response_discarded', 'received', 'dispatch_pending', 'command_started', 'command_exited']);
  assert.notEqual(rows[0].attempt, rows[2].attempt);
  assert.ok(rows.every(row => row.ordinal === 1 && row.callId === 'same'));
});
