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

test('each displayed approval gets three minutes and expiry releases its input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const answers: ((s: string) => void)[] = [];
  const written: string[] = [];
  const gate = new TerminalApprovalGate({ write: s => written.push(s), ask: (_, signal) => {
    signals.push(signal!);
    return new Promise(resolve => answers.push(resolve));
  } }, 'none');
  const req = { kind: 'command' as const, title: 'GET', detail: 'url' };
  const first = gate.approve(req);
  const second = gate.approve(req);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(179_999);
  assert.equal(signals[0].aborted, false);
  answers[0]('y');
  assert.equal(await first, true);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(179_999);
  assert.equal(signals[1].aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signals[1].aborted, true);
  assert.equal(await second, false);
  assert.match(written.join(''), /3分.*拒否/);
});

test('an explicit recovery confirmation honors refusal under the all policy', async () => {
  let prompts = 0;
  const gate = new TerminalApprovalGate({ write() {}, ask: async () => { prompts++; return 'n'; } }, 'all');
  const request = { kind: 'command' as const, title: 'Fixture command', detail: 'sh finish.sh' };
  assert.equal(await gate.approve(request), true);
  assert.equal(await gate.confirmOnce(request), false);
  assert.equal(prompts, 1);
  assert.equal(gate.currentPolicy(), 'all');
});
