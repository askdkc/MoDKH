import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

/**
 * End-to-end: provider usage reaches the terminal footer through the ordinary CLI path.
 * The OpenAI-compatible stream reports a usage object; the footer must reflect it exactly,
 * and must stay silent when a provider omits usage entirely.
 */
for (const reported of [true, false]) {
  test(`CLI reports parent and child token usage (${reported ? 'reported' : 'omitted'})`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-usage-cli-'));
    const project = path.join(home, 'project');
    fs.mkdirSync(project, { recursive: true });
    let requests = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
          ...(reported ? { usage: { prompt_tokens: 1500, completion_tokens: 250, total_tokens: 1750,
            prompt_tokens_details: { cached_tokens: 1000 } } } : {}) };
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
    const env: NodeJS.ProcessEnv = { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [entry, 'chat', '--cwd', project, '--model', 'compatible/fixture', '--base-url', `http://127.0.0.1:${port}/v1`], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdin.end('hello\n/agents run modkh-explorer inspect\n/usage\n/exit\n');
    try {
      assert.equal(await exited, 0, output);
      assert.equal(requests, 2, output);
      if (reported) {
        // The SDK folds cached tokens into the prompt total, so input reads 2k and the ratio is
        // cache over total input. Every number is the provider's; nothing is estimated here.
        assert.match(output, /使用量: 計 2k tok · cache 67% · 入 2k · 出 250/, output);
        assert.match(output, /トークン消費量 +3\.5K\n未キャッシュ入力 +1K\nキャッシュ読み取り +2K\nキャッシュ書き込み +—\n出力 +500/, output);
      } else {
        assert.doesNotMatch(output, /計 .*tok/, `no usage may be invented:\n${output}`);
        assert.match(output, /トークン使用量はまだ報告されていません/);
      }
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
