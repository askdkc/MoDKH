import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import { TerminalUI, textWidth, fitText } from '../src/cli/terminal.ts';
import { CONNECT_PROVIDERS } from '../src/cli/providers.ts';

function terminal(columns = 100, rows = 30, options?: { readClipboardImage?: (signal: AbortSignal) => Promise<{ mediaType: 'image/png'; data: string }> }) {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = columns; output.rows = rows;
  let screen = '';
  output.on('data', chunk => { screen += chunk.toString(); });
  const ui = new TerminalUI('/workspace/日本語', input, output, options);
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
    t.key('return'); assert.equal(await line, '日本\n/exit'); // Pasted newlines are preserved, never executed.
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

function latestFrame(output: string): { raw: string; lines: string[]; cursorRow: number; cursorColumn: number } {
  const raw = output.slice(output.lastIndexOf('\x1b[H') + 3);
  const cursor = /\x1b\[(\d+);(\d+)H/.exec(raw);
  assert.ok(cursor, 'frame must position the input cursor');
  return { raw, lines: stripVTControlCharacters(raw).split('\r\n'), cursorRow: Number(cursor[1]), cursorColumn: Number(cursor[2]) };
}

test('welcome logo and editor form one compact centered block on a large terminal', async () => {
  const t = terminal(160, 50);
  try {
    const input = t.ui.next();
    const frame = latestFrame(t.screen());
    const logoTop = frame.lines.findIndex(line => line.includes('██████'));
    const editor = frame.lines.findIndex(line => line.includes('何を調べますか'));
    const footer = frame.lines.findIndex(line => line.includes('/workspace/日本語'));
    assert.ok(logoTop >= 12 && logoTop <= 21, `logo row: ${logoTop}`);
    assert.ok(editor >= 23 && editor <= 32, `editor row: ${editor}`);
    assert.ok(editor - logoTop <= 12, 'logo must remain near the editor');
    assert.ok(footer < 38, 'welcome editor must not remain anchored to the bottom');
    assert.equal(frame.cursorRow, editor + 1);
    const border = frame.lines.find(line => line.trim().startsWith('──'))!;
    assert.ok(textWidth(border.trim()) <= 80, 'welcome content should stay compact');
    const margin = border.length - border.trimStart().length;
    assert.ok(Math.abs((margin + textWidth(border.trim()) / 2) - 80) <= 1);
    t.input.emit('keypress', '中央の入力', {}); t.key('return');
    assert.equal(await input, '中央の入力');
  } finally { t.ui.close(); }
});

test('accent uses blue and NO_COLOR disables its styling', () => {
  const previous = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    const colored = terminal();
    try {
      assert.match(latestFrame(colored.screen()).raw, /\x1b\[34m/);
      assert.doesNotMatch(latestFrame(colored.screen()).raw, /\x1b\[35m/);
    } finally { colored.ui.close(); }
    process.env.NO_COLOR = '1';
    const plain = terminal();
    try { assert.doesNotMatch(plain.screen(), /\x1b\[[0-9;]*m/); }
    finally { plain.ui.close(); }
  } finally { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
});

test('centered welcome resize preserves editing and history keeps its bottom editor', async () => {
  const t = terminal(160, 50);
  try {
    const input = t.ui.next();
    t.input.emit('keypress', '日本🙂', {});
    t.output.columns = 24; t.output.rows = 10; t.output.emit('resize');
    const narrow = latestFrame(t.screen());
    assert.ok(narrow.lines.every(line => textWidth(line) <= 24));
    assert.match(narrow.lines[narrow.cursorRow - 1], /日本🙂/);
    t.output.columns = 160; t.output.rows = 50; t.output.emit('resize');
    const restored = latestFrame(t.screen());
    assert.ok(restored.cursorRow < 38);
    assert.equal(restored.cursorColumn, narrow.cursorColumn - 2 + (160 - 80) / 2);
    t.key('return'); assert.equal(await input, '日本🙂');
    t.ui.write('▶ You: a real conversation\n回答を表示します\n');
    const next = t.ui.next();
    const conversation = latestFrame(t.screen());
    assert.ok(conversation.cursorRow >= 44, 'conversation history retains the bottom editor');
    assert.match(conversation.lines.join('\n'), /回答を表示します/);
    t.key('return'); assert.equal(await next, '');
  } finally { t.ui.close(); }
});

test('busy terminal distinguishes model reasoning from completion without showing private reasoning', () => {
  const t = terminal();
  try {
    t.ui.setActivity('モデルが推論中… Ctrl+Cで中止');
    assert.match(latestFrame(t.screen()).lines.join('\n'), /モデルが推論中/);
    assert.doesNotMatch(latestFrame(t.screen()).lines.join('\n'), /Enter 送信/);
    t.ui.setActivity(null);
    assert.match(latestFrame(t.screen()).lines.join('\n'), /処理中/);
  } finally { t.ui.close(); }
});
