import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
interface Request {
  messages: { role: string; content: string }[];
  tools?: unknown[];
}

for (const mode of ['success', 'disabled', 'failure'] as const) {
  test(`CLI auto compaction: ${mode}`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-compact-'));
    const requests: Request[] = [];
    let summaries = 0;
    const backend = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString()) as Request;
      requests.push(request);
      const summary = request.messages.length === 1 && /過去ログ/.test(request.messages[0].content);
      if (summary) summaries++;
      const content = summary ? (mode === 'failure' ? '' : `ROLLING_SUMMARY_${summaries}`) : 'NORMAL_ANSWER';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) {
        res.write(`data: ${JSON.stringify({ id: 'compact-test', object: 'chat.completion.chunk',
          created: 1, model: 'fake', choices: [choice] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
    const chat = async (inputs: string[], resume?: string) => {
      const child = spawn(process.execPath, [entry, 'chat', '--cwd', home,
        '--model', 'compatible/fake', '--base-url', `http://127.0.0.1:${(backend.address() as AddressInfo).port}/v1`,
        ...(resume ? ['--resume', resume] : [])],
      { env: { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.stdin.end([...inputs, '/exit', ''].join('\n'));
      try { assert.equal((await once(child, 'close'))[0], 0, output.slice(-2000)); }
      finally { clearTimeout(timeout); }
      return output;
    };

    try {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
        compactionKeepTurns: 1, ...(mode === 'disabled' ? { compactionAutoBytes: 0 } : {}),
      }));
      const first = 'FIRST_ORIGINAL ' + 'あ'.repeat(45000);
      const second = 'SECOND_ORIGINAL ' + (mode === 'success' ? 'い'.repeat(45000) : '');
      const output = await chat([first, second]);
      assert.equal(summaries, mode === 'disabled' ? 0 : 1);
      const secondMessages = requests.at(-1)!.messages;
      assert.ok(secondMessages.some(message => message.content === second));
      assert.equal(secondMessages.some(message => message.content === first), mode !== 'success');
      const [file] = fs.readdirSync(path.join(home, 'sessions'));
      const logPath = path.join(home, 'sessions', file);
      assert.match(fs.readFileSync(logPath, 'utf8'), /FIRST_ORIGINAL/);
      if (mode === 'failure') {
        assert.match(output, /自動圧縮に失敗/);
        assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /"type":"compaction"/);
      }
      if (mode !== 'success') return;
      assert.match(output, /会話履歴を自動圧縮しました/);
      assert.ok(!requests[1].tools?.length);
      assert.match(secondMessages.map(m => m.content).join('\n'), /ROLLING_SUMMARY_1/);
      await chat(['continue after restart'], path.basename(file, '.jsonl'));
      assert.equal(summaries, 2);
      assert.match(requests.at(-2)!.messages[0].content, /ROLLING_SUMMARY_1/);
      assert.match(requests.at(-2)!.messages[0].content, /SECOND_ORIGINAL/);
      assert.doesNotMatch(requests.at(-2)!.messages[0].content, /FIRST_ORIGINAL/);
      await chat(['resume the compacted session'], path.basename(file, '.jsonl'));
      assert.equal(summaries, 2);
      assert.match(requests.at(-1)!.messages.map(m => m.content).join('\n'), /ROLLING_SUMMARY_2/);
      assert.doesNotMatch(requests.at(-1)!.messages.map(m => m.content).join('\n'), /FIRST_ORIGINAL|SECOND_ORIGINAL/);
    } finally {
      await new Promise<void>(resolve => backend.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
