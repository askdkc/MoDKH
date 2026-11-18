import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const entry = process.env['MODKH_TEST_CHAT'] ?? new URL('../src/cli/chat.ts', import.meta.url).href;
async function chat(input: string, options = '{}', env: NodeJS.ProcessEnv = {}, setup = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-interactive-'));
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { runChat } from ${JSON.stringify(entry)}; ${setup}; await runChat({args: {}, ...${options}});`],
    { cwd: home, env: { ...process.env, MODKH_HOME: home, OPENAI_API_KEY: '', OLLAMA_API_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdin.end(input);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    clearTimeout(timer);
    assert.equal(code, 0, stderr || stdout);
    const sessions = fs.readdirSync(path.join(home, 'sessions'));
    return { stdout, session: fs.readFileSync(path.join(home, 'sessions', sessions[0]), 'utf8') };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('起動後 /models の大小文字を無視した検索→番号選択→接続状態', async () => {
  const { stdout, session } = await chat('/models ScRiPt\n1\n/connect\n\n/exit\n');
  assert.match(stdout, /1[.)] fixed\/scripted/);
  assert.match(stdout, /接続しました: fixed\/scripted/);
  assert.match(stdout, /接続中: fixed\/scripted/);
  assert.doesNotMatch(session, /"role":"user"/);
});

test('再検索・無効な番号・該当なし・キャンセルで会話へ戻れる', async () => {
  const { stdout } = await chat('/connect fixed/scripted\n/models\n9999\nno-such-model-xyz\nSCRIPT\n\n/connect\n\n/exit\n');
  assert.match(stdout, /番号が範囲外/);
  assert.match(stdout, /該当するモデルはありません/);
  assert.match(stdout, /接続中: fixed\/scripted/);
});

test('モデル一覧取得の失敗後も既存接続を保つ', async () => {
  const { stdout } = await chat('/connect fixed/scripted\n/models openai/gpt-5.2\n1\n/connect\n\n/exit\n');
  assert.match(stdout, /OPENAI_API_KEY/);
  assert.match(stdout, /接続中: fixed\/scripted/);
});

test('/connect lists every model provider and can return without sending a message', async () => {
  const { stdout, session } = await chat('/connect\n\n/exit\n');
  for (const provider of ['OpenAI', 'OpenCode Zen', 'OpenCode Go', 'Ollama Local', 'Ollama Cloud', 'OpenRouter', 'Infron', 'Hermes Agent']) assert.ok(stdout.includes(provider), provider);
  assert.doesNotMatch(session, /"role":"user"/);
});

test('未接続のまま送信すると警告だけでなく接続フローが開く', async () => {
  // 入力→Enter でモデル選択が開き、選択をやめると入力は送信待ちに戻る(失われない)。
  const { stdout, session } = await chat('hello\n/exit\n');
  assert.match(stdout, /モデル未接続: 接続先を選びます/);
  assert.match(stdout, /OpenAI/, 'the provider picker opens');
  assert.doesNotMatch(session, /"role":"user"/, 'the message is not sent to a model that does not exist');
});

// Ollama の一覧は固定値を持たないため、テストはローカルの偽エンドポイントで隔離する。
// 実プロバイダーの並び順に依存させると、モデル追加のたびにテストが壊れる。
async function ollamaFakeServer() {
  const server = http.createServer((req, res) => {
    const cloud = req.url?.startsWith('/cloud/');
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: cloud
        ? [{ id: 'gemma4:31b' }, { id: 'glm-5.3' }]
        : [{ id: 'llama3.2' }, { id: 'qwen3.8-max' }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    env: { OLLAMA_API_KEY: 'test-cloud-key', OLLAMA_BASE_URL: `${base}/v1`, OLLAMA_CLOUD_BASE_URL: `${base}/cloud/v1` },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('cloud and local pickers select separate models; cloud failure preserves the existing connection', async () => {
  const fake = await ollamaFakeServer();
  try {
    // Row 1 is the pinned keyword search, so the first model is row 2.
    const { stdout, session } = await chat('/connect\nollama-cloud\n2\n/connect\n\n/connect ollama\n2\n/connect\n\n/exit\n', '{}', fake.env);
    assert.match(stdout, /接続しました: ollama-cloud\/gemma4:31b/);
    assert.match(stdout, /接続しました: ollama\/llama3\.2/);
    assert.doesNotMatch(stdout + session, /test-cloud-key/);
  } finally { await fake.close(); }
  const missing = await chat('/connect fixed/scripted\n/connect ollama-cloud\n/connect\n\n/exit\n');
  assert.match(missing.stdout, /OLLAMA_API_KEY/);
  assert.match(missing.stdout, /接続中: fixed\/scripted/);
});

test('/models can search the cloud-only namespace', async () => {
  const fake = await ollamaFakeServer();
  try {
    // 検索語はプロバイダー名だけなので、候補は取得した一覧の順(検索行の次が1番)になる。
    const { stdout } = await chat('/models ollama-cloud\n1\n/exit\n', '{}', fake.env);
    assert.match(stdout, /1\. ollama-cloud\/gemma4:31b/);
    assert.doesNotMatch(stdout, /ollama\/llama3\.2/);
    assert.match(stdout, /接続しました: ollama-cloud\/gemma4:31b/);
  } finally { await fake.close(); }
});

test('/connect は認証先を案内し、キャンセルできる', async () => {
  const { stdout } = await chat('/connect\n\n/exit\n');
  assert.match(stdout, /chatgpt/);
  assert.match(stdout, /認証先/);
  assert.match(stdout, /終了しました/);
});

test('/connect chatgpt はログイン処理を通り、モデル選択に進む', async () => {
  let exchanges = 0;
  const issuer = http.createServer((req, res) => {
    assert.equal(req.url, '/oauth/token');
    exchanges++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'test-token' }));
  });
  await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer();
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const redirectPort = (reserve.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  try {
    const options = `{loginOptions: {config: {issuer: 'http://127.0.0.1:${(issuer.address() as AddressInfo).port}', clientId: 'test', redirectPort: ${redirectPort}}, openUrl: async (url) => { const u = new URL(url); const callback = new URL(u.searchParams.get('redirect_uri')); callback.searchParams.set('code', 'test-code'); callback.searchParams.set('state', u.searchParams.get('state')); await fetch(callback); }}}`;
    const setup = `const originalFetch = globalThis.fetch; globalThis.fetch = (url, options) => {
      if (String(url).startsWith('https://chatgpt.com/backend-api/codex/models?')) {
        if (new Headers(options?.headers).get('authorization') !== 'Bearer test-token') throw new Error('missing catalogue credentials');
        return Promise.resolve(Response.json({models: [{slug: 'gpt-6.1-sol', visibility: 'list'}]}));
      }
      return originalFetch(url, options);
    }`;
    const { stdout, session } = await chat('/connect chatgpt\n/models chatgpt/gpt-6.1-sol\n1\n/connect\n\n/exit\n', options, {}, setup);
    assert.equal(exchanges, 1);
    assert.match(stdout, /認証しました: chatgpt/);
    assert.match(stdout, /公式モデル一覧 1件/);
    assert.match(stdout, /接続しました: chatgpt\/gpt-6\.1-sol/);
    assert.doesNotMatch(stdout + session, /test-token/);
  } finally { await new Promise<void>((resolve) => issuer.close(() => resolve())); }
});

test('チャット画面に Responses API の失敗理由と再試行までの時間を表示する', async () => {
  const error = {
    code: 'server_is_overloaded',
    message: 'Our servers are currently overloaded. Please try again later.',
    headers: { 'retry-after': '318', 'retry-after-ms': '318000' },
  };
  const stream = [{ type: 'error', error }, { type: 'response.failed', response: { error } }]
    .map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const setup = `import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.MODKH_HOME + '/chatgpt-auth.json', JSON.stringify({accessToken:'test'}));
    globalThis.fetch = async () => new Response(${JSON.stringify(stream)});`;
  const { stdout } = await chat('hello\n/exit\n', "{args: {model: 'chatgpt/gpt-6.2-sol'}}", {}, setup);
  assert.ok(stdout.includes(error.message), stdout);
  assert.match(stdout, /server_is_overloaded/);
  assert.match(stdout, /5分18秒後に再試行/);
});

test('/models lists saved API and OAuth accounts together and switches without another login', async () => {
  const setup = `import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.MODKH_HOME + '/keys.json', JSON.stringify({ openai: 'api-fixture', anthropic: 'anthropic-fixture' }));
    writeFileSync(process.env.MODKH_HOME + '/chatgpt-auth.json', JSON.stringify({ accessToken: 'oauth-fixture' }));
    globalThis.fetch = async (url, options) => {
      const address = String(url);
      const auth = new Headers(options?.headers).get('authorization');
      if (address === 'https://api.anthropic.com/v1/models' && new Headers(options?.headers).get('x-api-key') === 'anthropic-fixture')
        return Response.json({ data: [{ id: 'claude-model' }] });
      if (address === 'https://api.openai.com/v1/models' && auth === 'Bearer api-fixture')
        return Response.json({ data: [{ id: 'api-model' }] });
      if (address.startsWith('https://chatgpt.com/backend-api/codex/models?') && auth === 'Bearer oauth-fixture')
        return Response.json({ models: [{ slug: 'oauth-model', visibility: 'list' }] });
      if (address.endsWith('/responses') && auth === 'Bearer oauth-fixture' && JSON.parse(options.body).model === 'oauth-model')
        return new Response('data: ' + JSON.stringify({type:'response.output_text.delta',delta:'switch-verified'}) + '\\n\\n' +
          'data: ' + JSON.stringify({type:'response.completed',response:{status:'completed'}}) + '\\n\\n');
      return new Response(null, { status: 403 });
    }`;
  const { stdout } = await chat('/models\noauth-model\n1\nhello\n/models api-model\n1\n/exit\n', '{}', {}, setup);
  assert.match(stdout, /\d+\. openai\/api-model/);
  assert.match(stdout, /\d+\. chatgpt\/oauth-model/);
  assert.match(stdout, /\d+\. anthropic\/claude-model/);
  assert.match(stdout, /switch-verified/);
  assert.match(stdout, /接続しました: openai\/api-model/);
  assert.doesNotMatch(stdout, /認証を開始|api-fixture|oauth-fixture/);
});
