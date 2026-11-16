import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { screenFrom } from './tui.screen.ts';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

/** Drive the real CLI in TUI mode and report the widest visible line per phase. */
function fixture(columns: number, rows: number) {
  const preload = `
    process.stdin.isTTY = true;
    process.stdin.isRaw = false;
    process.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };
    process.stdout.isTTY = true;
    process.stdout.columns = ${columns};
    process.stdout.rows = ${rows};
  `;
  return preload;
}

test('a real TUI switches from welcome to a split conversation and shows provider reasoning', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-width-'));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null) => res.write(`data: ${JSON.stringify({
        id: 'w', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      // A provider reasoning delta followed by an answer, so both paths are exercised.
      chunk({ role: 'assistant', reasoning_content: 'REASONING_VISIBLE_MARKER を確認します。' }, null);
      chunk({ content: 'ANSWER_MARKER こんにちは。\n\nQUESTION_MARKER 何をお手伝いしましょうか？' }, null);
      chunk({}, 'stop');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(fixture(200, 40))}`, entry], {
      cwd: home,
      env: { ...process.env, NO_COLOR: undefined, MODKH_HOME: home, MODKH_PLAIN: '0', TERM: 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout!.on('data', data => { output += data; });
    // ウェルカムは端末中央寄せ(余白込みで広がらない)。本文幅を測るため余白を除く。
    const widest = (): number => {
      const lines = screenFrom(output, 40);
      return Math.max(...lines.map(line => [...line.trim()].length));
    };
    const wait = async (text: string): Promise<void> => {
      const deadline = Date.now() + 8000;
      while (!stripVTControlCharacters(output).includes(text)) {
        if (Date.now() > deadline) throw new Error(`missing ${text}: ${output.slice(-1500)}`);
        await new Promise<void>(r => setTimeout(r, 25));
      }
    };
    await wait('何を調べますか');
    assert.match(output, /\x1b\[48;5;\d+;1;39m 何を調べますか/);
    assert.doesNotMatch(stripVTControlCharacters(output), /│ トークン使用量/);
    const welcomeWidth = widest();
    assert.ok(welcomeWidth <= 80, `welcome stays compact: ${welcomeWidth}`);

    child.stdin!.write(`/connect compatible/x --base-url http://127.0.0.1:${(server.address() as AddressInfo).port}/v1\r`);
    await wait('接続しました');
    assert.doesNotMatch(stripVTControlCharacters(output), /│ トークン使用量/);
    child.stdin!.write('調べて\r');
    await wait('│ トークン使用量');
    await wait('ANSWER_MARKER');
    await wait('応答終了');
    const conversation = screenFrom(output, 40);
    assert.match(conversation[1], /│ トークン使用量/);
    assert.doesNotMatch(conversation.join('\n'), /██████╗/);
    assert.match(stripVTControlCharacters(output), /REASONING_VISIBLE_MARKER/, 'reasoning is displayed');
    assert.match(stripVTControlCharacters(output), /\(推論\)/, 'reasoning is labelled');
    assert.match(output, /\x1b\[90mREASONING_VISIBLE_MARKER/);
    assert.match(output, /\x1b\[1;39mANSWER_MARKER/);
    assert.match(output, /\x1b\[1;39mQUESTION_MARKER/);
    assert.doesNotMatch(output, /\x1b\[90m(?:ANSWER|QUESTION)_MARKER/);

    child.stdin!.write('/exit\r');
    await once(child, 'close');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); }
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
