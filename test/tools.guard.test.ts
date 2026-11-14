import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { ToolError, type ApprovalGate, type ApprovalRequest, type ToolContext, type ToolResult } from '../src/agent/types.ts';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-tools-'));
}

class FakeGate implements ApprovalGate {
  decision: boolean;
  requests: ApprovalRequest[] = [];
  constructor(decision: boolean) {
    this.decision = decision;
  }
  async approve(req: ApprovalRequest): Promise<boolean> {
    this.requests.push(req);
    return this.decision;
  }
}

function ctx(root: string, gate: ApprovalGate): ToolContext {
  return { root, approval: gate };
}

function run(
  root: string,
  gate: ApprovalGate,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const reg = new ToolRegistry(defaultTools());
  return reg.executeOne({ id: 'call-1', name, args }, ctx(root, gate));
}

async function expectError(
  p: Promise<ToolResult>,
  code: string,
): Promise<ToolResult> {
  const r = await p;
  assert.equal(r.status, 'error', `期待: error, 実際: ${r.status} ${r.output}`);
  assert.match(r.output, new RegExp(`\\[${code}\\]`), r.output);
  return r;
}

test('read_file はルート外参照を拒否する', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    await expectError(run(root, new FakeGate(true), 'read_file', { path: '../outside.txt' }), 'OUT_OF_ROOT');
    await expectError(run(root, new FakeGate(true), 'read_file', { path: '/etc/hosts' }), 'OUT_OF_ROOT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('シンボリックリンク経由のルート外参照を拒否する', async () => {
  const root = tmpRoot();
  try {
    const outside = path.join(path.dirname(root), 'dkh-secret.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(root, 'leak'));
    await expectError(run(root, new FakeGate(true), 'read_file', { path: 'leak' }), 'OUT_OF_ROOT');
    fs.rmSync(outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edit_file は一致0回と複数回を拒否する', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha beta\nalpha gamma\n');
    await expectError(
      run(root, new FakeGate(true), 'edit_file', { path: 'a.txt', old_string: 'nope', new_string: 'x' }),
      'MATCH_MISSING',
    );
    await expectError(
      run(root, new FakeGate(true), 'edit_file', { path: 'a.txt', old_string: 'alpha', new_string: 'x' }),
      'MATCH_AMBIGUOUS',
    );
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'alpha beta\nalpha gamma\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('承認拒否では編集を書き込まない', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'one two three\n');
    const r = await expectError(
      run(root, new FakeGate(false), 'edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' }),
      'DENIED',
    );
    assert.match(r.output, /書き込まない/);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one two three\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('承認済み編集は差分を見せて書き込む', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'one two three\n');
    const gate = new FakeGate(true);
    const r = await run(root, gate, 'edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' });
    assert.equal(r.status, 'ok');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one TWO three\n');
    assert.equal(gate.requests.length, 1);
    const req = gate.requests[0];
    assert.equal(req.kind, 'edit');
    assert.match(req.title, /a\.txt/);
    assert.match(req.detail, /- one two three/);
    assert.match(req.detail, /\+ one TWO three/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('create_file は既存を拒否し、新規は承認後に作る', async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    await expectError(run(root, new FakeGate(true), 'create_file', { path: 'a.txt', content: 'y' }), 'ALREADY_EXISTS');
    const gate = new FakeGate(true);
    const r = await run(root, gate, 'create_file', { path: 'nested/b.txt', content: 'hello\n' });
    assert.equal(r.status, 'ok');
    assert.equal(fs.readFileSync(path.join(root, 'nested/b.txt'), 'utf8'), 'hello\n');
    assert.equal(gate.requests[0].kind, 'edit');
    assert.match(gate.requests[0].detail, /\+ hello/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run_command はルート外の作業場所を拒否し、承認後ルート内で実行する', async () => {
  const root = tmpRoot();
  try {
    await expectError(
      run(root, new FakeGate(true), 'run_command', { command: 'pwd', cwd: '..' }),
      'OUT_OF_ROOT',
    );
    const gate = new FakeGate(true);
    const r = await run(root, gate, 'run_command', { command: 'pwd' });
    assert.equal(r.status, 'ok');
    assert.match(r.output, /\[exit code: 0\]/);
    assert.match(r.output, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(gate.requests[0].kind, 'command');
    assert.match(gate.requests[0].detail, /pwd/);
    assert.match(gate.requests[0].detail, /作業場所/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('レジストリは未知のツール名と不正な引数形状を結果として返す', async () => {
  const root = tmpRoot();
  try {
    const r1 = await run(root, new FakeGate(true), 'no_such_tool', {});
    assert.equal(r1.status, 'error');
    assert.match(r1.output, /未知のツール名/);
    assert.match(r1.output, /read_file/);
    const reg = new ToolRegistry(defaultTools());
    const r2 = await reg.executeOne({ id: 'c', name: 'read_file', args: 'oops' as unknown as Record<string, unknown> }, ctx(root, new FakeGate(true)));
    assert.equal(r2.status, 'error');
    assert.match(r2.output, /JSON オブジェクト/);
    await expectError(run(root, new FakeGate(true), 'read_file', {}), 'INVALID_PATH');
    await expectError(
      run(root, new FakeGate(true), 'search_files', { pattern: '([' }),
      'INVALID_ARGS',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('list / search / read が基本の読み取りを満たす', async () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const x = 1;\nexport const y = 2;\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# sample\n');
    const rl = await run(root, new FakeGate(true), 'list_files', {});
    assert.match(rl.output, /src\//);
    assert.match(rl.output, /README\.md/);
    const sr = await run(root, new FakeGate(true), 'search_files', { pattern: 'const y' });
    assert.match(sr.output, /src\/main\.ts:2/);
    const rr = await run(root, new FakeGate(true), 'read_file', { path: 'src/main.ts', offset: 2, limit: 1 });
    assert.match(rr.output, /2: export const y = 2;/);
    const rd = await expectError(run(root, new FakeGate(true), 'read_file', { path: 'src/main.ts', offset: 0 }), 'INVALID_ARGS');
    assert.match(rd.output, /offset/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('abort 後の新規実行は not-executed になり実行しない', async () => {
  const root = tmpRoot();
  try {
    const reg = new ToolRegistry(defaultTools());
    const ac = new AbortController();
    ac.abort();
    const r = await reg.executeOne(
      { id: 'c', name: 'run_command', args: { command: 'echo hi' } },
      { root, approval: new FakeGate(true), signal: ac.signal },
    );
    assert.equal(r.status, 'not-executed');
    assert.match(r.output, /中断済み/);
    assert.equal(fs.readdirSync(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ファイル引数の型不正は error として返る', async () => {
  const root = tmpRoot();
  try {
    const reg = new ToolRegistry(defaultTools());
    const r = await reg.executeOne(
      {
        id: 'c',
        name: 'read_file',
        args: { path: 42 as unknown as string },
      },
      ctx(root, new FakeGate(true)),
    );
    assert.equal(r.status, 'error');
    assert.match(r.output, /path は空でない文字列/);
    assert.match(r.output, /\[INVALID_PATH\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
