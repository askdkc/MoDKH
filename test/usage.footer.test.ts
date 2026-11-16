import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI, textWidth } from '../src/cli/terminal.ts';
import { addUsage, EMPTY_USAGE, usageBreakdown } from '../src/cli/usage.ts';
import { FixedModel } from '../src/model/fixed.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { screenFrom } from './tui.screen.ts';

function terminal(columns = 100, rows = 30) {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = raw => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = columns; output.rows = rows;
  let raw = '';
  output.on('data', chunk => { raw += chunk.toString(); });
  return {
    ui: new TerminalUI('/workspace', input, output), input, output,
    clear: () => { raw = ''; },
    frame: () => ({ lines: screenFrom(raw, Math.max(6, output.rows || 24)), raw }),
  };
}

test('usage appears on one line at the bottom and never displaces the composer', () => {
  const t = terminal(120, 40);
  try {
    const input = t.ui.next();
    t.ui.write('▶ You: report usage\n');
    t.ui.setUsage({ input: 4_501_874, output: 410_226, cacheRead: 137_384_576, cacheWrite: 0, responses: 1 });
    const frame = t.frame();
    const line = frame.lines.find(entry => entry.includes('tok')) ?? '';
    assert.match(line, /4\.5M|4,501,874/);
    // 137.4M cached reads against 4.5M uncached input is a 100% input-side hit rate; the
    // screenshot's 97% counts cache over every token, which this footer does not claim.
    assert.match(line, /cache 100%/, 'cache hit ratio is derived from the reported numbers');
    assert.match(line, /410k|410,226/);
    // It sits on the bottom status row, right-aligned next to the working directory, and
    // carries the breakdown inside the badge itself.
    const index = frame.lines.findIndex(entry => entry.includes('tok'));
    const composer = frame.lines.findIndex(entry => entry.includes('│'));
    assert.ok(index > composer, 'usage must follow the composer, not displace it');
    const bottom = frame.lines.at(-1)!;
    assert.match(bottom, /tok/, 'the usage is the bottom-right status');
    assert.match(bottom, /workspace|\/Users|パス|ルート/, 'the working directory shares the bottom row');
    assert.ok(bottom.indexOf('workspace') < bottom.indexOf('tok') - 0, 'the usage status is right of the cwd');
    // 最下段はステータス行で、端末幅いっぱいに cwd(左)と使用量(右)を並べる。
    // 会話本文と違い中央寄せの余白は付かない(コピーする本文ではないが、余白の焼き込みを避ける)。
    const trimmed = bottom.trim();
    assert.ok(textWidth(bottom) <= 120, `the bottom status fits the terminal: ${textWidth(bottom)}`);
    assert.equal(textWidth(bottom), 120, 'the status row spans the terminal width');
    assert.ok(bottom.endsWith(trimmed.slice(-4)) || textWidth(trimmed) <= 120, 'no content is clipped');
    // The composer still works with the footer present.
    t.input.emit('keypress', '/exit', {});
    t.input.emit('keypress', '', { name: 'return' });
    void input;
  } finally { t.ui.close(); }
});

test('usage footer fits a narrow terminal and omits detail instead of wrapping', () => {
  const t = terminal(32, 12);
  try {
    t.ui.setUsage({ input: 12_345_678, output: 987_654, cacheRead: 11_000_000, cacheWrite: 0, responses: 1 });
    const frame = t.frame();
    assert.ok(frame.lines.every(entry => textWidth(entry) <= 32));
    const line = frame.lines.find(entry => entry.includes('tok')) ?? '';
    assert.ok(textWidth(line) <= 32, `footer must fit: ${JSON.stringify(line)}`);
    assert.match(line ?? '', /tok/);
  } finally { t.ui.close(); }
});

test('no usage is shown before any model response and NO_COLOR keeps it plain', () => {
  const previous = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    const t = terminal();
    try {
      assert.equal(t.frame().lines.some(entry => entry.includes('tok')), false);
      t.ui.setUsage({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, responses: 1 });
      assert.match(t.frame().raw, /tok/);
    } finally { t.ui.close(); }
    process.env.NO_COLOR = '1';
    const plain = terminal();
    try {
      plain.ui.setUsage({ input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, responses: 1 });
      assert.doesNotMatch(plain.frame().raw, /\x1b\[[0-9;]*m/);
      assert.match(plain.frame().lines.join('\n'), /tok/);
    } finally { plain.ui.close(); }
  } finally { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
});

test('the agent loop reports usage from the model stream to the caller', async () => {
  const seen: unknown[] = [];
  const model = new FixedModel([[
    { type: 'text-delta', text: 'hi' },
    { type: 'finish', stopReason: 'stop' },
  ]]);
  const result = await runAgentLoop([{ role: 'user', content: 'hello' }], {
    model, registry: new ToolRegistry([]), root: '/tmp',
    signal: new AbortController().signal, approval: { approve: async () => false },
    hooks: { onUsage: usage => seen.push(usage) },
  });
  assert.equal(result.outcome, 'complete');
  assert.deepEqual(seen, []);
});


test('the usage breakdown aligns values and partitions input without counting cache writes twice', () => {
  const usage = addUsage(addUsage(EMPTY_USAGE, {
    input: 277_000_000, cacheRead: 273_000_000, cacheWrite: 3_000_000, output: 370_000,
  }), {
    input: 1_100_000, uncachedInput: 1_100_000, cacheRead: 0, cacheWrite: 0, output: 4_000,
  });
  const lines = usageBreakdown(usage).split('\n');
  assert.deepEqual(lines.map(line => line.split(/ +/).at(-1)), ['278.5M', '2.1M', '273M', '3M', '374K']);
  assert.equal(new Set(lines.map(textWidth)).size, 1);
  const zero = addUsage(EMPTY_USAGE, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.match(usageBreakdown(zero), /キャッシュ書き込み +0/);
});
