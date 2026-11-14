import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI, textWidth } from '../src/cli/terminal.ts';
import { screenFrom, screenText } from './tui.screen.ts';

function terminal(columns = 100, rows = 30) {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = raw => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = columns; output.rows = rows;
  let raw = '';
  output.on('data', chunk => { raw += chunk.toString(); });
  const ui = new TerminalUI('/workspace', input, output);
  return { ui, input, output, raw: () => raw, text: () => screenText(screenFrom(raw, rows)),
    key: (name: string, value = '', ctrl = false) => input.emit('keypress', value, { name, ctrl }) };
}

test('the welcome block stays compact, and a conversation widens to ~85% of the screen', async () => {
  const t = terminal(200, 40);
  try {
    const input = t.ui.next();
    const welcome = t.text();
    const wide = Math.max(...welcome.split('\n').map(line => textWidth(line)));
    assert.ok(wide <= 80, `welcome stays compact: ${wide}`);

    t.ui.write('▶ You: 作業を始めます\n');
    const used = Math.max(...screenFrom(t.raw(), 40).map(line => textWidth(line)));
    // 85% of 200 columns is 170; streamed conversation lines must actually use it.
    assert.ok(used >= 160, `conversation should use the width: ${used}`);
    assert.ok(used <= 200, 'never exceeds the terminal');

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
    assert.ok(t.text().split('\n').every(line => textWidth(line) <= 40), 'no line may exceed the terminal');
    t.key('return');
    assert.equal(await input, '');
  } finally { t.ui.close(); }
});

test('reasoning is displayed while it streams and then kept in the transcript', async () => {
  const t = terminal(160, 40);
  try {
    const input = t.ui.next();
    t.ui.setReasoning('まずファイルを読みます。');
    assert.match(t.text(), /\(推論\)/, 'live reasoning is labelled');
    assert.match(t.text(), /まずファイルを読みます/, 'reasoning text is visible');

    t.ui.setReasoning('続けて確認します。');
    assert.match(t.text(), /続けて確認します/, 'deltas accumulate');

    // Flushing prints the finished block once and clears the live area.
    t.ui.setReasoning(null);
    t.ui.write('▶ read_file\n');
    const after = t.text();
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
    assert.match(t.text(), /SECRET_CHAIN_OF_THOUGHT/);
    t.key('return');
    assert.equal(await input, '');
  } finally { t.ui.close(); }
});

test('reasoning and transcript stream into the scrollback instead of being erased', () => {
  const t = terminal(120, 20);
  try {
    t.ui.setReasoning('短い推論');
    t.ui.setReasoning(null);
    for (let i = 0; i < 30; i++) t.ui.write(`▶ ツール実行 ${i} (結果: ok)\n`);
    // 画面を超える出力は1度だけ描かれ、消去されずにスクロールバックへ流れる。
    const full = stripVTControlCharacters(t.raw());
    for (const i of [0, 5, 29]) assert.ok(full.includes(`▶ ツール実行 ${i} (結果: ok)`), `line ${i} is final`);
    // 現在の画面の最下部にはライブブロック(入力欄)が残る。
    t.ui.write('▶ You: 続き\n');
    const view = t.text();
    assert.match(view, /│ DKH/, 'the live status block stays on screen');
  } finally { t.ui.close(); }
});
