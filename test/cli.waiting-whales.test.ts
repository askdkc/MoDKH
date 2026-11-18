import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textWidth } from '../src/cli/editor.ts';
import { whaleRow } from '../src/cli/waiting-whales.ts';

test('waiting whales swim left with a wave-filled gap, then wrap to the right', () => {
  for (const width of [11, 20, 21]) {
    const first = whaleRow(0, width);
    const gap = Math.min(8, width - 10);
    let previous = first.indexOf('🐳');
    let frame = 0;
    assert.ok(previous > 1);
    while (previous > 1) {
      const row = whaleRow(++frame, width);
      assert.equal(textWidth(row), width);
      const lead = row.indexOf('🐳');
      assert.equal(lead, Math.max(1, previous - 2));
      const between = row.slice(lead + '🐳'.length, row.indexOf('🐋'));
      assert.equal(textWidth(between), gap);
      assert.match(between, /^[∿~ ]+$/u);
      previous = lead;
    }
    assert.equal(whaleRow(frame + 1, width).indexOf('🐳'), first.indexOf('🐳'));
  }
  assert.equal(whaleRow(0, 10), '');
});
