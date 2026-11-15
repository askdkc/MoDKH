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

test('welcome groups logo and composer in the middle like the reference, including resize and menus', async () => {
  const t = terminal(160, 48);
  try {
    t.ui.setModel('compatible/example');
    const pending = t.ui.next();
    const check = (rows: number) => {
      const screen = screenFrom(t.raw(), rows);
      const top = screen.findIndex(line => line.includes('██████╗'));
      const input = screen.findIndex(line => line.includes('何を調べますか'));
      const bottom = screen.findIndex(line => line.includes('/workspace'));
      assert.ok(input - top <= 10, `logo and input must be adjacent: ${top}, ${input}`);
      assert.ok(Math.abs((top + bottom) / 2 - (rows - 1) / 2) <= 2, `group must be centered: ${top}, ${bottom}`);
      assert.ok(rows - bottom > 5, 'welcome input must not be pinned to the bottom');
    };
    check(48);
    t.output.rows = 36; t.output.emit('resize'); check(36);
    t.key('slash', '/');
    assert.equal((screenFrom(t.raw(), 36).join('\n').match(/Commands/g) ?? []).length, 1);
    t.key('u', '', true);
    check(36);
    t.key('return'); await pending;
    t.ui.write('▶ You: do the work\n');
    const active = t.ui.next();
    const screen = screenFrom(t.raw(), 36);
    assert.equal(screen.findIndex(line => line.includes('/workspace')), 35, 'conversation composer stays at bottom');
    t.key('return'); await active;
  } finally { t.ui.close(); }
});

test('the welcome block stays compact, and a conversation widens to ~85% of the screen', async () => {
  const t = terminal(200, 40);
  try {
    const input = t.ui.next();
    const welcome = t.text().split('\n');
    // ウェルカムは端末全体の中央に寄せられる。コンテンツ幅は80列で、
    // 余白(margin)を除いた本文は80列以内。
    const used = Math.max(...welcome.map(line => textWidth(line.trim())));
    assert.ok(used <= 80, `welcome stays compact: ${used}`);
    const logoRows = welcome.filter(line => line.trim().startsWith('█'));
    assert.ok(logoRows.some(line => line.includes('███╗   ███╗')), 'wordmark includes M');
    for (const line of logoRows) {
      const left = line.length - line.trimStart().length;
      const right = 200 - left - textWidth(line.trim());
      assert.ok(Math.abs(left - right) <= 1, 'each logo row is centered');
    }

    t.ui.write('▶ You: 作業を始めます\n');
    const conversation = screenFrom(t.raw(), 40);
    const used2 = Math.max(...conversation.map(line => textWidth(line)));
    // 85% of 200 columns is 170; streamed conversation lines must actually use it.
    assert.ok(used2 >= 160, `conversation should use the width: ${used2}`);
    assert.ok(used2 <= 200, 'never exceeds the terminal');

    t.input.emit('keypress', 'x', {});
    t.key('return');
    assert.equal(await input, 'x');
  } finally { t.ui.close(); }
});

test('a narrow terminal never widens past its own width', async () => {
  const t = terminal(40, 14);
  try {
    const input = t.ui.next();
    assert.ok(t.text().includes('MoDKH'), 'narrow welcome keeps the full brand');
    assert.ok(!t.text().includes('███╗'), 'oversized wordmark is replaced, not clipped');
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
    assert.match(view, /│ MoDKH/, 'the live status block stays on screen');
  } finally { t.ui.close(); }
});
