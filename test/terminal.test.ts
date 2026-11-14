import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI, textWidth, fitText } from '../src/cli/terminal.ts';
import { CONNECT_PROVIDERS } from '../src/cli/providers.ts';
import { screenFrom, screenText } from './tui.screen.ts';

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
    text: () => screenText(screenFrom(screen, Math.max(6, output.rows || 24))),
    key: (name: string, value = '', ctrl = false) => input.emit('keypress', value, { name, ctrl }) };
}

test('TUI shows DKH once, completes /conn, searches and selects providers by keyboard', async () => {
  const t = terminal();
  try {
    const command = t.ui.next();
    t.input.emit('keypress', '/conn', {});
    assert.match(t.text(), /DKH  ·  Coding Harness/);
    assert.match(t.text(), /\/connect/);
    t.key('return'); assert.equal(await command, '/connect');
    const select = t.ui.choose('Connect an integration', CONNECT_PROVIDERS);
    const menu = t.text();
    for (const p of CONNECT_PROVIDERS) assert.ok(menu.includes(p.label), p.label);
    t.input.emit('keypress', 'open', {});
    t.key('down'); t.key('return');
    assert.equal(await select, 'opencode');
    const cancel = t.ui.choose('Connect', CONNECT_PROVIDERS);
    t.key('escape'); assert.equal(await cancel, null);
    const next = t.ui.next(); t.input.emit('keypress', '続き', {}); t.key('return'); assert.equal(await next, '続き');
  } finally { t.ui.close(); }
  assert.equal(t.input.isRaw, false);
  assert.match(t.screen(), /\x1b\[\?2004l/);
  assert.doesNotMatch(t.screen(), /\x1b\[\?1049/);
  assert.equal(t.input.listenerCount('keypress'), 0);
});

test('the DKH banner is streamed exactly once and never erased', () => {
  const t = terminal(120, 30);
  try {
    const input = t.ui.next();
    t.ui.write('▶ You: 最初の会話\n');
    t.ui.write('回答の本文です\n');
    // 会話開始後の最終画面にロゴは1組だけ(フレーム再描画の重複ではない)
    const view = t.text();
    assert.equal(view.split('██████╗').length - 1, 1, 'the banner is painted once');
    assert.match(view, /最初の会話/);
    assert.match(view, /回答の本文です/);
    t.key('return'); void input;
  } finally { t.ui.close(); }
});

test('startup clears the screen and centers the welcome like the old design', () => {
  const t = terminal(120, 30);
  try {
    assert.match(t.screen(), /\x1b\[2J/, 'the startup view starts from a clean screen');
    const rows = t.text().split('\n');
    const padRows = rows.findIndex(line => line.includes('██████╗'));
    // ロゴは縦中央(画面下端の入力欄の上、上端から数行空けた位置)
    assert.ok(padRows >= 6 && padRows <= 20, `logo is vertically centered, row=${padRows}`);
    const logo = rows[padRows];
    const pad = logo.length - logo.trimStart().length;
    // 幅120・80列分のコンテンツを画面中央に: 余りは左右ほぼ均等
    assert.ok(pad > 10, `the banner is centered on screen, left pad=${pad}`);
    const title = rows[padRows - 1] ?? '';
    assert.match(title.trim(), /DKH  ·  Coding Harness/, 'the title rides directly above the logo');
  } finally { t.ui.close(); }
});

/** isTTY 指定の入力でOSC返信を実際に流し、打ち込まれないことを確認する。 */
function ttyTerminal(columns = 100, rows = 30) {
  const savedNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR; // 背景検出を有効にする
  const input = new PassThrough() as unknown as ReadStream & { isTTY?: boolean };
  input.isRaw = false;
  input.isTTY = true;
  input.setRawMode = (raw) => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = columns; output.rows = rows;
  let screen = '';
  output.on('data', chunk => { screen += chunk.toString(); });
  const ui = new TerminalUI('/workspace', input, output);
  const finish = (): void => {
    if (savedNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = savedNoColor;
  };
  return { ui, input, output, screen: () => screen, finish,
    text: () => screenText(screenFrom(screen, Math.max(6, output.rows || 24))),
    key: (name: string, value = '', ctrl = false) => input.emit('keypress', value, { name, ctrl }) };
}

test('the OSC background reply never lands in the input box', async () => {
  const t = ttyTerminal();
  try {
    const line = t.ui.next();
    t.input.write('garbage'); // ユーザーの打鍵はプローブ中でも通常通り入る
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(t.text(), /garbage/, 'real typing is not suppressed');
    t.input.write('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.doesNotMatch(t.text(), /11;rgb/, 'the reply chunk is swallowed');
    t.input.emit('keypress', 'x', {}); // 文字入力は data と同じ経路
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(t.text(), /garbagex/, 'input works normally after the reply is consumed');
    t.key('return');
    const outcome = await Promise.race([
      line.then(value => ({ value })),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 3000)),
    ]);
    assert.ok(outcome !== 'timeout' && outcome.value === 'garbagex',
      `the composer must accept input after the probe settles: ${JSON.stringify(outcome)}`);
  } finally { t.finish(); t.ui.close(); }
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
    assert.match(t.text(), /該当なし/);
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

/** Transcripts are streamed once and then left to the terminal's own scrollback. */
test('written transcript lines stay on screen and are never repainted', async () => {
  const t = terminal(120, 30);
  try {
    const line = t.ui.next();
    t.ui.write('▶ You: 一行目の依頼\n');
    t.ui.write('回答の本文です\n');
    const view = t.text();
    assert.match(view, /一行目の依頼/);
    assert.match(view, /回答の本文です/);
    // 非同期の処理が終わっても同じフレームで入力編集が生きる
    t.input.emit('keypress', 'x', {});
    assert.match(t.text(), /│ x/, 'the live input block keeps updating');
    t.key('return'); assert.equal(await line, 'x');
  } finally { t.ui.close(); }
});

test('accent uses blue and NO_COLOR disables its styling', () => {
  const previous = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    const colored = terminal();
    try {
      assert.match(colored.screen(), /\x1b\[34m/);
      assert.doesNotMatch(colored.screen(), /\x1b\[35m/);
    } finally { colored.ui.close(); }
    process.env.NO_COLOR = '1';
    const plain = terminal();
    try { assert.doesNotMatch(plain.screen(), /\x1b\[[0-9;]*m/); }
    finally { plain.ui.close(); }
  } finally { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
});

test('resize keeps the live block within its width and history remains streamed', async () => {
  const t = terminal(160, 30);
  try {
    const input = t.ui.next();
    t.input.emit('keypress', '日本🙂', {});
    t.output.columns = 24; t.output.rows = 10; t.output.emit('resize');
    const narrow = t.text().split('\n');
    const divider = narrow.findIndex(line => line.includes('│'));
    assert.ok(divider >= 0, 'the composer block is on screen');
    assert.ok(narrow.slice(divider).every(line => textWidth(line) <= 24), `live block respects the new width: ${JSON.stringify(narrow)}`);
    t.output.columns = 160; t.output.rows = 30; t.output.emit('resize');
    t.ui.write('▶ You: a real conversation\n回答を表示します\n');
    const view = t.text();
    assert.match(view, /回答を表示します/);
    t.key('return'); assert.equal(await input, '日本🙂');
  } finally { t.ui.close(); }
});

test('the command menu renders once, never duplicated', async () => {
  const t = terminal(100, 30);
  try {
    const line = t.ui.next();
    t.input.emit('keypress', '/', {});
    await new Promise(resolve => setTimeout(resolve, 10));
    const view = t.text();
    assert.equal(view.split('Commands').length - 1, 1, `menu header appears once: ${view.split('\n').join(' | ')}`);
    assert.equal(view.split('/exit').length - 1, 1, 'menu rows appear once');
    t.key('return'); // メニュー先頭候補(/connect)で決定する
    assert.equal(await line, '/connect');
  } finally { t.ui.close(); }
});

test('busy terminal distinguishes model reasoning from completion without showing private reasoning', () => {
  const t = terminal();
  try {
    t.ui.setActivity('モデルが推論中… Ctrl+Cで中止');
    assert.match(t.text(), /モデルが推論中/);
    assert.doesNotMatch(t.text(), /Enter 送信/);
    t.ui.setActivity(null);
    assert.match(t.text(), /処理中/);
  } finally { t.ui.close(); }
});
