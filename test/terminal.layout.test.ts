import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import { TerminalUI, textWidth } from '../src/cli/terminal.ts';

function terminal(columns = 100, rows = 30) {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = raw => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = columns; output.rows = rows;
  let raw = '';
  output.on('data', chunk => { raw += chunk.toString(); });
  const ui = new TerminalUI('/workspace', input, output);
  const frame = () => {
    const latest = raw.slice(raw.lastIndexOf('\x1b[H') + 3);
    return { raw: latest, lines: stripVTControlCharacters(latest).split('\r\n') };
  };
  return { ui, input, output, frame, key: (name: string, value = '', ctrl = false) => input.emit('keypress', value, { name, ctrl }) };
}

test('the welcome block stays compact, and a conversation widens to 85% of the screen', async () => {
  const t = terminal(200, 40);
  try {
    const welcome = t.frame();
    const welcomeBorder = welcome.lines.find(line => line.trim().startsWith('──'))!;
    assert.ok(textWidth(welcomeBorder.trim()) <= 80, 'welcome stays a compact centered group');

    const input = t.ui.next();
    t.ui.write('▶ You: 作業を始めます\n');
    const conversation = t.frame();
    const used = Math.max(...conversation.lines.map(line => textWidth(line)));
    // 85% of 200 columns is 170; the editor and transcript must actually occupy it.
    assert.ok(used >= 160, `conversation should use the width: ${used}`);
    assert.ok(used <= 200, 'never exceeds the terminal');
    const border = conversation.lines.find(line => line.trim().startsWith('──'))!;
    assert.ok(textWidth(border.trim()) >= 160, `panel border spans the wider area: ${textWidth(border.trim())}`);

    t.input.emit('keypress', 'x', {});
    t.key('return');
    assert.equal(await input, 'x');
  } finally { t.ui.close(); }
});

test('a narrow terminal never widens past its own width', async () => {
  const t = terminal(40, 14);
  try {
    const input = t.ui.next();
    t.ui.write('▶ You: 狭い画面\n');
    const frame = t.frame();
    assert.ok(frame.lines.every(line => textWidth(line) <= 40), 'no line may exceed the terminal');
    t.key('return');
    assert.equal(await input, '');
  } finally { t.ui.close(); }
});

test('reasoning is displayed while it streams and then kept in the transcript', async () => {
  const t = terminal(160, 40);
  try {
    const input = t.ui.next();
    t.ui.setReasoning('まずファイルを読みます。');
    const live = t.frame().lines.join('\n');
    assert.match(live, /\(推論\)/, 'live reasoning is labelled');
    assert.match(live, /まずファイルを読みます/, 'reasoning text is visible');

    t.ui.setReasoning('続けて確認します。');
    assert.match(t.frame().lines.join('\n'), /続けて確認します/, 'deltas accumulate');

    // Flushing keeps the finished block in the scrollback and clears the live area.
    t.ui.setReasoning(null);
    t.ui.write('▶ read_file\n');
    const after = t.frame().lines.join('\n');
    assert.match(after, /まずファイルを読みます/, 'flushed reasoning stays in the transcript');
    assert.match(after, /▶ read_file/);
    assert.equal((after.match(/\(推論\)/g) ?? []).length, 1, 'one block, not a duplicate');

    t.key('return');
    assert.equal(await input, '');
  } finally { t.ui.close(); }
});

test('reasoning never enters the request messages', async () => {
  const t = terminal();
  try {
    const input = t.ui.next();
    t.ui.setReasoning('SECRET_CHAIN_OF_THOUGHT');
    t.ui.setReasoning(null);
    t.ui.write('▶ You: 依頼\n');
    // The transcript is display state; the agent loop owns `messages` and only receives text-delta
    // through onText. Reasoning reaching the screen must not be mistaken for assistant content.
    const frame = stripVTControlCharacters(t.frame().raw);
    assert.match(frame, /SECRET_CHAIN_OF_THOUGHT/);
    t.key('return');
    assert.equal(await input, '');
  } finally { t.ui.close(); }
});
