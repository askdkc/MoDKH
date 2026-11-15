import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionStore } from '../src/session/store.ts';
import { FixedModel } from '../src/model/fixed.ts';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import type { AgentMessage, ApprovalGate } from '../src/agent/types.ts';

function tmpHome(): { home: string; store: SessionStore } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-sess-'));
  return { home, store: new SessionStore(path.join(home, 'sessions')) };
}

const alwaysYes: ApprovalGate = { approve: async () => true };

test('セッションはJSONLへ追記保存され、読み込みで復元される', async () => {
  const { home, store } = tmpHome();
  try {
    const s = store.create('/tmp/proj', 'fixed/scripted');
    s.append({ role: 'user', content: '最初の依頼' });
    s.append({
      role: 'assistant',
      content: '調べます',
      toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a.txt' } }],
    });
    s.append({
      role: 'tool',
      results: [
        { callId: 't1', name: 'read_file', status: 'ok', output: '内容' },
        { callId: 't2', name: 'run_command', status: 'unknown', output: '中断により結果不明' },
      ],
    });
    s.setStatus('interrupted');

    const loaded = store.load(s.id);
    assert.equal(loaded.id, s.id);
    assert.equal(loaded.cwd, '/tmp/proj');
    assert.equal(loaded.model, 'fixed/scripted');
    assert.equal(loaded.status, 'interrupted');
    assert.equal(loaded.messages.length, 3);
    assert.equal(loaded.messages[0].role, 'user');
    const toolMsg = loaded.messages[2];
    assert.equal(toolMsg.role, 'tool');
    if (toolMsg.role === 'tool') {
      assert.equal(toolMsg.results[1].status, 'unknown');
    }
    assert.equal(loaded.unknownToolResults().length, 1);
    // 保存先にJSONLが1つある
    assert.equal(fs.readdirSync(path.join(home, 'sessions')).filter((f) => f.endsWith('.jsonl')).length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('再開後のモデル要求には結果不明ツールが渡り、自動再実行は起きない', async () => {
  const { home, store } = tmpHome();
  try {
    // セッション作成: 中断されて結果不明の run_command が1つ残る
    const s = store.create('/tmp/proj', 'fixed/scripted');
    s.append({ role: 'user', content: '実行して' });
    s.append({
      role: 'assistant',
      content: '実行します',
      toolCalls: [{ id: 'k1', name: 'run_command', args: { command: 'sleep 100' } }],
    });
    s.append({
      role: 'tool',
      results: [{ callId: 'k1', name: 'run_command', status: 'unknown', output: '中断により結果不明' }],
    });
    s.setStatus('interrupted');

    // 実行カウンタ付きレジストリ
    let executions = 0;
    const reg = new ToolRegistry([
      ...defaultTools().map((t) => ({
        ...t,
        execute: async (args: Record<string, unknown>, ctx: never) => {
          executions++;
          return t.execute(args, ctx);
        },
      })),
    ]);

    // 再開: モデルは不明結果を見て別の安全なツールを要求する
    const model = new FixedModel([
      [
        { type: 'tool-call', call: { id: 'k2', name: 'run_command', args: { command: 'echo done' } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      [{ type: 'text-delta', text: '完了しました' }, { type: 'finish', stopReason: 'stop' }],
    ]);
    const loaded = store.load(s.id);
    loaded.setStatus('active');
    const messages = loaded.messages;
    const r = await runAgentLoop(messages, {
      model,
      registry: reg,
      root: fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-resume-')),
      signal: new AbortController().signal,
      approval: alwaysYes,
    });
    assert.equal(r.outcome, 'complete');
    // 1回目の要求に不明結果が含まれる(モデルが状態を把握できる)
    const firstReq = model.requests[0];
    const toolMsg = firstReq.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg && toolMsg.role === 'tool');
    assert.equal(toolMsg.results[0].status, 'unknown');
    // 新しい呼び出し1件だけが実行された。結果不明だった k1 は再実行されていない
    assert.equal(executions, 1);
    // 中断の痕跡が続く会話にも残る
    assert.equal(loaded.messages.filter((m) => m.role === 'tool').length, 2);
    assert.equal(loaded.unknownToolResults().length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('session list が一覧を返し、完了状態も区別する', async () => {
  const { home, store } = tmpHome();
  try {
    const a = store.create('/tmp/a', 'fixed/scripted');
    a.setStatus('complete');
    const b = store.create('/tmp/b', 'fixed/scripted');
    const listed = store.list();
    assert.equal(listed.length, 2);
    // 新しいものが先
    assert.equal(listed[0].id, b.id);
    const aRow = listed.find((x) => x.id === a.id);
    assert.ok(aRow);
    assert.equal(aRow.status, 'complete');
    assert.equal(listed.find((x) => x.id === b.id)?.status, 'active');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('存在しないIDの再開は明確なエラーになる', async () => {
  const { home, store } = tmpHome();
  try {
    assert.throws(() => store.load('no-such-session'), /見つからない/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
