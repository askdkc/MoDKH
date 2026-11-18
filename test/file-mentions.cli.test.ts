import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI } from '../src/cli/terminal.ts';
import { runChat } from '../src/cli/chat.ts';
import { FixedModel } from '../src/model/fixed.ts';
import { screenFrom } from './tui.screen.ts';

test('the chat composer suggests workspace files, Tab fills the reference, and Enter sends its contents', { timeout: 10_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-file-mentions-'));
  const previousHome = process.env.MODKH_HOME;
  process.env.MODKH_HOME = home;
  fs.mkdirSync(path.join(home, 'src'));
  fs.writeFileSync(path.join(home, 'src', 'a.txt'), 'FIRST_FILE');
  fs.writeFileSync(path.join(home, 'src', 'notes 画面.md'), 'LOCAL_FILE_CONTENT');
  fs.symlinkSync(import.meta.filename, path.join(home, 'outside'));
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false; input.setRawMode = value => { input.isRaw = value; return input; };
  const output = new PassThrough() as unknown as WriteStream;
  output.columns = 100; output.rows = 40;
  let screen = '';
  output.on('data', data => { screen += data.toString(); });
  const visible = () => screenFrom(screen, 40).join('\n');
  const ui = new TerminalUI(home, input, output);
  const model = new FixedModel([[{ type: 'text-delta', text: 'ANSWER' }, { type: 'finish', stopReason: 'stop' }]]);
  const chat = runChat({ args: { cwd: home, model: 'fixed/scripted' }, terminal: ui, modelFactory: () => model });
  const key = (name: string) => input.emit('keypress', '', { name });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(visible(), /何を調べますか/);
    input.emit('keypress', '比較して @sr', {});
    assert.match(visible(), /› src\//);
    input.write('\t');
    assert.match(visible(), /│ 比較して @src\//);
    assert.match(visible(), /src\/a\.txt/);
    assert.match(visible(), /src\/notes 画面\.md/);
    key('down');
    input.write('\t');
    assert.match(visible(), /比較して @"src\/notes 画面\.md"/);
    assert.equal(model.requests.length, 0, 'Tab must not submit');
    input.emit('keypress', '@src/a.txt', {});
    key('return');
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        if (!visible().includes('ANSWER') || !visible().includes('何を調べますか')) return;
        clearTimeout(timer); output.off('data', done); resolve();
      };
      const timer = setTimeout(() => { output.off('data', done); reject(new Error(visible())); }, 3_000);
      output.on('data', done); done();
    });
    const sent = model.requests[0].messages.find(message => message.role === 'user')?.content;
    assert.match(sent ?? '', /比較して @"src\/notes 画面\.md" @src\/a\.txt/);
    assert.match(sent ?? '', /LOCAL_FILE_CONTENT/);
    assert.match(sent ?? '', /FIRST_FILE/);
    assert.doesNotMatch(screen, /LOCAL_FILE_CONTENT/);
    input.emit('keypress', '@outside', {});
    key('return');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.match(visible(), /ファイル添付失敗.*作業ルートの外/);
    assert.match(visible(), /│ @outside/);
    assert.equal(model.requests.length, 1, 'invalid references must not send the prompt');
    input.emit('keypress', '', { name: 'u', ctrl: true });
    input.emit('keypress', '/exit', {}); key('return');
    await chat;
  } finally {
    ui.close(); await chat.catch(() => {});
    if (previousHome === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
