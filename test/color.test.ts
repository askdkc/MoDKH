import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TranscriptColorizer,
  classifyBackground,
  backgroundLuminance,
  parseOscBackground,
  paletteFor,
  highlightCodeLine,
  sourceLine,
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

test('grep and read hits are highlighted where they appear in tool output', () => {
  const c = new TranscriptColorizer();
  assert.match(c.line('  (結果: ok) 検索 "const": 2 件', dark), /\x1b\[9\dm/);
  const hit = c.line('  src/cli/color.ts:114: const keyword = 1; // note', dark);
  assert.match(hit, /\x1b\[94mconst\x1b\[0m/, 'a keyword inside the hit is colored');
  assert.match(hit, /\x1b\[95m1\x1b\[0m/, 'numbers are colored');
  assert.match(hit, /^\s{2}src\/cli\/color\.ts:114: /, 'the source prefix stays untouched');
  // The hit body must carry color, not just the surrounding text.
  const body = hit.slice(hit.indexOf('src/cli/color.ts:114: ') + 'src/cli/color.ts:114: '.length);
  assert.match(body, /\x1b\[94m/, 'the quoted source itself is highlighted');
  const excerpt = c.line('  27: function highlightCodeLine(line: string)', dark);
  assert.match(excerpt, /\x1b\[94mfunction\x1b\[0m/);
  // A result without source stays plain, and the mode ends with the result.
  assert.match(c.line('  (結果. 1件) 診断', dark), /\x1b\[90m/);
  const prose = c.line('plain prose after a tool result', dark);
  assert.equal(prose, 'plain prose after a tool result');
  // A tool call header ends the body, so the next quoted source is not highlighted.
  c.line('▶ search_files (pattern=const)', light);
  c.line('  (結果. 1件) 診断', dark);
  const after = c.line('  src/a.ts:1: const x = 1', dark);
  assert.doesNotMatch(after, /\x1b\[94mconst/, 'only lines that follow a (結果: …) header are treated as source');
});

test('tool output that is not source never gains code colors', () => {
  const c = new TranscriptColorizer();
  c.line('  (結果: ok) {"total": 3, "items": []}', dark);
  assert.equal(c.line('  {"total": 3, "items": []}', dark), '  {"total": 3, "items": []}');
  c.line('  (結果: ok) done', dark);
  assert.equal(c.line('  2026-01-01 12:00:00 started', dark), '  2026-01-01 12:00:00 started');
});

test('a summary line between the header and the hits keeps highlighting on', () => {
  // search_files prints `対象: …` before the hits, so a meta line must not close the body.
  const c = new TranscriptColorizer();
  c.line('  (結果: ok) 検索 "private readonly": 1 件', dark);
  assert.match(c.line('  対象: tracked。…0件を除外。', dark), /\x1b\[90m/);
  assert.match(c.line('  src/cli/terminal.ts:205:   private readonly colorizer = new x();', dark), /\x1b\[94mprivate\x1b\[0m/);
  // A later user turn or new tool call ends the body.
  c.line('▶ search_files (pattern=…)', light);
  assert.equal(c.line('  src/cli/terminal.ts:205:   private readonly colorizer = new x();', dark),
    '  src/cli/terminal.ts:205:   private readonly colorizer = new x();');
});

test('sourceLine accepts the formats the tools actually print', () => {
  assert.deepEqual(sourceLine('src/a.ts:12: const x = 1'), { body: 'const x = 1' });
  assert.deepEqual(sourceLine('12: const x = 1'), { body: 'const x = 1' });
  assert.deepEqual(sourceLine('a/b.ts:3:14: return 1'), { body: 'return 1' });
  assert.equal(sourceLine('{"total": 3}'), null);
  assert.equal(sourceLine('0: zero is not a line number'), null);
  assert.equal(sourceLine('src/a.ts:12: '), null, 'an empty body stays plain');
});

test('user, tool, result and status lines each get their own style', () => {
  const c = new TranscriptColorizer();
  assert.match(c.line('▶ You: 依頼', dark), /\x1b\[1m/);
  assert.match(c.line('▶ read_file (略)', light), /\x1b\[38;5;26m/);
  assert.match(c.line('  (結果: ok) README.md を読んだ', dark), /\x1b\[9\d?m|90/);
  assert.match(c.line('## 見出し', light), /\x1b\[1m/);
});

test('shell cards keep literal output readable on dark and light backgrounds', () => {
  for (const palette of [dark, light]) {
    const c = new TranscriptColorizer();
    assert.equal(c.line('╭ テスト', palette), `\x1b[${palette.tool}m╭ テスト\x1b[0m`);
    assert.equal(c.line('│ ```', palette), `\x1b[${palette.reasoning}m│\x1b[0m \`\`\``);
    assert.equal(c.state().mode, 'text');
    assert.equal(c.line('╰ 失敗 · exit 1', palette), `\x1b[${palette.result}m╰ 失敗 · exit 1\x1b[0m`);
  }
});
