import test from 'node:test';
import assert from 'node:assert/strict';
import { shellCall, shellOutput } from '../src/cli/shell-display.ts';

test('shell display presents description and multiline command without serialized arguments', () => {
  assert.equal(shellCall({ description: 'Run tests', command: 'npm test\necho done' }),
    '\n╭ Run tests\n│ $ npm test\n│   echo done\n');
});

test('shell display separates stderr and labels a nonzero exit as failure', () => {
  assert.equal(shellOutput({ status: 'ok', output: '[exit code: 1]\n--- stdout ---\nPASS first\n--- stderr ---\nFAIL last' }),
    '│ PASS first\n│ 標準エラー\n│ FAIL last\n╰ 失敗 · exit 1\n\n');
});

test('cleanup errors and unknown results never appear successful even with exit zero', () => {
  for (const status of ['error', 'unknown']) {
    const display = shellOutput({ status, output: 'cleanup problem\n[exit code: 0]\n--- stdout ---\nevidence' });
    assert.match(display, /cleanup problem/);
    assert.match(display, /evidence/);
    assert.doesNotMatch(display, /╰ 終了/);
  }
});

test('long output keeps both the beginning and final failure summary', () => {
  const display = shellOutput({ status: 'ok', output: '[exit code: 1]\n--- stdout ---\n' + Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') });
  assert.match(display, /│ line 0\n/);
  assert.match(display, /20行省略/);
  assert.match(display, /│ line 39\n/);
});

test('denial and background job text remain visible without pretending they finished', () => {
  assert.match(shellOutput({ status: 'not-executed', output: 'denied' }), /denied\n╰ 未実行/);
  assert.match(shellOutput({ status: 'ok', output: '[job_id: 12] [status: running]\njob_output で読む' }), /job_output で読む\n╰ 受付/);
  assert.match(shellOutput({ status: 'ok', output: '[exit code: 0]\n(出力なし)' }), /\(出力なし\)\n╰ 終了 · exit 0/);
});
