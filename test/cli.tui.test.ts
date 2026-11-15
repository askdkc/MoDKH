import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { screenFrom } from './tui.screen.ts';

// Stream-level terminal integration, not a substitute for the real PTY acceptance script.
const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
const preload = `
  process.stdin.isTTY = true;
  process.stdin.isRaw = false;
  process.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };
  process.stdout.isTTY = true;
  process.stdout.columns = 110;
  process.stdout.rows = 32;
  process.on('exit', () => { if (process.stdin.isRaw) process.exitCode = 91; });
`;

test('public CLI terminal path: logo → completion → seven providers → connect → response → Stop → recover → exit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-tui-entry-'));
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      const request = JSON.parse(body); requests.push(request);
      const cloud = request.model === 'gemma4:31b';
      assert.equal(req.url, cloud ? '/cloud/v1/chat/completions' : '/v1/chat/completions');
      assert.equal(req.headers.authorization, cloud ? 'Bearer tui-cloud-secret' : undefined);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const slow = request.messages.at(-1).content === 'slow';
      const send = (delta: Record<string, string>, finish: string | null) => res.write(`data: ${JSON.stringify({
        id: 'tui', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      send({ role: 'assistant', content: slow ? 'WAITING_FOR_STOP' : `TUI_RESPONSE_OK:${request.messages.at(-1).content}` }, null);
      if (!slow) { send({}, 'stop'); res.end('data: [DONE]\n\n'); }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entry], {
    cwd: home,
    env: { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '0', TERM: 'xterm-256color',
      OLLAMA_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      OLLAMA_CLOUD_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cloud/v1`, OLLAMA_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', error = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { error += data; });
  let start = 0;
  const send = (text: string) => { start = output.length; child.stdin.write(text); };
  // Match the latest screen, replaying the streamed absolute-position frames (test/tui.screen.ts).
  const visible = () => screenFrom(output, 32).join('\n');
  const wait = async (text: string): Promise<void> => {
    if (visible().includes(text)) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); child.stdout.removeListener('data', check); child.removeListener('exit', exited);
        error ? reject(error) : resolve();
      };
      const check = () => { if (visible().includes(text)) finish(); };
      const exited = () => finish(new Error(`CLI exited: ${error} ${output.slice(-3000)}`));
      const timer = setTimeout(() => finish(new Error(`Missing ${text}: ${error} ${output.slice(-4000)}`)), 5000);
      child.stdout.on('data', check); child.once('exit', exited);
    });
  };
  try {
    await wait('何を調べますか'); assert.match(output, /██████/); assert.match(output, /MODKH/);
    send('/conn'); await wait('Commands');
    send('\r'); await wait('Hermes Agent');
    for (const label of ['OpenAI', 'OpenCode', 'Ollama Local', 'Ollama Cloud', 'OpenRouter', 'Infron', 'Hermes Agent']) assert.ok(output.slice(start).includes(label), label);
    send('oll'); await wait('│ oll');
    send('\r'); await wait('ollama/llama3.2');
    // The keyword-search row is pinned first, so Down selects the first model.
    send('\x1b[B'); await wait('› ollama/llama3.2');
    send('\r'); await wait('接続しました: ollama/llama3.2');
    send('こんにちは\r'); await wait('TUI_RESPONSE_OK:こんにちは'); await wait('何を調べますか');
    send('slow\r'); await wait('WAITING_FOR_STOP');
    send('\x03'); await wait('中断しました');
    send('/connect\r'); await wait('Hermes Agent');
    send('cloud'); await wait('│ cloud');
    send('\r'); await wait('OLLAMA_API_KEY を入力');
    send('tui-cloud-secret\r'); await wait('ollama-cloud/gemma4:31b');
    send('\x1b[B'); await wait('› ollama-cloud/gemma4:31b');
    send('\r'); await wait('接続しました: ollama-cloud/gemma4:31b');
    send('cloud hello\r'); await wait('TUI_RESPONSE_OK:cloud hello'); await wait('何を調べますか');
    send('/connect ollama\r'); await wait('ollama — モデルを選択');
    send('\x1b[B'); await wait('› ollama/llama3.2');
    send('\r'); await wait('接続しました: ollama/llama3.2');
    send('local again\r'); await wait('TUI_RESPONSE_OK:local again'); await wait('何を調べますか');
    send('/connect\r'); await wait('Hermes Agent');
    send('\x1b'); await wait('何を調べますか');
    send('/exit\r');
    const [code] = await once(child, 'close');
    assert.equal(code, 0, error);
    assert.match(output, /\x1b\[\?2004l/);
    const sessions = fs.readdirSync(path.join(home, 'sessions'));
    assert.equal(sessions.length, 1);
    const journal = fs.readFileSync(path.join(home, 'sessions', sessions[0]), 'utf8');
    const messages = journal.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'message');
    assert.deepEqual(messages.filter(row => row.message.role === 'user').map(row => row.message.content),
      ['こんにちは', 'slow', 'cloud hello', 'local again']);
    assert.equal(requests.length, 4);
    assert.doesNotMatch(output + journal, /tui-cloud-secret/);
    assert.doesNotMatch(journal, /\/connect/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); }
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
