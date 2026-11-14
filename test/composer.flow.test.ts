import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { screenFrom } from './tui.screen.ts';

// Run the same public chat/terminal adapters against source and the installed package.
const { runChat } = await import(process.env.DKH_TEST_CHAT ?? new URL('../src/cli/chat.ts', import.meta.url).href);
const terminalEntry = process.env.DKH_TEST_TERMINAL ? pathToFileURL(process.env.DKH_TEST_TERMINAL).href : new URL('../src/cli/terminal.ts', import.meta.url).href;
const { TerminalUI } = await import(terminalEntry);
const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==' };

for (const rejected of [false, false] as const) {
  test(`clipboard image and multiline text reach the real chat API and journal (${rejected ? 'provider rejects images' : 'success'})`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-composer-flow-'));
    const previousHome = process.env.DKH_HOME;
    process.env.DKH_HOME = home;
    const requests: { messages: { role: string; content: unknown }[] }[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', data => { raw += data; });
      req.on('end', () => {
        requests.push(JSON.parse(raw));
        if (rejected) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'IMAGE_UNSUPPORTED' } })); return; }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'IMAGE_ACCEPTED' }, null], [{}, 'stop']]) {
          res.write(`data: ${JSON.stringify({ id: 'image', object: 'chat.completion.chunk', created: 1, model: 'vision', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
      });
    });
    const input = new PassThrough() as unknown as ReadStream;
    input.isRaw = false; input.setRawMode = value => { input.isRaw = value; return input; };
    const output = new PassThrough() as unknown as WriteStream;
    output.columns = 100; output.rows = 40;
    let screen = '';
    output.on('data', data => { screen += data.toString(); });
    const ui = new TerminalUI(home, input, output, { readClipboardImage: async () => image });
    let chat: Promise<void> | undefined;
    const waitFor = (text: string): Promise<void> => new Promise((resolve, reject) => {
      const visible = () => screenFrom(screen, 40).join('\n');
      if (visible().includes(text)) { resolve(); return; }
      const timer = setTimeout(() => { output.removeListener('data', check); reject(new Error(`Missing ${text}: ${(import.meta as { url?: string }).url} screen=${screen.slice(-5000)}`)); }, 5000);
      const check = () => { if (visible().includes(text)) { clearTimeout(timer); output.removeListener('data', check); resolve(); } };
      output.on('data', check);
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      chat = runChat({ args: { cwd: home }, terminal: ui });
      await waitFor('何を調べますか');
      input.write('\x16'); // Physical Ctrl+V arrives as this byte in raw mode.
      await waitFor('画像1枚');
      input.emit('keypress', '', { name: 'return' }); // No model: do not lose the image.
      await waitFor('モデル未接続');
      assert.equal(ui.imageCount, 1);
      input.emit('keypress', `/connect compatible/vision --base-url ${base}`, {});
      input.emit('keypress', '', { name: 'return' });
      await waitFor('接続しました: compatible/vision');
      await waitFor('何を調べますか');
      assert.equal(ui.imageCount, 1);
      const prompt = rejected ? '' : 'この画像を説明して\n/exit はコード例です';
      if (prompt) input.write(`\x1b[200~${prompt}\x1b[201~`);
      input.emit('keypress', '', { name: 'return' });
      await waitFor(rejected ? 'IMAGE_UNSUPPORTED' : 'IMAGE_ACCEPTED');
      await waitFor('何を調べますか');
      assert.equal(ui.imageCount, 0);
      input.emit('keypress', '/exit', {}); input.emit('keypress', '', { name: 'return' });
      await chat;
      assert.equal(requests.length, 1, 'never silently retry without the image');
      assert.deepEqual(requests[0].messages.find(m => m.role === 'user')?.content, [
        ...(prompt ? [{ type: 'text', text: prompt }] : []),
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } },
      ]);
      const files = fs.readdirSync(path.join(home, 'sessions'));
      const events = fs.readFileSync(path.join(home, 'sessions', files[0]), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const users = events.filter(e => e.message?.role === 'user');
      assert.equal(users.length, 1);
      assert.deepEqual(users[0].message.images, [image]);
      assert.equal(users[0].message.content, prompt);
      assert.ok(events.some(e => e.type === 'status' && e.status === (rejected ? 'error' : 'complete')));
      assert.equal(screen.includes(image.data), false, 'never print image bytes into terminal history');
    } finally {
      ui.close(); await chat?.catch(() => {});
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousHome === undefined) delete process.env.DKH_HOME; else process.env.DKH_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
