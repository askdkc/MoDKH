import test from 'node:test';
import assert from 'node:assert/strict';
import { completionArtPicker } from '../src/cli/completion-art.ts';

test('each round displays ten distinct celebrations without repeating at the boundary', () => {
  const next = completionArtPicker();
  const first = Array.from({ length: 10 }, next);
  const second = Array.from({ length: 10 }, next);
  assert.equal(new Set(first).size, 10);
  assert.deepEqual(new Set(second), new Set(first));
  assert.notEqual(second[0], first[9]);
  for (const art of first) {
    assert.ok(art.split('\n').length >= 3);
    assert.match(art, /回答できたよ！/);
  }
});
