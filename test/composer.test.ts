import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { stripVTControlCharacters } from 'node:util';
import { TerminalUI, textWidth } from '../src/cli/terminal.ts';

const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==' };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(readClipboardImage = async (_signal: AbortSignal) => image) {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = raw => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = 100; output.rows = 40;
  let raw = '';
  output.on('data', chunk => { raw += chunk.toString(); });
  const ui = new TerminalUI('/workspace', input, output, { readClipboardImage });
  const frame = () => {
    const latest = raw.slice(raw.lastIndexOf('\x1b[H') + 3);
    const cursor = /\x1b\[(\d+);(\d+)H/.exec(latest)!;
    return { lines: stripVTControlCharacters(latest).split('\r\n'), cursorRow: Number(cursor[1]), cursorCol: Number(cursor[2]) };
  };
  return { ui, input, output, frame, key: (name: string, value = '', ctrl = false) => input.emit('keypress', value, { name, ctrl }) };
}

test('composer starts with three input rows, grows in both directions, and wraps long text', async () => {
  const f = fixture();
  try {
    const input = f.ui.next();
    const initial = f.frame();
    const top = initial.lines.findIndex(s => s.includes('何を調べますか'));
    const status = initial.lines.findIndex(s => s.includes('│ DKH'));
    assert.equal(status - top, 3);
    f.input.emit('keypress', 'one\ntwo\nthree\nfour\nfive\nsix\nseven', {});
    const grown = f.frame();
    const grownTop = grown.lines.findIndex(s => s.includes('│ one'));
    const grownStatus = grown.lines.findIndex(s => s.includes('│ DKH'));
    assert.equal(grownStatus - grownTop, 7);
    assert.ok(grownTop < top, 'home input must expand upward too');
    assert.ok(grownStatus > status, 'home input must expand downward too');
    f.key('u', '', true);
    f.input.emit('keypress', '日'.repeat(100), {});
    assert.ok(f.frame().lines.filter(s => s.includes('│ 日')).length >= 3);
    f.key('return'); assert.equal(await input, '日'.repeat(100));
  } finally { f.ui.close(); }
});

test('bracketed text paste preserves newlines without sending, and Ctrl+J inserts a newline', async () => {
  const f = fixture();
  try {
    let sent = false;
    const input = f.ui.next().then(value => { sent = true; return value; });
    f.input.write('\x1b[200~alpha\r\nbeta\n/exit\x1b[201~');
    await tick();
    assert.equal(sent, false);
    f.input.write('\n'); // Ctrl+J arrives as LF from a real terminal, not a named j key.
    f.input.emit('keypress', 'last', {});
    f.key('return');
    assert.equal(await input, 'alpha\nbeta\n/exit\nlast');
  } finally { f.ui.close(); }
});

test('large drafts scroll inside the viewport and vertical movement keeps the cursor visible', async () => {
  const f = fixture();
  try {
    const input = f.ui.next();
    const text = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
    f.input.emit('keypress', text, {});
    f.output.columns = 24; f.output.rows = 12; f.output.emit('resize');
    const bottom = f.frame();
    assert.ok(bottom.lines.every(s => textWidth(s) <= 24));
    assert.match(bottom.lines[bottom.cursorRow - 1], /line-39/);
    f.key('up');
    const previous = f.frame();
    assert.match(previous.lines[previous.cursorRow - 1], /line-38/);
    f.key('return'); assert.equal(await input, text);
  } finally { f.ui.close(); }
});

test('Ctrl+V attaches an image, leaves text untouched, and Ctrl+X removes the last attachment', async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; return image; });
  try {
    const input = f.ui.next();
    f.input.emit('keypress', 'describe', {});
    f.key('v', '', true); await tick();
    assert.equal(reads, 1);
    assert.equal(f.ui.imageCount, 1);
    assert.match(f.frame().lines.join('\n'), /画像1/);
    f.key('x', '', true); assert.equal(f.ui.imageCount, 0);
    f.key('v', '', true); await tick();
    f.key('return'); assert.equal(await input, 'describe');
    assert.deepEqual(f.ui.takeImages(), [image]);
    assert.equal(f.ui.imageCount, 0);
  } finally { f.ui.close(); }
});

test('clipboard errors preserve the draft and a later paste can succeed', async () => {
  let calls = 0;
  const f = fixture(async () => { if (++calls === 1) throw new Error('画像がありません'); return image; });
  try {
    const input = f.ui.next();
    f.input.emit('keypress', 'keep draft', {});
    f.key('v', '', true); await tick();
    assert.match(f.frame().lines.join('\n'), /画像がありません/);
    assert.equal(f.ui.imageCount, 0);
    f.key('v', '', true); await tick();
    assert.equal(f.ui.imageCount, 1);
    f.key('return'); assert.equal(await input, 'keep draft');
  } finally { f.ui.close(); }
});

test('late clipboard results are discarded on cancel and secret prompts cannot read images', async () => {
  let resolve!: (value: typeof image) => void;
  let reads = 0;
  const f = fixture(() => { reads++; return new Promise(r => { resolve = r; }); });
  try {
    const input = f.ui.next();
    f.key('v', '', true);
    f.key('c', '', true);
    resolve(image); await tick();
    assert.equal(f.ui.imageCount, 0);
    await input;
    const secret = f.ui.ask('Password', undefined, true);
    f.key('v', '', true); await tick();
    assert.equal(reads, 1);
    f.key('return'); await secret;
  } finally { f.ui.close(); }
});

test('oversized text paste and the fifth image are rejected without losing the existing draft', async () => {
  const f = fixture();
  try {
    const input = f.ui.next();
    f.input.emit('keypress', 'keep', {});
    f.key('paste-start'); f.input.emit('keypress', 'x'.repeat(128 * 1024 + 1), {}); f.key('paste-end');
    assert.match(f.frame().lines.join('\n'), /128 KiB/);
    for (let i = 0; i < 4; i++) { f.key('v', '', true); await tick(); }
    assert.equal(f.ui.imageCount, 4);
    f.key('v', '', true); await tick();
    assert.equal(f.ui.imageCount, 4);
    assert.match(f.frame().lines.join('\n'), /最大4枚/);
    f.key('return'); assert.equal(await input, 'keep');
    assert.equal(f.ui.takeImages().length, 4);
  } finally { f.ui.close(); }
});
