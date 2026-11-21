import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createScreenReplay } from './tui.screen.ts';

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

test('public CLI terminal path: logo → completion → model providers → connect → response → Stop → child progress → recover → exit', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-tui-entry-'));
  const fixtureLsp = new URL('./fixtures/fake-lsp.mjs', import.meta.url).pathname;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    language: { autoInstall: false, servers: { typescript: { command: process.execPath, args: [fixtureLsp, 'clean'] } } },
  }));
  fs.writeFileSync(path.join(home, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(home, 'app.ts'), 'const value = 1;\n');
  fs.mkdirSync(path.join(home, 'test'));
  fs.writeFileSync(path.join(home, 'test', 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(home, 'test', 'app.test.ts'), 'const value = 2;\n');
  // A browse executable that stays in flight long enough for the pane to be observed.
  // It must live outside the workspace: a workspace-provided executable is not trusted.
  const browseBin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-tui-browse-'));
  fs.writeFileSync(path.join(browseBin, 'browse'), '#!/bin/sh\nsleep 0.6\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
  const requests: Record<string, unknown>[] = [];
  let releaseChild: (() => void) | undefined;
  const childRequests = new EventEmitter();
  // モデル一覧は固定せずプロバイダーから取得するため、テスト用サーバーが一覧も返す。
  const MODELS: Record<string, { data: { id: string }[] }> = {
    '/v1/models': { data: [{ id: 'llama3.2' }, { id: 'qwen3.8-max' }] },
    '/cloud/v1/models': { data: [{ id: 'gemma4:31b' }, { id: 'glm-5.3' }] },
  };
  const server = http.createServer((req, res) => {
    const catalog = MODELS[req.url ?? ''];
    if (catalog) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', ...catalog }));
      return;
    }
    let body = '';
    req.on('data', data => { body += data; });
    req.on('end', () => {
      const request = JSON.parse(body); requests.push(request);
      const cloud = request.model === 'gemma4:31b';
      assert.equal(req.url, cloud ? '/cloud/v1/chat/completions' : '/v1/chat/completions');
      assert.equal(req.headers.authorization, cloud ? 'Bearer tui-cloud-secret' : undefined);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const slow = request.messages.at(-1).content === 'slow';
      const send = (delta: Record<string, unknown>, finish: string | null) => res.write(`data: ${JSON.stringify({
        id: 'tui', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      const last = request.messages.at(-1);
      if (last.content === 'inspect-source' || last.content === 'inspect-test') {
        const source = last.content === 'inspect-source';
        send({ tool_calls: [{ index: 0, id: source ? 'read-source' : 'read-test', type: 'function', function: {
          name: 'read_file', arguments: JSON.stringify({ path: source ? 'app.ts' : 'test/app.test.ts' }),
        } }] }, null);
        send({}, 'tool_calls'); res.end('data: [DONE]\n\n');
        return;
      }
      if (last.tool_call_id === 'read-source' || last.tool_call_id === 'read-test') {
        const source = last.tool_call_id === 'read-source';
        assert.match(last.content, source ? /const value = 1/ : /const value = 2/);
        assert.match(last.content, /解析: ok typescript/);
        send({ role: 'assistant', content: source ? 'SOURCE_INSPECTED' : 'TEST_INSPECTED' }, null);
        send({}, 'stop'); res.end('data: [DONE]\n\n');
        return;
      }
      if (last.content === 'browse-check') {
        send({ tool_calls: [{ index: 0, id: 'browse-1', type: 'function', function: {
          name: 'browse', arguments: JSON.stringify({ action: 'navigate', url: 'https://example.com' }),
        } }] }, null);
        send({}, 'tool_calls'); res.end('data: [DONE]\n\n');
        return;
      }
      if (last.tool_call_id === 'browse-1') {
        send({ role: 'assistant', content: 'BROWSE_DONE' }, null);
        send({}, 'stop'); res.end('data: [DONE]\n\n');
        return;
      }
      if (last.content === 'delegate' || last.content === 'delegate-stop') {
        send({ role: 'assistant', tool_calls: [{
          index: 0, id: last.content, type: 'function', function: {
            name: 'run_subagent', arguments: JSON.stringify({ pluginId: 'modkh-explorer', task: `inspect fixture for ${last.content}` }),
          },
        }] }, null);
        send({}, 'tool_calls'); res.end('data: [DONE]\n\n');
        return;
      }
      if (last.content === 'inspect fixture for delegate' || last.content === 'inspect fixture for delegate-stop') {
        releaseChild = () => {
          send({ role: 'assistant', content: 'CHILD_RESULT' }, null);
          send({}, 'stop'); res.end('data: [DONE]\n\n');
        };
        res.flushHeaders();
        childRequests.emit('started');
        return;
      }
      if (last.role === 'tool' || last.content === '追加の依頼') {
        const receipt = request.messages.at(-2);
        assert.equal(last.content, '追加の依頼');
        assert.equal(receipt.role, 'tool');
        assert.match(receipt.content, /CHILD_RESULT/);
        send({ role: 'assistant', content: 'DELEGATION_RECOVERED' }, null);
        send({}, 'stop'); res.end('data: [DONE]\n\n');
        return;
      }
      send({ role: 'assistant', content: slow ? 'WAITING_FOR_STOP' : `TUI_RESPONSE_OK:${request.messages.at(-1).content}` }, null);
      if (!slow) { send({}, 'stop'); res.end('data: [DONE]\n\n'); }
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entry], {
    cwd: home,
    env: { ...process.env, NO_COLOR: undefined, MODKH_NO_ANIMATION: '0', MODKH_HOME: home, MODKH_PLAIN: '0', TERM: 'xterm-256color',
      PATH: `${browseBin}${path.delimiter}${process.env.PATH ?? ''}`,
      OLLAMA_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      OLLAMA_CLOUD_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/cloud/v1`, OLLAMA_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', error = '';
  const replay = createScreenReplay(32);
  let pending = '', screen = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    output += data;
    pending += data;
    // Each render ends by showing or hiding the cursor. Keep partial frames for the next read.
    const end = Math.max(pending.lastIndexOf('\x1b[?25h'), pending.lastIndexOf('\x1b[?25l'));
    if (end < 0) return;
    const boundary = end + '\x1b[?25h'.length;
    screen = replay(pending.slice(0, boundary)).join('\n');
    pending = pending.slice(boundary);
  });
  child.stderr.on('data', data => { error += data; });
  let start = 0;
  const send = (text: string) => { start = output.length; child.stdin.write(text); };
  // Match the latest screen, replaying the streamed absolute-position frames (test/tui.screen.ts).
  const visible = () => screen;
  const wait = async (text: string | RegExp | ((screen: string) => boolean)): Promise<void> => {
    const matches = () => {
      const screen = visible();
      return typeof text === 'function' ? text(screen) : typeof text === 'string' ? screen.includes(text) : text.test(screen);
    };
    if (matches()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); child.stdout.removeListener('data', check); child.removeListener('exit', exited);
        error ? reject(error) : resolve();
      };
      const check = () => { if (matches()) finish(); };
      const exited = () => finish(new Error(`CLI exited: ${error} ${output.slice(-3000)}`));
      const timer = setTimeout(() => finish(new Error(`Missing ${text}: ${error} ${output.slice(-4000)}`)), 5000);
      child.stdout.on('data', check); child.once('exit', exited);
    });
  };
  try {
    await wait('何を調べますか'); assert.match(output, /██████/); assert.match(output, /MoDKH  ·  Coding Harness/);
    send('/conn'); await wait('Commands');
    send('\r'); await wait('Hermes Agent');
    for (const label of ['OpenAI', 'OpenCode Zen', 'OpenCode Go', 'Ollama Local', 'Ollama Cloud', 'OpenRouter', 'Infron', 'Hermes Agent']) assert.ok(output.slice(start).includes(label), label);
    send('oll'); await wait('│ oll');
    send('\r'); await wait('ollama — モデルを選択');
    await wait('ollama/llama3.2');
    // The keyword-search row is pinned first, so Down selects the first model.
    send('\x1b[B'); await wait('› ollama/llama3.2');
    send('\r'); await wait('接続しました: ollama/llama3.2');
    send('こんにちは\r'); await wait('TUI_RESPONSE_OK:こんにちは'); await wait('何を調べますか');
    assert.match(visible(), /│ サブエージェント 0稼働 \/ 累計0/);
    assert.match(visible(), /│ 言語サーバー 0稼働/);
    send('inspect-source\r');
    await wait('SOURCE_INSPECTED');
    await wait('何を調べますか');
    assert.doesNotMatch(visible(), /const value = 1/, 'source bodies stay out of the default transcript');
    assert.match(visible(), /\/tools 1/, 'the compact result offers a concrete details command');
    assert.doesNotMatch(visible(), /今回のツール実行:/);
    send('/tools 1\r');
    await wait('const value = 1');
    await wait('何を調べますか');
    send('inspect-test\r');
    await wait('TEST_INSPECTED');
    await wait('詳細: /tools 2');
    assert.doesNotMatch(visible(), /今回のツール実行:/);
    await wait(/│ 言語サーバー 1稼働 +│\n.*│ typescript · .*tui-entry-[^ │]+ +│/);
    await wait('何を調べますか');
    send('browse-check\r');
    // 実行中だけ出る。完了後は消える(接続状態ではなく実行状態を表す)。
    await wait(/│ browse in use +│/);
    await wait('BROWSE_DONE');
    await wait('何を調べますか');
    assert.doesNotMatch(visible(), /browse in use/);
    const whaleRow = (screen: string) => screen.split('\n').find(row => /[🐋🐳]/u.test(row)) ?? '';
    const beforeAnimationCommands = requests.length;
    send('/ann'); await wait('/annimation');
    send('\t off\r'); await wait('待機アニメーション: off');
    send('/annimation invalid\r'); await wait('使い方: /annimation on|off');
    assert.equal(requests.length, beforeAnimationCommands, 'animation commands stay local');
    send('slow\r'); await wait('WAITING_FOR_STOP');
    assert.doesNotMatch(visible(), /今回のツール実行:/);
    assert.equal(whaleRow(visible()), '');
    send('\x03'); await wait('何を調べますか');
    send('/annimation on\r'); await wait('待機アニメーション: on');
    send('slow\r'); await wait('WAITING_FOR_STOP');
    await wait(/[🐋🐳]/u);
    const firstFrame = whaleRow(visible());
    const firstColumn = firstFrame.search(/[🐋🐳]/u);
    assert.match(firstFrame, /[~∿]/u, 'waves share the whale row');
    assert.ok(firstColumn > 40, 'animation stays in the right sidebar, away from the composer');
    assert.doesNotMatch(visible(), /│.*[▀▄]/);
    await wait(screen => {
      const column = whaleRow(screen).search(/[🐋🐳]/u);
      return column >= 0 && column !== firstColumn;
    });
    assert.doesNotMatch(visible(), /│ モデル応答を受信中… Ctrl\+Cで中止/);
    send('\x03'); await wait('中断しました');
    await wait('何を調べますか');
    assert.equal(whaleRow(visible()), '');
    send('delegate\r');
    await wait('│ サブエージェント 1稼働 / 累計1');
    await wait(/│ モデル応答を待機中 · [1-9]\d*秒 +│/);
    assert.doesNotMatch(visible(), /ツール要求を受信中/);
    assert.match(visible(), /│ inspect fixture for delegate +│/);
    // Rendering the wait phase can precede arrival of the child request at the fixture.
    if (!releaseChild) await once(childRequests, 'started', { signal: AbortSignal.timeout(5000) });
    const beforeFollowup = requests.length;
    send('追加の依頼\r');
    await wait('追加の依頼を受け付けました');
    assert.equal(requests.length, beforeFollowup, 'the current child request is still in flight');
    assert.ok(releaseChild);
    releaseChild();
    await wait('DELEGATION_RECOVERED');
    await wait('何を調べますか');
    assert.match(visible(), /│ サブエージェント 0稼働 \/ 累計1/);
    send('delegate-stop\r');
    await wait(/│ モデル応答を待機中 · [1-9]\d*秒 +│/);
    send('保留の依頼\r');
    await wait('追加の依頼を受け付けました');
    send('\x03');
    await wait('中断しました');
    await wait(screen => screen.includes('│ 保留の依頼') && screen.includes('Enter 送信  Ctrl+J 改行'));
    send('\x15'); await wait('何を調べますか');
    assert.match(visible(), /│ サブエージェント 0稼働 \/ 累計2/);
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
    assert.equal(sessions.length, 3);
    const journal = sessions.map(file => fs.readFileSync(path.join(home, 'sessions', file), 'utf8')).find(text => text.includes('cloud hello'))!;
    const messages = journal.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'message');
    assert.deepEqual(messages.filter(row => row.message.role === 'user').map(row => row.message.content),
      ['こんにちは', 'inspect-source', 'inspect-test', 'browse-check', 'slow', 'slow', 'delegate', '追加の依頼', 'delegate-stop', 'cloud hello', 'local again']);
    assert.equal(requests.length, 16);
    assert.doesNotMatch(output + journal, /tui-cloud-secret/);
    assert.doesNotMatch(journal, /\/connect/);
  } finally {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
    await closed;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(browseBin, { recursive: true, force: true });
  }
});
