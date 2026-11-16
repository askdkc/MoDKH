import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate, setTimeout } from 'node:timers/promises';
import type { ReadStream, WriteStream } from 'node:tty';
import { pathToFileURL } from 'node:url';
import { screenFrom } from './tui.screen.ts';

const entry = process.env.MODKH_TEST_TERMINAL ? pathToFileURL(process.env.MODKH_TEST_TERMINAL).href : new URL('../src/cli/terminal.ts', import.meta.url).href;
const { TerminalUI } = await import(entry);

test('releasing a drag copies the selected transcript without wrapping, sidebar or padding', async () => {
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = 100;
  output.rows = 30;
  let screen = '';
  output.on('data', chunk => { screen += chunk.toString(); });
  const copies: string[] = [];
  const ui = new TerminalUI('/workspace', input, output, {
    writeClipboardText: async (text: string) => { copies.push(text); },
  });
  try {
    const prompt = ui.next(AbortSignal.timeout(5000));
    ui.write('▶ You: はじめ\n', 'user');
    const answer = '日本語の長い行。'.repeat(10) + '\n\n    code()';
    ui.write(answer + '\n', 'answer');
    const rows = screenFrom(screen, output.rows);
    const first = rows.findIndex(row => row.startsWith('日本語')) + 1;
    const last = rows.findIndex(row => row.startsWith('    code()')) + 1;
    assert.ok(first > 0 && last > first + 2);
    input.write(`\x1b[<0;1;${first}M\x1b[<32;90;${last}M`);
    assert.deepEqual(copies, [], 'mouse motion does not write to the clipboard');
    ui.write('New text streamed during the drag.\n', 'answer');
    input.write('\x1b[<0;90;');
    input.write(`${last}m`);
    await setImmediate();
    assert.deepEqual(copies, [answer]);
    assert.match(screen, /New text streamed during the drag/);
    input.write('続き\r');
    assert.equal(await prompt, '続き');
  } finally {
    ui.close();
  }
  assert.match(screen, /\x1b\[\?1002h/);
  assert.match(screen, /\x1b\[\?1002l/);
});

test('wheel history keeps TUI styling, supports reverse drag and restores the draft on Escape', async t => {
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  t.after(() => {
    if (previousNoColor !== undefined) process.env.NO_COLOR = previousNoColor;
  });
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = 90;
  output.rows = 20;
  let screen = '';
  output.on('data', chunk => { screen += chunk.toString(); });
  const copies: string[] = [];
  const ui = new TerminalUI('/workspace', input, output, {
    writeClipboardText: async (text: string) => { copies.push(text); },
  });
  try {
    const prompt = ui.next(AbortSignal.timeout(5000));
    ui.write('▶ You: start\n', 'user');
    ui.write('▶ run_command\n');
    for (let i = 0; i < 35; i++) ui.write(`記録 ${i}\n`, 'answer');
    input.write('draft');
    input.write('\x1b[<64;2;5M'.repeat(20));
    const history = screen.slice(screen.lastIndexOf('\x1b[H\x1b[J'));
    assert.match(history, /\x1b\[[0-9;]+m▶ run_command\x1b\[0m/);
    assert.match(history, /トークン使用量/);
    assert.match(history, /MoDKH.*会話履歴/);
    const first = screenFrom(history, output.rows).findIndex(line => line.startsWith('記録 0')) + 1;
    assert.ok(first > 0);
    input.write(`\x1b[<0;1;${first}M\x1b[<0;1;${first}m`);
    await setImmediate();
    assert.deepEqual(copies, [], 'a click does not change the clipboard');
    input.write('\x1b');
    input.write(`[<0;4;${first}M\x1b[<32;2;${first}M\x1b[<0;2;${first}m`);
    await setImmediate();
    assert.deepEqual(copies, ['記録']);
    output.columns = 12;
    output.emit('resize');
    const resized = screen.slice(screen.lastIndexOf('\x1b[H\x1b[J'));
    assert.match(resized, /\x1b\[[0-9;]+m▶ \x1b\[0m/);
    assert.match(resized, /\x1b\[[0-9;]+mrun_command\x1b\[0m/);
    assert.doesNotMatch(resized, /トークン使用量/);
    input.write('\x1b');
    await setTimeout(600);
    input.write('\r');
    assert.equal(await prompt, 'draft');
    assert.match(screen, /\x1b\[\?1049l/);
  } finally {
    ui.close();
  }
});
