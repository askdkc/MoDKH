import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const entry = process.env['DKH_TEST_CHAT'] ?? new URL('../src/cli/chat.ts', import.meta.url).href;
async function chat(input: string, options = '{}') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-interactive-'));
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { runChat } from ${JSON.stringify(entry)}; await runChat({args: {}, ...${options}});`],
    { env: { ...process.env, DKH_HOME: home, OPENAI_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
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

test('モデル選択の失敗後も既存接続を保つ', async () => {
  const { stdout } = await chat('/connect fixed/scripted\n/models openai/gpt-5.2\n1\n/connect\n\n/exit\n');
  assert.match(stdout, /OPENAI_API_KEY/);
  assert.match(stdout, /接続中: fixed\/scripted/);
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
    assert.equal(req.url, '/token');
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
    const { stdout, session } = await chat('/connect chatgpt\n/models chatgpt/gpt-5.2\n1\n/connect\n\n/exit\n', options);
    assert.equal(exchanges, 1);
    assert.match(stdout, /認証しました: chatgpt/);
    assert.match(stdout, /接続しました: chatgpt\/gpt-5.2/);
    assert.doesNotMatch(stdout + session, /test-token/);
  } finally { await new Promise<void>((resolve) => issuer.close(() => resolve())); }
});
