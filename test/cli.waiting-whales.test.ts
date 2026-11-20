import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textWidth } from '../src/cli/editor.ts';
import { whaleRow } from '../src/cli/waiting-whales.ts';

test('wide rows show a repeating pod with eight wave columns between swimmers', () => {
  for (let frame = 0; frame < 20; frame++) {
    const row = whaleRow(frame, 80);
    assert.equal(textWidth(row), 80);
    assert.match(row, /🐳[∿~ ]{8}🐋[∿~ ]{8}🫍[∿~ ]{8}🐳/u);
  }
});

test('swimmers move left and cycle through narrow rows without overflowing', () => {
  for (const width of [11, 20, 21]) {
    const frames = Array.from({ length: 30 }, (_, n) => whaleRow(n, width));
    for (const row of frames) assert.equal(textWidth(row), width);
    for (const swimmer of ['🐳', '🐋', '🫍']) assert.ok(frames.some(row => row.includes(swimmer)));
    assert.equal(frames[1].indexOf('🐋'), frames[0].indexOf('🐋') - 2);
  }
  assert.equal(whaleRow(0, 10), '');
});
