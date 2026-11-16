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

test('usage stays on the right before a response, while editing, and beside child activity', async () => {
  const t = terminal(120, 40);
  try {
    const input = t.ui.next();
    const pane = () => t.frame().lines.filter(line =>
      /トークン消費量|未キャッシュ入力|キャッシュ読み取り|キャッシュ書き込み|│ 出力/.test(line));
    assert.equal(pane().length, 5);
    assert.match(pane()[0], /│ トークン消費量 +— +│/);
    t.ui.write('▶ You: report usage\n');
    t.ui.setUsage({ input: 278_100_000, uncachedInput: 5_100_000, output: 374_000, cacheRead: 273_000_000, cacheWrite: 0, responses: 1 });
    const ready = pane();
    assert.equal(ready.length, 5);
    for (const [line, value] of ready.map((line, i) => [line, ['278.5M', '5.1M', '273M', '0', '374K'][i]])) {
      assert.ok(textWidth(line.split('│').at(-2) ?? '') < 40, line);
      assert.match(line, new RegExp(` +${value.replace('.', '\\.')} +│$`));
      assert.equal(textWidth(line), 120);
    }
    t.input.emit('keypress', '下書き', {});
    t.input.emit('keypress', '', { name: 'return' });
    assert.equal(await input, '下書き');

    t.ui.setSubagent({ pluginId: 'modkh-explorer', task: '資料を確認', phase: 'モデル応答を待機中' });
    assert.match(t.frame().lines.join('\n'), /│ サブエージェント/);
    assert.equal(pane().length, 5);
    t.output.columns = 45;
    t.output.emit('resize');
    assert.equal(pane().length, 5);
    assert.ok(pane().every(line => textWidth(line) === 45));
    t.output.columns = 120;
    t.output.emit('resize');
    assert.equal(pane().length, 5);
    t.ui.setSubagent(null);
    assert.equal(pane().length, 5);
    assert.doesNotMatch(t.frame().lines.join('\n'), /│ サブエージェント/);
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

test('NO_COLOR keeps the persistent usage pane plain', () => {
  const previous = process.env.NO_COLOR;
  try {
    delete process.env.NO_COLOR;
    const t = terminal();
    try {
      assert.equal(t.frame().lines.some(entry => entry.includes('tok')), false);
      t.ui.setUsage({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, responses: 1 });
      assert.match(t.frame().raw, /トークン消費量/);
    } finally { t.ui.close(); }
    process.env.NO_COLOR = '1';
    const plain = terminal();
    try {
      plain.ui.setUsage({ input: 1000, output: 200, cacheRead: 500, cacheWrite: 0, responses: 1 });
      assert.doesNotMatch(plain.frame().raw, /\x1b\[[0-9;]*m/);
      assert.match(plain.frame().lines.join('\n'), /トークン消費量/);
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
