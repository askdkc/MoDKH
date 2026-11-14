import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MAX_TURNS, MAX_TURNS_CEILING, parseMaxTurns } from '../src/cli/limits.ts';

test('the default round-trip limit leaves room for real multi-hundred-step work', () => {
  // A 25-step cap cut ordinary tasks off mid-work; 500 is the observed working ceiling.
  assert.equal(DEFAULT_MAX_TURNS, 500);
  assert.ok(MAX_TURNS_CEILING >= DEFAULT_MAX_TURNS);
});

test('parseMaxTurns accepts the documented integer forms and rejects everything else', () => {
  assert.equal(parseMaxTurns(1), 1);
  assert.equal(parseMaxTurns(500), 500);
  assert.equal(parseMaxTurns('500'), 500);
  assert.equal(parseMaxTurns(' 120 '), 120);
  assert.equal(parseMaxTurns(MAX_TURNS_CEILING), MAX_TURNS_CEILING);

  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TURNS_CEILING + 1, '', '500x', 'abc', true, null, undefined, {}, [], '1e3']) {
    assert.equal(parseMaxTurns(value), null, `${JSON.stringify(value)} must not be accepted`);
  }
});
