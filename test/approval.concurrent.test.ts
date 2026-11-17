import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalApprovalGate } from '../src/cli/approval.ts';

test('parallel approvals display one prompt and cancel a queued child without taking another answer', async () => {
  const answers: ((s: string) => void)[] = [];
  const shown: string[] = [];
  const gate = new TerminalApprovalGate({ write: s => shown.push(s), ask: async () => new Promise<string>(resolve => answers.push(resolve)) }, 'none');
  const abort = new AbortController();
  const first = gate.approve({ kind: 'edit', title: 'first', detail: 'one' });
  const second = gate.approve({ kind: 'edit', title: 'cancelled child', detail: 'two', signal: abort.signal });
  const third = gate.approve({ kind: 'edit', title: 'third', detail: 'three' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(answers.length, 1);
  assert.equal(shown.join('').includes('cancelled child'), false);
  abort.abort();
  assert.equal(await second, false);
  answers[0]('y');
  assert.equal(await first, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(answers.length, 2);
  assert.match(shown.join(''), /third/);
  answers[1]('n');
  assert.equal(await third, false);
});
