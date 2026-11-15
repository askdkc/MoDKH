import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspaceRecordPath, recordSessionRecord, renderSessionRecord } from '../src/session/workspace.ts';
import type { AgentMessage } from '../src/agent/types.ts';

function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-record-'));
  return dir;
}

function fakeSession(over: Partial<Parameters<typeof recordSessionRecord>[1]> = {}) {
  const messages: AgentMessage[] = [
    { role: 'user', content: 'READMEを読んで更新して' },
    { role: 'assistant', content: '読みました。編集します。', toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'README.md' } }] },
    { role: 'tool', results: [{ callId: 'c1', name: 'edit_file', status: 'ok', output: 'README.md を編集した' }] },
  ];
  return {
    id: '20260101-abcd1234',
    createdAt: '2026-01-01T09:00:00Z',
    cwd: '/tmp/project',
    model: 'ollama/glm-test',
    status: 'complete',
    messages,
    ...over,
  };
}

test('each session is recorded under the workspace .modkh directory', () => {
  const dir = root();
  try {
    const session = fakeSession();
    const file = recordSessionRecord(dir, session);
    assert.equal(file, workspaceRecordPath(dir, session.id));
    assert.ok(fs.existsSync(file), 'the record file exists in .modkh/sessions');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /# modkh セッション 20260101-abcd1234/);
    assert.match(text, /モデル: ollama\/glm-test/);
    assert.match(text, /READMEを読んで更新して/);
    assert.match(text, /### ツール edit_file/);
    assert.match(text, /README\.md を編集した/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('re-recording the same session replaces only its own file', () => {
  const dir = root();
  try {
    const first = fakeSession({ id: 'a-session' });
    const second = fakeSession({ id: 'b-session' });
    recordSessionRecord(dir, first);
    recordSessionRecord(dir, second);
    recordSessionRecord(dir, first, ['edit_file']);
    const names = fs.readdirSync(path.join(dir, '.modkh', 'sessions'));
    assert.equal(names.length, 2, 'both sessions remain');
    const again = fs.readFileSync(workspaceRecordPath(dir, 'a-session'), 'utf8');
    assert.match(again, /結果不明のツール: edit_file/, 'the latest snapshot wins');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('huge tool output is clipped and marked, never silently truncated', () => {
  const text = renderSessionRecord(fakeSession({
    messages: [{ role: 'tool', results: [{ callId: 'x', name: 'run_command', status: 'ok', output: 'y'.repeat(6000) }] }],
  }));
  assert.ok(text.length < 8000, 'record stays a readable size');
  assert.match(text, /省略 \d+ 文字/, 'the clip is marked for the reader');
});

test('old records beyond the retention cap are pruned, newest first', () => {
  const dir = root();
  try {
    for (let i = 0; i < 60; i++) {
      recordSessionRecord(dir, fakeSession({ id: `session-${String(i).padStart(2, '0')}` }));
      // mtimeを1msずつ進める
      const file = workspaceRecordPath(dir, `session-${String(i).padStart(2, '0')}`);
      const past = new Date(Date.now() - (60 - i) * 1000);
      fs.utimesSync(workspaceRecordPath(dir, `session-${String(i).padStart(2, '0')}`), past, past);
      void file;
    }
    const remaining = fs.readdirSync(path.join(dir, '.modkh', 'sessions')).sort();
    assert.equal(remaining.length, 50, 'the cap keeps 50 files');
    assert.ok(!remaining.includes('session-00.md'), 'the oldest records go first');
    assert.ok(remaining.includes('session-59.md'), 'the newest records stay');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
