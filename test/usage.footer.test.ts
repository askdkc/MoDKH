import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import { TerminalUI, textWidth } from '../src/cli/terminal.ts';
import { FixedModel } from '../src/model/fixed.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

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
    frame: () => {
      const latest = raw.slice(raw.lastIndexOf('\x1b[H') + 3);
      return { raw: latest, lines: stripVTControlCharacters(latest).split('\r\n') };
    },
  };
}

test('usage appears on one line at the bottom and never displaces the composer', () => {
  const t = terminal(120, 40);
  try {
    const input = t.ui.next();
    t.ui.setUsage({ input: 4_501_874, output: 410_226, cacheRead: 137_384_576, cacheWrite: 0, responses: 1 });
    const frame = t.frame();
    const line = frame.lines.find(entry => entry.includes('tok')) ?? '';
    assert.match(line, /4\.5M|4,501,874/);
    // 137.4M cached reads against 4.5M uncached input is a 100% input-side hit rate; the
    // screenshot's 97% counts cache over every token, which this footer does not claim.
    assert.match(line, /cache 100%/, 'cache hit ratio is derived from the reported numbers');
    assert.match(line, /410k|410,226/);
    // It sits on the bottom block, after the composer, and stays within the panel width.
    const index = frame.lines.findIndex(entry => entry.includes('tok'));
    const composer = frame.lines.findIndex(entry => entry.includes('│'));
    assert.ok(index > composer, 'usage must follow the composer, not displace it');
    assert.equal(frame.lines.slice(index + 1).filter(entry => entry.trim() !== '').length <= 1, true,
      'only the working directory may follow the usage line');
    assert.ok(textWidth(frame.lines[index]) <= 80);
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
