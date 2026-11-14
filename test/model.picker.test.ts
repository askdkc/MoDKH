import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI, type Choice } from '../src/cli/terminal.ts';
import { chooseProviderModel } from '../src/cli/providers.ts';
import { SEARCH_ROW_VALUE, suggestionsFor } from '../src/cli/catalog.ts';
import { screenFrom } from './tui.screen.ts';

function terminal(columns = 110, rows = 30) {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = raw => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = columns; output.rows = rows;
  let raw = '';
  output.on('data', chunk => { raw += chunk.toString(); });
  const ui = new TerminalUI('/tmp', input, output);
  return {
    ui, input,
    screen: () => screenFrom(raw, rows).join('\n'),
  };
}

const MODELS: Choice[] = [
  { value: 'ollama-cloud/gemma4:31b', label: 'ollama-cloud/gemma4:31b' },
  { value: 'ollama-cloud/deepseek-v4.1-flash', label: 'ollama-cloud/deepseek-v4.1-flash', detail: '高速・低コスト' },
  { value: 'ollama-cloud/glm-5.3-flash', label: 'ollama-cloud/glm-5.3-flash', detail: '高速' },
];

test('the keyword search row is pinned to the top even while filtering', async () => {
  const t = terminal();
  try {
    const picker = t.ui.choose('モデル', [
      { value: SEARCH_ROW_VALUE, label: '🔍 キーワード検索', pinned: true },
      ...MODELS,
    ]);
    await new Promise(resolve => setImmediate(resolve));
    const before = t.screen().split('\n').filter(line => line.includes('🔍') || line.includes('gemma4'));
    assert.match(before[0] ?? '', /🔍/, 'the search row is the first row');
    // Typing a keyword keeps the search row on top while narrowing the models.
    for (const ch of 'seek deep') t.input.emit('keypress', ch, {});
    await new Promise(resolve => setImmediate(resolve));
    const after = t.screen().split('\n').map(line => line.trimEnd()).filter(line => line.includes('🔍') || line.includes('ollama-cloud/'));
    assert.match(after[0] ?? '', /🔍/, 'the search row stays first after filtering');
    assert.equal(after.some(line => line.includes('gemma4:31b')), false, 'unrelated models are filtered out');
    assert.equal(after.some(line => line.includes('deepseek-v4.1-flash')), true, 'orderless match survives');
    assert.match(t.screen(), /1件一致/, 'the search row reports how many models matched');
    t.input.emit('keypress', '', { name: 'escape' });
    assert.equal(await picker, null);
  } finally { t.ui.close(); }
});

test('orderless search ignores word order and separators', async () => {
  const t = terminal();
  try {
    const picker = t.ui.choose('モデル', [
      { value: SEARCH_ROW_VALUE, label: '🔍 キーワード検索', pinned: true },
      ...MODELS,
    ]);
    await new Promise(resolve => setImmediate(resolve));
    for (const ch of 'seek deep') t.input.emit('keypress', ch, {});
    await new Promise(resolve => setImmediate(resolve));
    assert.match(t.screen(), /ollama-cloud\/deepseek-v4\.1-flash/);
    t.input.emit('keypress', '', { name: 'escape' });
    assert.equal(await picker, null);
  } finally { t.ui.close(); }
});

test('choosing the search row asks for a keyword and reopens the list filtered', async () => {
  const t = terminal();
  try {
    const picked = chooseProviderModel(t.ui, 'ollama-cloud');
    await new Promise(resolve => setImmediate(resolve));
    // Enter on an empty box selects the pinned search row instead of an arbitrary model.
    t.input.emit('keypress', '', { name: 'return' });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(t.screen(), /キーワード検索/);
    assert.match(t.screen(), /語順/);
    for (const ch of 'seek deep') t.input.emit('keypress', ch, {});
    t.input.emit('keypress', '', { name: 'return' });
    await new Promise(resolve => setImmediate(resolve));
    // The reopened list is filtered and still keeps the search row on top.
    const rows = t.screen().split('\n').map(line => line.trimEnd()).filter(line => line.includes('🔍') || line.includes('ollama-cloud/'));
    assert.match(rows[0] ?? '', /🔍/);
    assert.equal(rows.some(line => line.includes('deepseek-v4.1-flash')), true);
    assert.equal(rows.some(line => line.includes('gemma4:31b')), false);
    // The first model row (down once) is the orderless match.
    t.input.emit('keypress', '', { name: 'down' });
    t.input.emit('keypress', '', { name: 'return' });
    assert.equal(await picked, 'ollama-cloud/deepseek-v4.1-flash');
  } finally { t.ui.close(); }
});

test('the search row never becomes a model reference', async () => {
  assert.equal(typeof SEARCH_ROW_VALUE, 'string');
  const list = suggestionsFor('ollama-cloud');
  assert.equal(list.includes(SEARCH_ROW_VALUE), false, 'the marker is not a model id');
  assert.ok(list.every(ref => /^ollama-cloud\//.test(ref)));
});
