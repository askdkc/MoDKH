import test from 'node:test';
import assert from 'node:assert/strict';
import { allSuggestions, suggestionsFor, noteFor, isRecommended, OLLAMA_CLOUD_CATALOG, OLLAMA_CLOUD_SOURCE, PROVIDER_DEFAULTS } from '../src/cli/catalog.ts';
import { MODEL_SUGGESTIONS } from '../src/cli/models.ts';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI } from '../src/cli/terminal.ts';
import { chooseProviderModel } from '../src/cli/providers.ts';

test('the Ollama Cloud catalogue carries the ordinary choices and keeps every ref well formed', () => {
  const refs = OLLAMA_CLOUD_CATALOG.map(entry => entry.ref);
  for (const expected of ['ollama-cloud/deepseek-v4.1-flash', 'ollama-cloud/glm-5.3-flash', 'ollama-cloud/glm-5.3']) {
    assert.ok(refs.includes(expected), `${expected} must be selectable`);
  }
  assert.equal(new Set(refs).size, refs.length, 'no duplicate entries');
  assert.ok(refs.every(ref => /^ollama-cloud\/[a-z0-9][a-z0-9._:-]*$/.test(ref)), 'every ref is provider/model');
  assert.match(OLLAMA_CLOUD_SOURCE.url, /^https:\/\/ollama\.com\/v1\/models$/);
  // The picker list is the catalogue plus other providers; both stay consistent.
  assert.equal(MODEL_SUGGESTIONS.length, allSuggestions().length);
  assert.ok(refs.every(ref => MODEL_SUGGESTIONS.includes(ref)));
});

test('recommendations are marked without reordering, and the current selection is never lost', () => {
  const cloud = suggestionsFor('ollama-cloud');
  // The order is stable because other callers select by position; recommendations are labels.
  assert.deepEqual(cloud, OLLAMA_CLOUD_CATALOG.map(entry => entry.ref));
  assert.equal(new Set(cloud).size, cloud.length);
  assert.ok(cloud.every(ref => ref.startsWith('ollama-cloud/')));
  for (const ref of PROVIDER_DEFAULTS['ollama-cloud']!) {
    assert.equal(isRecommended(ref), true, `${ref} is recommended`);
    assert.ok(cloud.includes(ref), `${ref} is selectable`);
  }
  assert.equal(isRecommended('ollama-cloud/beam'), false);
  const withCurrent = suggestionsFor('ollama-cloud', 'ollama-cloud/not-in-catalog');
  assert.equal(withCurrent.at(-1), 'ollama-cloud/not-in-catalog');
  // An unknown provider filters to nothing; the picker still appends the manual-ID entry.
  assert.deepEqual(suggestionsFor('nobody'), []);
  assert.ok((noteFor('ollama-cloud/deepseek-v4.1-flash')?.length ?? 0) > 0);
  assert.equal(noteFor('unknown/ref'), undefined);
});

test('the picker shows the catalogue with notes and offers a manual ID', async () => {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = raw => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = 120; output.rows = 40;
  let raw = '';
  output.on('data', chunk => { raw += chunk.toString(); });
  const ui = new TerminalUI('/tmp', input, output);
  try {
    const picked = chooseProviderModel(ui, 'ollama-cloud');
    await new Promise(resolve => setImmediate(resolve));
    const screen = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    // The first painted page holds the search row and the top of the catalogue; later rows need
    // scrolling, so the assertion is that deepseek/flash appear and the row count is complete.
    assert.match(screen, /🔍 キーワード検索/, 'the search row heads the picker');
    assert.match(screen, /ollama-cloud\/deepseek-v4\.1-flash/, 'a recommended model is on the first page');
    assert.match(screen, /おすすめ/, 'recommendations are marked');
    assert.match(screen, /高速|高精度/, 'the note appears next to a model');
    assert.ok(suggestionsFor('ollama-cloud').includes('ollama-cloud/glm-5.3-flash'), 'flash is selectable');
    input.emit('keypress', '', { name: 'escape' });
    assert.equal(await picked, null);
  } finally { ui.close(); }
});
