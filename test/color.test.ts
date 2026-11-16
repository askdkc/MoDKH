import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TranscriptColorizer,
  classifyBackground,
  backgroundLuminance,
  parseOscBackground,
  paletteFor,
  highlightCodeLine,
} from '../src/cli/color.ts';

const dark = paletteFor('dark');
const light = paletteFor('light');

test('background classification from OSC 11 replies and COLORFGBG', () => {
  assert.equal(parseOscBackground('\x1b]11;rgb:ffff/ffff/ffff\x1b\\'), 'rgb:ffff/ffff/ffff');
  assert.equal(parseOscBackground('noise \x1b]11;rgb:0000/0000/0000\x07 tail'), 'rgb:0000/0000/0000');
  assert.equal(parseOscBackground('no reply'), null);
  const l = backgroundLuminance('rgb:ffff/ffff/ffff');
  assert.equal(l, 1);
  assert.equal(backgroundLuminance('rgb:0000/0000/0000'), 0);
  assert.equal(classifyBackground('rgb:1b2a/1b2a/1b2a'), 'dark');
  assert.equal(classifyBackground('rgb:ffff/ffff/dcdc'), 'light');
  assert.equal(classifyBackground(null, { COLORFGBG: '0;15' }), 'light');
  assert.equal(classifyBackground(null, { COLORFGBG: '15;0' }), 'dark');
  assert.equal(classifyBackground(null, {}), null);
});

test('palettes differ between light and dark for the colors that need it', () => {
  const differing = (Object.keys(dark) as (keyof typeof dark)[])
    .filter(key => dark[key] !== light[key]);
  assert.ok(differing.length >= 3, `light/dark palettes differ on ${differing.length} codes`);
  for (const key of differing) {
    assert.match(dark[key] ?? '', /^[0-9;]+$/);
    assert.match(light[key] ?? '', /^[0-9;]+$/);
  }
});

test('reasoning stays gray even when it contains Markdown or resembles a tool message', () => {
  for (const palette of [light, dark]) {
    const colorizer = new TranscriptColorizer();
    for (const line of ['(推論)', '## 検討', '▶ read_file (略)', '```ts', 'const x = 1']) {
      assert.equal(colorizer.line(line, palette, 'reasoning'), `\x1b[90m${line}\x1b[0m`);
    }
    assert.equal(colorizer.line('何を調べますか？', palette, 'answer'), '\x1b[1;39m何を調べますか？\x1b[0m');
    assert.equal(colorizer.line('会話終了', palette), '会話終了');
  }
});

test('diff lines get add/del colors from the header until a non-diff line', () => {
  const c = new TranscriptColorizer();
  const lines = [
    '--- README.md',
    '+++ README.md',
    '  context line',
    '- removed line',
    '+ added line',
    '(承認)',
    'plain text',
  ];
  const [h1, h2, ctx, del, add, ack, plain] = lines.map(l => c.line(l, dark));
  assert.match(h1!, /\x1b\[96m/);
  assert.match(h2!, /(\x1b\[96m)/);
  assert.equal(ctx, '  context line', 'context stays uncolored');
  assert.match(del!, /\x1b\[91m/);
  assert.match(add!, /\x1b\[92m/);
  assert.equal(plain, 'plain text', 'color mode left the diff');
  // 承認要求ヘッダはdiff判定を始めない。ヘッダ行の後からdiff着色が始まる。
  const c2 = new TranscriptColorizer();
  assert.doesNotMatch(c2.line('--- 承認要求(edit) ---', dark), /\x1b\[96m/);
  c2.line('--- README.md', dark);
  assert.match(c2.line('+ added', dark), /\x1b\[92m/);
});

test('fenced code blocks receive simple syntax coloring', () => {
  const c = new TranscriptColorizer();
  assert.match(c.line('```ts', dark), /\x1b\[9/);
  const colored = c.line('const n = 42; // count', dark);
  assert.match(colored, /\x1b\[94mconst\x1b\[0m/);
  assert.match(colored, /\x1b\[95m42\x1b\[0m/);
  assert.match(colored, /\x1b\[90m\W*\/\/ count/, 'comment is dimmed');
  const closing = c.line('```', dark);
  assert.match(closing, /\x1b\[9/);
  assert.equal(c.line('const', dark), 'const', 'outside a block keywords stay plain');
});

test('code highlighting keeps strings and numbers intact', () => {
  const out = highlightCodeLine('await fetch("https://example.com/v1?q=1")', light);
  assert.match(out, /https:\/\/example\.com\/v1/);
  assert.match(out, /\x1b\[38;5;130m/, 'the light palette colors strings with a low-saturation orange');
  const darkOut = highlightCodeLine('status = "ok"', dark);
  assert.match(darkOut, /\x1b\[33m/, 'the dark palette colors strings with the standard amber');
});

test('user, tool, result and status lines each get their own style', () => {
  const c = new TranscriptColorizer();
  assert.match(c.line('▶ You: 依頼', dark), /\x1b\[1m/);
  assert.match(c.line('▶ read_file (略)', light), /\x1b\[38;5;26m/);
  assert.match(c.line('  (結果: ok) README.md を読んだ', dark), /\x1b\[9\d?m|90/);
  assert.match(c.line('## 見出し', light), /\x1b\[1m/);
});
