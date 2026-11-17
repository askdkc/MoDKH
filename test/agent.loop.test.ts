import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FixedModel, type FixedStep } from '../src/model/fixed.ts';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import type { AgentMessage, ApprovalGate, ApprovalRequest, ToolResult } from '../src/agent/types.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-loop-'));
}

class RecordingGate implements ApprovalGate {
  decisions: boolean[] = [];
  requests: ApprovalRequest[] = [];
  order: string[] = [];
  constructor(decisions: boolean[]) {
    this.decisions = decisions;
  }
  async approve(req: ApprovalRequest): Promise<boolean> {
    this.requests.push(req);
    this.order.push(req.title);
    return this.decisions[this.requests.length - 1] ?? false;
  }
}

function delta(t: string): FixedStep {
  return [{ type: 'text-delta', text: t }];
}

for (const withCall of [false, true]) test(`output-limit recovery never replays truncated output or tools: ${withCall}`, async () => {
  const root = tmpRoot();
  try {
    let recoveryRequests = 0;
    const model = new FixedModel([
      [...delta('unfinished plan'), ...(withCall ? [{
        type: 'tool-call' as const, call: { id: 'partial', name: 'list_files', args: {} },
      }] : []), { type: 'finish', stopReason: 'length' }],
      [{ type: 'finish', stopReason: 'length' }],
    ]);
    const messages: AgentMessage[] = [{ role: 'user', content: 'Fix the code' }];
    const result = await runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultTools()), root, skills: false,
      signal: new AbortController().signal, approval: new RecordingGate([]),
      recoverOutputLimit: () => { recoveryRequests++; return { instruction: 'Resume with one next action' }; },
    });
    assert.deepEqual(result, { outcome: 'error', errorMessage: 'モデル応答は未完了: length' });
    assert.equal(messages[1].role === 'assistant' && messages[1].content, 'unfinished plan');
    assert.equal(recoveryRequests, withCall ? 0 : 1);
    if (withCall) {
      assert.equal(model.requests.length, 1);
      assert.equal(messages[2].role === 'tool' && messages[2].results[0].status, 'not-executed');
    } else {
      assert.deepEqual(model.requests[1].messages, [
        { role: 'user', content: 'Fix the code' }, { role: 'user', content: 'Resume with one next action' },
      ]);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('output-limit recovery blocks calls outside the temporary scope and restores ordinary tools', async () => {
  const root = tmpRoot();
  try {
    const model = new FixedModel([
      [{ type: 'finish', stopReason: 'length' }],
      [
        { type: 'tool-call', call: { id: 'outside', name: 'list_files', args: {} } },
        { type: 'tool-call', call: { id: 'extra', name: 'read_file', args: { path: 'demo.txt' } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      [{ type: 'finish', stopReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [{ role: 'user', content: 'Fix the code' }];
    assert.equal((await runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultTools()), root, system: 'Ordinary system', skills: false,
      signal: new AbortController().signal, approval: new RecordingGate([]),
      recoverOutputLimit: () => ({
        instruction: 'Read one target',
        scope: { system: 'Scoped system', tool: 'read_file', accepts: call => call.args.path === 'demo.txt' },
      }),
    })).outcome, 'complete');
    assert.deepEqual(model.requests[1].tools.map(tool => tool.name), ['read_file']);
    assert.equal(model.requests[1].system, 'Scoped system');
    assert.equal(model.requests[2].system, 'Ordinary system');
    assert.deepEqual(model.requests[2].tools, model.requests[0].tools);
    assert.deepEqual(messages.flatMap(message => message.role === 'tool'
      ? message.results.map(result => result.status) : []), ['not-executed', 'not-executed']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('pinned skill context keeps the system prompt byte-identical across tool steps', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    const model = new FixedModel([
      [
        { type: 'tool-call', call: { id: 't1', name: 'read_file', args: { path: 'a.txt' } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      [...delta('done'), { type: 'finish', stopReason: 'stop' }],
    ]);
    const text = '\n[skill]\n固定本文\n';
    const pinned = { text, selected: ['skill'], sections: [{ name: 'skill', text }], warnings: [], bytes: Buffer.byteLength(text) };
    await runAgentLoop([{ role: 'user', content: '何か' }], {
      model, registry: new ToolRegistry(defaultTools()), root,
      system: 'STABLE', skillContext: pinned,
      signal: new AbortController().signal, approval: new RecordingGate([true]),
    });
    assert.ok(model.requests.length >= 2, 'the loop issued more than one request');
    for (const request of model.requests) {
      assert.equal(request.system, `STABLE${pinned.text}`, 'the provider sees the same prefix every step');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('without a pinned context the loop derives guidance once for the whole loop', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
    const model = new FixedModel([
      [
        { type: 'tool-call', call: { id: 't1', name: 'read_file', args: { path: 'a.txt' } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      [...delta('done'), { type: 'finish', stopReason: 'stop' }],
    ]);
    await runAgentLoop([{ role: 'user', content: '調査して' }], {
      model, registry: new ToolRegistry(defaultTools()), root,
      system: 'STABLE',
      signal: new AbortController().signal, approval: new RecordingGate([true]),
    });
    const systems = new Set(model.requests.map(request => request.system));
    assert.equal(systems.size, 1, 'one system string for every step of the loop');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('固定応答モデルでストリーミング+ツール往復が完走する', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n');
    const model = new FixedModel([
      [
        ...delta('読み'), ...delta('ます'),
        { type: 'tool-call', call: { id: 't1', name: 'read_file', args: { path: 'a.txt' } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      [...delta('内容は '), ...delta('hello world です'), { type: 'finish', stopReason: 'stop' }],
    ]);
    const registry = new ToolRegistry(defaultTools());
    const gate = new RecordingGate([true]);
    const deltas: string[] = [];
    const executed: string[] = [];
    const messages: AgentMessage[] = [{ role: 'user', content: 'a.txt を読んで要約して' }];

    const r = await runAgentLoop(messages, {
      model,
      registry,
      root,
      system: 'テスト用',
      signal: new AbortController().signal,
      approval: gate,
      hooks: {
        onText: (d) => deltas.push(d),
        onToolResult: (tr: ToolResult) => executed.push(`${tr.name}:${tr.status}`),
      },
    });

    assert.equal(r.outcome, 'complete');
    assert.deepEqual(deltas, ['読み', 'ます', '内容は ', 'hello world です']);
    assert.deepEqual(executed, ['read_file:ok']);
    assert.equal(gate.requests.length, 0); // 読み取りは承認不要
    assert.equal(messages.length, 4);
    assert.equal(messages[1].role, 'assistant');
    if (messages[1].role === 'assistant') {
      assert.equal(messages[1].content, '読みます');
      assert.equal(messages[1].toolCalls?.length, 1);
    }
    assert.equal(messages[2].role, 'tool');
    if (messages[2].role === 'tool') {
      assert.equal(messages[2].results[0].status, 'ok');
      assert.match(messages[2].results[0].output, /hello world/);
    }
    // 2回目のモデル要求に履歴が渡っている
    assert.equal(model.requests[1].messages.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('承認拒否はエラー結果としてモデルへ返り、会話は続く', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
    const model = new FixedModel([
      [
        { type: 'tool-call', call: { id: 'e1', name: 'edit_file', args: { path: 'a.txt', old_string: 'one', new_string: 'two' } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      [...delta('承認されなかったので中止します'), { type: 'finish', stopReason: 'stop' }],
    ]);
    const gate = new RecordingGate([false]);
    const messages: AgentMessage[] = [{ role: 'user', content: '書き換えて' }];
    const r = await runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultTools()), root,
      signal: new AbortController().signal, approval: gate,
    });
    assert.equal(r.outcome, 'complete');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\n');
    assert.equal(messages[2].role, 'tool');
    if (messages[2].role === 'tool') {
      assert.equal(messages[2].results[0].status, 'error');
      assert.match(messages[2].results[0].output, /\[DENIED\]/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ストリーミング中の中断は interrupted になりツールを実行しない', async () => {
  const root = tmpRoot();
  try {
    // 60個の差分を流し、10個目で Ctrl+C 相当を発生させる
    const step: FixedStep = [];
    for (let i = 0; i < 60; i++) step.push({ type: 'text-delta', text: `d${i} ` });
    step.push({ type: 'finish', stopReason: 'stop' });
    const model = new FixedModel([step]);
    const gate = new RecordingGate([]);
    const ac = new AbortController();
    const messages: AgentMessage[] = [{ role: 'user', content: '長い話をして' }];
    const p = runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultTools()), root,
      signal: ac.signal, approval: gate,
    });
    setTimeout(() => ac.abort(), 8);
    const r = await p;
    assert.equal(r.outcome, 'interrupted');
    // 中断は完了と区別される。ツールは要求されていない
    assert.equal(messages.filter((m) => m.role === 'tool').length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ツール実行中の中断は子プロセスを止め、残りも実行しない', async () => {
  const root = tmpRoot();
  try {
    const model = new FixedModel([
      [
        { type: 'tool-call', call: { id: 'r1', name: 'run_command', args: { command: 'sleep 3' } } },
        { type: 'tool-call', call: { id: 'r2', name: 'run_command', args: { command: 'sleep 3' } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
    ]);
    const gate = new RecordingGate([true, true, true]);
    const ac = new AbortController();
    const messages: AgentMessage[] = [{ role: 'user', content: '時間のかかる処理' }];
    const started = Date.now();
    const p = runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultTools()), root,
      signal: ac.signal, approval: gate,
    });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    const elapsed = Date.now() - started;
    assert.equal(r.outcome, 'interrupted');
    assert.ok(elapsed < 2500, `sleep 3 が止まっていない(経過 ${elapsed}ms)`);
    assert.equal(messages[2].role, 'tool');
    if (messages[2].role === 'tool') {
      const results = messages.flatMap(m => m.role === 'tool' ? m.results : []);
      assert.equal(results.length, 2);
      assert.equal(results[0].status, 'unknown');
      assert.equal(results[1].status, 'not-executed');
      assert.match(results[1].output, /中断済み/);
      assert.equal(gate.requests.length, 1); // 後続処理は承認も実行もしていない
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('未知のツール要求はエラー結果として返り続行する', async () => {
  const root = tmpRoot();
  try {
    const model = new FixedModel([
      [
        { type: 'tool-call', call: { id: 'x1', name: 'deploy_to_production', args: {} } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      [...delta('そのツールはありません'), { type: 'finish', stopReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [{ role: 'user', content: 'デプロイして' }];
    const r = await runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultTools()), root,
      signal: new AbortController().signal, approval: new RecordingGate([]),
    });
    assert.equal(r.outcome, 'complete');
    assert.equal(messages[2].role, 'tool');
    if (messages[2].role === 'tool') {
      assert.equal(messages[2].results[0].status, 'error');
      assert.match(messages[2].results[0].output, /未知のツール名/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('複数ツール要求は一件ずつ順に実行する', async () => {
  const root = tmpRoot();
  try {
    const model = new FixedModel([
      [
        { type: 'tool-call', call: { id: 'c1', name: 'create_file', args: { path: 'one.txt', content: '1' } } },
        { type: 'tool-call', call: { id: 'c2', name: 'create_file', args: { path: 'two.txt', content: '2' } } },
        { type: 'finish', stopReason: 'tool-calls' },
      ],
      [{ type: 'finish', stopReason: 'stop' }],
    ]);
    const gate = new RecordingGate([true, true]);
    const messages: AgentMessage[] = [{ role: 'user', content: '2つのファイルを作って' }];
    const r = await runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultTools()), root,
      signal: new AbortController().signal, approval: gate,
      hooks: { onToolCall: (c) => gate.order.push(`call:${c.id}`) },
    });
    assert.equal(r.outcome, 'complete');
    assert.deepEqual(gate.order, ['call:c1', 'call:c2', '新規作成 one.txt', '新規作成 two.txt']);
    assert.equal(fs.readFileSync(path.join(root, 'one.txt'), 'utf8'), '1');
    assert.equal(fs.readFileSync(path.join(root, 'two.txt'), 'utf8'), '2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ツール往復が上限に達したら打ち切る', async () => {
  const root = tmpRoot();
  try {
    const step = (): FixedStep => [
      { type: 'tool-call', call: { id: 'loop', name: 'run_command', args: { command: 'true' } } },
      { type: 'finish', stopReason: 'tool-calls' },
    ];
    const model = new FixedModel(Array.from({ length: 10 }, step));
    const messages: AgentMessage[] = [{ role: 'user', content: '無限に続けて' }];
    const r = await runAgentLoop(messages, {
      model, registry: new ToolRegistry(defaultTools()), root,
      signal: new AbortController().signal, approval: new RecordingGate([true, true, true, true, true, true]),
      maxTurns: 6,
    });
    assert.equal(r.outcome, 'turn-limit');
    assert.match(r.errorMessage ?? '', /上限/);
    // The work done before the cap is still in the transcript, so the user can continue.
    assert.ok(messages.length > 1);
    assert.match(r.errorMessage ?? '', /保存済み/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('既定の上限は通常の長い作業を通し、暴走だけを止める', async () => {
  const root = tmpRoot();
  try {
    // 30 round trips is an ordinary long task; it must not be truncated by the default.
    const step = (): FixedStep => [
      { type: 'tool-call', call: { id: 'loop', name: 'list_files', args: {} } },
      { type: 'finish', stopReason: 'tool-calls' },
    ];
    const model = new FixedModel([...Array.from({ length: 30 }, step), [{ type: 'finish', stopReason: 'stop' }]]);
    const r = await runAgentLoop([{ role: 'user', content: '長い作業' }], {
      model, registry: new ToolRegistry(defaultTools()), root,
      signal: new AbortController().signal, approval: new RecordingGate([]),
    });
    assert.equal(r.outcome, 'complete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('follow-ups received during the final answer are sent in order before the turn completes', async () => {
  const model = new FixedModel([
    [...delta('first answer'), { type: 'finish', stopReason: 'stop' }],
    [...delta('updated answer'), { type: 'finish', stopReason: 'stop' }],
  ]);
  const messages: AgentMessage[] = [{ role: 'user', content: 'original request' }];
  const followups: string[] = [];
  const result = await runAgentLoop(messages, {
    model, root: process.cwd(), registry: new ToolRegistry([]), approval: new RecordingGate([]),
    signal: new AbortController().signal, skills: false,
    hooks: { onText: text => { if (text === 'first answer') followups.push('second request', 'third request'); } },
    takeFollowups: () => followups.splice(0),
  });
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(model.requests[1].messages, [
    { role: 'user', content: 'original request' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second request' },
    { role: 'user', content: 'third request' },
  ]);
  assert.equal(model.requests.length, 2);
});

test('a definitive rejection stops remaining calls in the same model response', async () => {
  const messages: AgentMessage[] = [{ role: 'user', content: 'Verify then edit' }];
  let rejected = false;
  const calls = ['verify', 'edit'].map(name => ({ id: name, name, args: {} }));
  const model = new FixedModel([[
    ...calls.map(call => ({ type: 'tool-call' as const, call })),
    { type: 'finish', stopReason: 'tool-calls' },
  ]]);
  const registry = new ToolRegistry(calls.map(({ name }) => ({
    name, description: name, parameters: { type: 'object', properties: {} },
    execute: async () => {
      assert.equal(name, 'verify');
      rejected = true;
      return { status: 'error' as const, output: 'Mismatch' };
    },
  })));
  const result = await runAgentLoop(messages, {
    model, registry, root: process.cwd(), approval: new RecordingGate([]), signal: new AbortController().signal,
    skills: false, terminalToolBlock: () => rejected ? 'Mismatch' : undefined,
  });
  assert.equal(result.outcome, 'error');
  const receipts = messages.flatMap(message => message.role === 'tool' ? message.results : []);
  assert.deepEqual(receipts.map(receipt => [receipt.callId, receipt.status]), [['verify', 'error'], ['edit', 'not-executed']]);
});
