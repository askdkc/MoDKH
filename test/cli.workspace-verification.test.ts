import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const [provider, reasoningField] of [['compatible', undefined], ['ollama', 'reasoning'], ['llama-server', 'reasoning_content']] as const)
test(`public chat runs trusted verification against the ordinary edit, not the model claim (${provider})`, { timeout: 20_000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-workspace-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'candidate.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'verify.sh'), 'test "$(cat candidate.txt)" = fixed\n');
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({ permissions: 'workspace', language: false,
    workspaceVerification: { root: fs.realpathSync(root), command: 'sh verify.sh', sources: ['candidate.txt'], protected: ['verify.sh'] } }));
  let requests = 0;
  let sawRealHostFailure = false;
  let sawLocalThinking = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    requests++;
    if (requests === 2 && reasoningField) {
      const body = JSON.parse(raw) as { messages: Record<string, unknown>[] };
      sawLocalThinking = body.messages.some(m => m.role === 'assistant' && m[reasoningField] === 'LOCAL_LOOP_THINKING');
    }
    if (requests === 3) sawRealHostFailure = raw.includes('固定検証が不合格');
    const editing = requests === 1 || requests === 3;
    const delta = editing ? { tool_calls: [{ index: 0, id: `edit_${requests}`, type: 'function', function: {
      name: 'edit_file', arguments: JSON.stringify({ path: 'candidate.txt', old_string: requests === 1 ? 'original' : 'broken',
        new_string: requests === 1 ? 'broken' : 'fixed' }),
    } }] } : { content: requests === 2 ? 'WRONG_CLAIM' : 'VERIFIED_REPLY' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'fixture',
      object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.end((requests === 1 && reasoningField ? frame({ [reasoningField]: 'LOCAL_LOOP_THINKING' }, null) : '')
      + frame(delta, editing ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const entry = process.env.MODKH_TEST_ENTRY ?? fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const env = { ...process.env, MODKH_HOME: temp, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0' };
  delete (env as NodeJS.ProcessEnv).NODE_TEST_CONTEXT;
  // A transport recorder disables replay on purpose, so an inherited recorder value would
  // remove the behaviour under test. This case asserts the ordinary (non-recorded) route.
  delete (env as NodeJS.ProcessEnv).AGENTICREPLAY_TLS_CA;
  delete (env as NodeJS.ProcessEnv).AGENTICREPLAY_PROXY_URL;
  const child = spawn(process.execPath, [entry, 'chat', '--cwd', root, '--model', `${provider}/fixture`, '--base-url',
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 16_000);
  t.after(() => clearTimeout(timer));
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const status = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  child.stdin.end('candidate.txt を修正して\n/exit\n');
  assert.equal(await status, 0, output);
  assert.match(output, /VERIFIED_REPLY/);
  assert.match(output, /設定された最終差分の固定検証は合格/);
  assert.doesNotMatch(output, /WRONG_CLAIM/);
  assert.equal(fs.readFileSync(path.join(root, 'candidate.txt'), 'utf8'), 'fixed\n');
  assert.equal(requests, 4);
  assert.equal(sawRealHostFailure, true);
  if (reasoningField) assert.equal(sawLocalThinking, true);
});
