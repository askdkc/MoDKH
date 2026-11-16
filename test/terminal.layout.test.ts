import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI, createTerminal, textWidth } from '../src/cli/terminal.ts';
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
    t.ui.write('▶ You: do the work\n', 'user');
    const active = t.ui.next();
    const screen = screenFrom(t.raw(), 36);
    assert.equal(screen.findIndex(line => line.includes('/workspace')), 35, 'conversation composer stays at bottom');
    t.key('return'); await active;
  } finally { t.ui.close(); }
});

test('the welcome stays centered and the conversation uses two columns', async () => {
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

    t.ui.write('▶ You: 作業を始めます\n', 'user');
    const conversation = screenFrom(t.raw(), 40);
    const used2 = Math.max(...conversation.map(line => textWidth(line)));
    assert.equal(used2, 200, 'the sidebar reaches the right edge');
    assert.equal(textWidth(conversation[1].split('│')[0]), 164, 'the sidebar starts after the transcript');
    assert.ok(used2 <= 200, 'never exceeds the terminal');

    t.input.emit('keypress', 'x', {});
    t.key('return');
    assert.equal(await input, 'x');
  } finally { t.ui.close(); }
});

test('transcript lines carry no leading margin and survive copying intact', () => {
  const t = terminal(120, 30);
  try {
    void t.ui.next();
    t.ui.write('▶ You: 依頼\n', 'user');
    // 折り返し地点に長いトークンを置く: 文字数で切ると `headBudget+t` / `ailBudget` に割れる。
    t.ui.write('1. `TextSink.text()` の重なり計算を修正し、`produced > budget` でない場合でも欠落が起きないようにする。境界（`produced == headBudget+tailBudget`、`produced == budget`）のテストを追加。\n');
    const lines = stripVTControlCharacters(t.raw()).split(/\r?\n/);
    const body = lines.filter(line => /TextSink|tailBudget|欠落/.test(line));
    assert.ok(body.length >= 2, 'the long paragraph is wrapped');
    for (const line of body) {
      assert.ok(!/^\s+\S/.test(line), `no leading margin: ${JSON.stringify(line)}`);
    }
    // 折り返しても内容は失われず、トークンも割れない。
    const joined = stripVTControlCharacters(t.raw());
    assert.ok(joined.includes('headBudget+tailBudget`'), 'the long token stays in one piece');
    assert.match(joined, /produced\s+==\s+budget`/, 'the second expression keeps its tokens');
  } finally { t.ui.close(); }
});

test('a narrow terminal never widens past its own width', async () => {
  const t = terminal(40, 14);
  try {
    const input = t.ui.next();
    assert.ok(t.text().includes('MoDKH'), 'narrow welcome keeps the full brand');
    assert.ok(!t.text().includes('███╗'), 'oversized wordmark is replaced, not clipped');
    t.ui.write('▶ You: 狭い画面\n', 'user');
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
    t.ui.write('▶ You: 依頼\n', 'user');
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
    t.ui.write('▶ You: 続き\n', 'user');
    const view = t.text();
    assert.match(view, /│ MoDKH/, 'the live status block stays on screen');
  } finally { t.ui.close(); }
});

test('the active child uses a right-hand pane and remains visible after narrowing', async () => {
  const t = terminal(110, 30);
  try {
    t.ui.write('▶ You: 調査\n', 'user');
    t.ui.setActivity('子エージェントの結果を待機中');
    t.ui.setSubagent({ pluginId: 'modkh-explorer', task: '設定ファイルを調査', phase: 'モデル応答を待機中' }, 1);
    assert.match(t.text(), /子エージェントの結果を待機中/);
    assert.match(t.text(), /│ サブエージェント 1稼働 \/ 累計1 +│/);
    assert.match(t.text(), /│ モデル応答を待機中 · 0秒/);
    assert.match(t.text(), /│ 設定ファイルを調査 +│/);
    t.output.columns = 40;
    t.output.emit('resize');
    assert.match(t.text(), /│ モデル応答を待機中 · 0秒/);
    assert.match(t.text(), /│ modkh-explorer/);
    assert.match(t.text(), /│ 設定ファイルを調査/);
    assert.ok(t.text().split('\n').every(line => textWidth(line) <= 40));

    const approved = t.ui.ask('承認: y で実行');
    t.ui.setSubagent({ pluginId: 'modkh-explorer', task: '設定ファイルを調査', phase: '承認待ち' }, 1);
    assert.match(t.text(), /承認: y で実行/);
    assert.match(t.text(), /承認待ち/);
    t.key('y', 'y');
    t.key('return');
    assert.equal(await approved, 'y');

    t.ui.setSubagent(null, 1);
    assert.doesNotMatch(t.text(), /modkh-explorer|承認待ち/);
  } finally { t.ui.close(); }
});

test('running language servers are listed in the right-hand pane', async () => {
  const t = terminal(110, 30);
  try {
    t.ui.write('▶ You: 調査\n', 'user');
    assert.match(t.text(), /│ 言語サーバー 0稼働 +│/);
    t.ui.setServers([{ id: 'typescript', root: '/workspace' }, { id: 'typescript', root: '/workspace/packages/test' }]);
    const view = t.text();
    assert.match(view, /│ 言語サーバー 2稼働 +│/, 'the pane gets its own heading');
    assert.match(view, /│ typescript · workspace +│/);
    assert.match(view, /│ typescript · packages\/test +│/);
    t.ui.setUsage({ input: 100, cacheWrite: 5, responses: 1 });
    const sections = t.text().split('\n').map(row => row.slice(row.indexOf('│')));
    const subagents = sections.findIndex(row => row.startsWith('│ サブエージェント'));
    const servers = sections.findIndex(row => row.startsWith('│ 言語サーバー'));
    for (const heading of [subagents, servers]) {
      assert.match(sections[heading - 3], /^│ +│$/);
      assert.match(sections[heading - 2], /^│ ─+ +│$/);
      assert.match(sections[heading - 1], /^│ +│$/);
    }
    t.output.rows = 9;
    t.output.emit('resize');
    assert.match(t.text(), /│ サブエージェント 0稼働 \/ 累計0 +│/);
    assert.match(t.text(), /│ 言語サーバー 2稼働 +│/);
    t.output.rows = 30;
    t.output.emit('resize');
    // The list is display state only: a running server never implies analysis succeeded.
    t.ui.setServers([{ id: 'ts', root: '/workspace' }]);
    assert.doesNotMatch(t.text(), /packages\/test/);
    t.ui.setServers([{ id: 'typescript', root: '/workspace/a-very-long-prefix/日本語/project' }]);
    assert.match(t.text(), /│ typescript · …[^│]*日本語\/project +│/);
    t.ui.setServers([]);
    assert.match(t.text(), /│ 言語サーバー 0稼働 +│/);
    assert.doesNotMatch(t.text(), /│ ts · workspace +│/);
  } finally { t.ui.close(); }
});

test('only the configured number of servers is listed and the rest are counted', async () => {
  const t = terminal(110, 30);
  try {
    t.ui.write('▶ You: 調査\n', 'user');
    t.ui.setServers(['ts', 'css', 'html', 'php', 'js'].map(id => ({ id, root: '/workspace' })));
    const view = t.text();
    assert.match(view, /│ ほか2件 +│/);
    assert.doesNotMatch(view, /│ 言語サーバー.*\n.*│ php/, 'overflow rows stay out of the pane');
  } finally { t.ui.close(); }
});

test('line mode announces a started server once', async () => {
  // MODKH_PLAIN makes createTerminal return the non-TTY implementation, so this exercises
  // the same entry point the CLI uses instead of reaching into a private class.
  const previous = process.env.MODKH_PLAIN;
  process.env.MODKH_PLAIN = '1';
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    const plain = createTerminal('/workspace');
    plain.setServers?.([{ id: 'ts', root: '/workspace' }]);
    plain.setServers?.([{ id: 'ts', root: '/workspace' }]);
    assert.equal(written.filter(line => line.includes('言語サーバー: ts')).length, 1);
    plain.close();
  } finally {
    process.stdout.write = original;
    if (previous === undefined) delete process.env.MODKH_PLAIN;
    else process.env.MODKH_PLAIN = previous;
  }
});

test('an approval temporarily takes the input without consuming the follow-up draft', async () => {
  const t = terminal();
  try {
    t.ui.write('▶ You: 調査\n', 'user');
    const sent: string[] = [];
    const finish = t.ui.beginFollowups(text => { sent.push(text); return null; });
    t.key('a', '追記');
    const approval = t.ui.ask('承認: y で実行');
    assert.match(t.text(), /承認: y で実行/);
    t.key('y', 'y');
    t.key('return');
    assert.equal(await approval, 'y');
    assert.match(t.text(), /│ 追記/);
    t.key('return');
    assert.deepEqual(sent, ['追記']);
    finish([]);
  } finally { t.ui.close(); }
});
