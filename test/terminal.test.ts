import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import { TerminalUI, textWidth, fitText } from '../src/cli/terminal.ts';
import { CONNECT_PROVIDERS } from '../src/cli/providers.ts';

function terminal(columns = 100, rows = 30) {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = columns; output.rows = rows;
  let screen = '';
  output.on('data', chunk => { screen += chunk.toString(); });
  const ui = new TerminalUI('/workspace/日本語', input, output);
  return { ui, input, output, screen: () => screen, clear: () => { screen = ''; },
    key: (name: string, value = '', ctrl = false) => input.emit('keypress', value, { name, ctrl }) };
}
test('TUI shows DKH, completes /conn, searches and selects all seven providers by keyboard', async () => {
  const t = terminal();
  try {
    const command = t.ui.next();
    t.input.emit('keypress', '/conn', {});
    assert.match(stripVTControlCharacters(t.screen()), /DKH/);
    assert.match(stripVTControlCharacters(t.screen()), /\/connect/);
    t.key('return'); assert.equal(await command, '/connect');
    const select = t.ui.choose('Connect an integration', CONNECT_PROVIDERS);
    for (const p of CONNECT_PROVIDERS) assert.ok(stripVTControlCharacters(t.screen()).includes(p.label), p.label);
    t.input.emit('keypress', 'open', {});
    t.key('down'); t.key('return');
    assert.equal(await select, 'opencode');
    const cancel = t.ui.choose('Connect', CONNECT_PROVIDERS);
    t.key('escape'); assert.equal(await cancel, null);
    const next = t.ui.next(); t.input.emit('keypress', '続き', {}); t.key('return'); assert.equal(await next, '続き');
  } finally { t.ui.close(); }
  assert.equal(t.input.isRaw, false);
  assert.match(t.screen(), /\x1b\[\?1049l/);
  assert.equal(t.input.listenerCount('keypress'), 0);
});
test('secret prompt masks pasted credentials and does not retain them on screen', async () => {
  const t = terminal();
  try {
    const key = t.ui.ask('API key', undefined, true);
    t.clear(); t.input.emit('keypress', 'sk-secret', {});
    assert.doesNotMatch(t.screen(), /sk-secret/);
    assert.match(t.screen(), /••••/);
    t.key('return'); assert.equal(await key, 'sk-secret');
    assert.doesNotMatch(t.screen(), /sk-secret/);
  } finally { t.ui.close(); }
});
test('Unicode editing, paste safety, empty search and resize retain focus', async () => {
  const t = terminal(40, 14);
  try {
    const line = t.ui.next();
    t.input.emit('keypress', '日本🙂', {}); t.key('backspace');
    t.key('paste-start'); t.key('return', '\r'); t.input.emit('keypress', '/exit', {}); t.key('paste-end');
    t.output.columns = 24; t.output.rows = 10; t.output.emit('resize');
    t.key('return'); assert.equal(await line, '日本 /exit');
    const empty = t.ui.choose('Providers', CONNECT_PROVIDERS, 'not-a-provider');
    assert.match(stripVTControlCharacters(t.screen()), /該当なし/);
    t.key('return'); t.key('escape'); assert.equal(await empty, null);
    assert.equal(textWidth('日本🙂'), 6); assert.equal(fitText('日本🙂', 5), '日本');
  } finally { t.ui.close(); }
});
test('aborting an approval resolves once and permits the next input', async () => {
  const t = terminal();
  try {
    const ac = new AbortController();
    const approval = t.ui.ask('approve?', ac.signal);
    ac.abort(); assert.equal(await approval, null);
    const next = t.ui.next(); t.input.emit('keypress', '/exit', {}); t.key('return');
    assert.equal(await next, '/exit');
  } finally { t.ui.close(); }
});
