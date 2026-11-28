import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI, textWidth, fitText } from '../src/cli/terminal.ts';
import { modelProviders } from '../src/cli/providers.ts';
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

test('TUI shows MODKH once, completes /conn, searches and selects providers by keyboard', async () => {
  const t = terminal();
  try {
    const command = t.ui.next();
    t.input.emit('keypress', '/conn', {});
    assert.match(t.text(), /MoDKH  ·  Coding Harness/);
    assert.match(t.text(), /\/connect/);
    t.key('return'); assert.equal(await command, '/connect');
    const select = t.ui.choose('Connect an integration', modelProviders());
    const menu = t.text();
    for (const p of modelProviders()) assert.ok(menu.includes(p.label), p.label);
    // 検索キー専用の登録はモデル接続の一覧に出さない。
    assert.equal(menu.includes('Brave Search'), false, 'a key-only entry is not a model provider');
    t.input.emit('keypress', 'open', {});
    t.key('down'); t.key('return');
    assert.equal(await select, 'opencode');
    const cancel = t.ui.choose('Connect', modelProviders());
    t.key('escape'); assert.equal(await cancel, null);
    const next = t.ui.next(); t.input.emit('keypress', '続き', {}); t.key('return'); assert.equal(await next, '続き');
  } finally { t.ui.close(); }
  assert.equal(t.input.isRaw, false);
  assert.match(t.screen(), /\x1b\[\?2004l/);
  assert.doesNotMatch(t.screen(), /\x1b\[\?1049/);
  assert.equal(t.input.listenerCount('keypress'), 0);
});

test('the welcome banner leaves the screen when the first turn starts', () => {
  const t = terminal(120, 30);
  try {
    const input = t.ui.next();
    assert.match(t.text(), /██████╗/);
    t.ui.write('▶ You: 最初の会話\n', 'user');
    t.ui.write('回答の本文です\n');
    const view = t.text();
    assert.doesNotMatch(view, /██████╗/);
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
    assert.match(title.trim(), /MoDKH  ·  Coding Harness/, 'the title rides directly above the logo');
  } finally { t.ui.close(); }
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
    const empty = t.ui.choose('Providers', modelProviders(), 'not-a-provider');
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
      assert.match(colored.screen(), /\x1b\[34m│/);
      assert.doesNotMatch(colored.screen(), /\x1b\[35m/);
    } finally { colored.ui.close(); }
    process.env.NO_COLOR = '1';
    const plain = terminal();
    try { assert.doesNotMatch(plain.screen(), /\x1b\[[0-9;]*m/); }
    finally { plain.ui.close(); }
  } finally { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
});

test('the composer status line and its notices stay readable on the terminal background', () => {
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  const t = terminal();
  try {
    t.ui.write('▶ You: 作業\n', 'user');
    assert.match(t.screen(), /\x1b\[49;34m MoDKH  ·  /, 'the status line is drawn with the terminal background and accent');
    const finish = t.ui.beginFollowups(() => null);
    t.key('a', '続き');
    t.key('return');
    assert.match(t.text(), /追加の依頼を受け付けました/);
    assert.match(t.screen(), /49;34;1m/, 'a notice is emphasized over the standing status');
    finish([]);
  } finally {
    t.ui.close();
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
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
    assert.equal(view.split('/usage').length - 1, 1, 'usage is discoverable in the menu');
    assert.equal(view.split('/exit').length - 1, 1, 'menu rows appear once');
    t.key('return'); // メニュー先頭候補(/connect)で決定する
    assert.equal(await line, '/connect');
  } finally { t.ui.close(); }
});

test('followup image-only drafts survive rejection, deletion and unsent recovery', async () => {
  const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jlhkAAAAASUVORK5CYII=' };
  const t = terminal(100, 30, { readClipboardImage: async () => image });
  const paste = async () => { t.key('v', '', true); await new Promise(resolve => setImmediate(resolve)); };
  try {
    let reject = true;
    const finish = t.ui.beginFollowups((text, images) => {
      assert.equal(text, ''); assert.deepEqual(images, [image]);
      return reject ? '受付失敗' : null;
    });
    await paste(); await paste(); t.key('x', '', true); t.key('return');
    assert.match(t.text(), /受付失敗/); assert.match(t.text(), /画像1枚/);
    reject = false; t.key('return'); assert.equal(t.ui.imageCount, 0);
    await paste(); finish([{ text: '', images: [image] }]);
    const next = t.ui.next(); t.key('return'); assert.equal(await next, '');
    assert.deepEqual(t.ui.takeImages(), [image, image]);
  } finally { t.ui.close(); }
});

test('busy terminal does not put execution status beside the editor', () => {
  const t = terminal();
  try {
    t.ui.setActivity('モデルが推論中… Ctrl+Cで中止');
    assert.doesNotMatch(t.text(), /モデルが推論中/);
    assert.doesNotMatch(t.text(), /Enter 送信/);
    t.ui.setActivity(null);
    assert.doesNotMatch(t.text(), /処理中/);
  } finally { t.ui.close(); }
});

test('Up recalls the last submitted chat text for editing, including accepted followups', async () => {
  const t = terminal();
  try {
    const first = t.ui.next();
    t.key('paste-start'); t.key('', '一行目\n二行目🙂'); t.key('paste-end');
    t.key('return');
    assert.equal(await first, '一行目\n二行目🙂');

    const secret = t.ui.ask('key', undefined, true);
    t.key('', 'private'); t.key('return'); await secret;

    const sent: string[] = [];
    const finish = t.ui.beginFollowups(text => { sent.push(text); return null; });
    t.key('up'); t.key('backspace'); t.key('', '！'); t.key('return');
    finish([]);
    assert.deepEqual(sent, ['一行目\n二行目！']);

    const next = t.ui.next();
    t.key('up'); t.key('return');
    assert.equal(await next, sent[0]);
  } finally { t.ui.close(); }
});

test('repeated Up and Down traverse submitted inputs and return to the empty composer', async () => {
  const t = terminal();
  try {
    for (const text of ['first prompt', 'second prompt', 'third prompt']) {
      const input = t.ui.next();
      t.key('', text); t.key('return');
      assert.equal(await input, text);
    }
    const input = t.ui.next();
    for (const [key, expected] of [
      ['up', 'third prompt'], ['up', 'second prompt'], ['up', 'first prompt'],
      ['up', 'first prompt'], ['down', 'second prompt'], ['down', 'third prompt'],
    ]) {
      t.key(key);
      assert.ok(t.text().includes(expected), 'expected ' + expected);
    }
    t.key('down'); t.key('', 'new prompt'); t.key('return');
    assert.equal(await input, 'new prompt');
  } finally { t.ui.close(); }
});
