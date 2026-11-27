import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { compactLocally } from '../src/agent/compaction.ts';
import type { AgentMessage } from '../src/agent/types.ts';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;
interface Request {
  messages: { role: string; content: string }[];
  tools?: unknown[];
}

for (const mode of ['success', 'disabled', 'failure', 'small-window', 'large-window', 'missing-usage', 'missing-window', 'configured-window', 'latest-usage', 'switch', 'override',
  'long-tool-turn', 'input-overflow', 'stream-overflow', 'legacy-overflow', 'manual', 'unrelated-error'] as const) {
  test(`CLI auto compaction: ${mode}`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-compact-'));
    const model = 'arbitrary-model';
    let catalogReads = 0;
    const requests: Request[] = [];
    const summaryPositions: number[] = [];
    let summaries = 0;
    const toolTurn = ['long-tool-turn', 'input-overflow', 'stream-overflow', 'legacy-overflow', 'manual', 'unrelated-error'].includes(mode);
    const backend = http.createServer(async (req, res) => {
      if (req.url === '/v1/models') {
        catalogReads++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'other', context_length: 50 }, { id: model,
          context_length: mode === 'missing-window' ? undefined : mode === 'large-window' ? 100000 : 10000 }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString()) as Request;
      requests.push(request);
      if (toolTurn && requests.length === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const call = { index: 0, id: 'read-notes', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } };
        const chunk = { id: 'read', model, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] };
        res.write('data: ' + JSON.stringify(chunk) + '\n\n');
        res.end('data: ' + JSON.stringify({ id: 'usage', model, choices: [], usage: {
          prompt_tokens: mode === 'long-tool-turn' ? 7800 : 50, completion_tokens: 1,
        } }) + '\n\ndata: [DONE]\n\n');
        return;
      }
      if (toolTurn && request.messages.at(-1)?.role === 'tool') {
        const message = mode === 'stream-overflow' ? 'prompt length out of range (1..65535)'
          : mode === 'unrelated-error' || mode === 'manual' ? 'Invalid input format'
          : 'request exceeds the context window: prompt (65556 tokens) leaves no room to answer in the context (65536); requests are never truncated';
        const error = JSON.stringify({ error: { type: 'invalid_request_error', message } });
        if (mode === 'stream-overflow') res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: ' + error + '\n\ndata: [DONE]\n\n');
        else res.writeHead(400, { 'content-type': 'application/json' }).end(error);
        return;
      }
      const summary = request.messages.length === 1 && /過去ログ/.test(request.messages[0].content);
      if (summary) {
        summaries++;
        summaryPositions.push(requests.length);
      }
      const content = summary ? (mode === 'failure' ? '' : `ROLLING_SUMMARY_${summaries}`) : 'NORMAL_ANSWER';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ]) {
        res.write(`data: ${JSON.stringify({ id: 'compact-test', object: 'chat.completion.chunk',
          created: 1, model: 'fake', choices: [choice] })}\n\n`);
      }
      if (mode !== 'missing-usage') {
        const tokens = mode === 'latest-usage' && requests.length <= 2 ? 7499 : 7500;
        res.write('data: ' + JSON.stringify({ id: 'compact-test', model, choices: [], usage: {
          prompt_tokens: tokens, completion_tokens: 1, total_tokens: tokens + 1,
        } }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
    const chat = async (inputs: string[], resume?: string) => {
      const child = spawn(process.execPath, [entry, 'chat', '--cwd', home,
        '--model', `compatible/${model}`, '--base-url', `http://127.0.0.1:${(backend.address() as AddressInfo).port}/v1`,
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
        ...(mode === 'configured-window' ? { modelContextWindows: { ['compatible/' + model]: 100000 } } : {}),
        compactionKeepTurns: 1, ...(['success', 'failure', 'override'].includes(mode) ? { compactionAutoBytes: 32768 } : {}), ...(['disabled', 'legacy-overflow'].includes(mode) ? { compactionAutoBytes: 0 } : {}),
      }));
      if (toolTurn) {
        fs.writeFileSync(path.join(home, 'notes.txt'), Array.from({ length: 180 }, (_, i) => 'RAW_NOTE_' + i + ' ' + 'x'.repeat(50)).join('\n'));
        const out = await chat(['Read notes.txt for the editorial report.', ...(mode === 'manual' ? ['/compact', '/compact'] : [])]);
        const [file] = fs.readdirSync(path.join(home, 'sessions'));
        const journal = () => fs.readFileSync(path.join(home, 'sessions', file), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        if (mode === 'legacy-overflow') {
          assert.ok(journal().every(r => r.type !== 'compaction'), 'automatic compaction is explicitly off');
          fs.writeFileSync(path.join(home, 'config.json'), '{}');
          await chat([], path.basename(file, '.jsonl'));
        }
        const records = journal();
        const checkpoints = records.filter(r => r.type === 'compaction');
        if (mode === 'unrelated-error') {
          assert.equal(checkpoints.length, 0);
          assert.match(out, /Invalid input format/);
          return;
        }
        assert.equal(checkpoints.length, 1, out.slice(-1000));
        assert.equal(requests.length, mode === 'long-tool-turn' ? 1 : 2, 'compaction must not replay the tool turn');
        assert.ok(records.some(r => r.message?.results?.some((result: { output: string }) => result.output.includes('RAW_NOTE_150'))));
        const state = checkpoints[0];
        assert.match(state.summary, /notes\.txt/);
        assert.doesNotMatch(state.summary, /RAW_NOTE_/);
        assert.equal(state.from, records.filter(r => r.type === 'message').length);
        await chat(['Summarize the recorded outcome.'], path.basename(file, '.jsonl'));
        const next = requests.at(-1)!.messages;
        assert.ok(next.some(m => String(m.content).includes(state.summary)));
        assert.doesNotMatch(JSON.stringify(next), /RAW_NOTE_/);
        assert.equal(next.at(-1)?.content, 'Summarize the recorded outcome.');
        assert.equal(journal().filter(r => r.message?.results?.length).length, 1);
        return;
      }
      if (mode === 'latest-usage') {
        await chat(['x'.repeat(3000), 'follow-up', 'follow-up again', 'continue']);
        assert.deepEqual(summaryPositions, [4]);
        assert.equal(catalogReads, 1);
        return;
      }
      if (mode === 'switch') {
        const base = 'http://127.0.0.1:' + (backend.address() as AddressInfo).port + '/v1';
        await chat(['x'.repeat(3000), '/connect compatible/other --base-url ' + base, 'first on other', 'second on other']);
        assert.deepEqual(summaryPositions, [3]);
        return;
      }
      if (!['success', 'failure', 'disabled'].includes(mode)) {
        await chat([mode === 'small-window' ? 'x'.repeat(3000) : 'あ'.repeat(45000), 'short follow-up']);
        assert.equal(summaries, mode === 'small-window' || mode === 'override' ? 1 : 0);
        if (mode === 'small-window') assert.equal(catalogReads, 1);
        if (mode === 'configured-window') assert.equal(catalogReads, 0);
        return;
      }
      const first = 'FIRST_ORIGINAL ' + 'あ'.repeat(45000);
      const second = 'SECOND_ORIGINAL ' + (mode === 'success' ? 'い'.repeat(45000) : '');
      const output = await chat([first, second, ...(mode === 'failure' ? ['short follow-up', 'い'.repeat(8000), 'continue'] : [])]);
      if (mode === 'failure') assert.deepEqual(summaryPositions, [2, 6]);
      else assert.equal(summaries, mode === 'disabled' ? 0 : 1);
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

test('local compaction records repeated diagnostics and retains earlier dialogue and the original receipts', () => {
  const history: AgentMessage[] = [
    { role: 'user', content: 'Choose a release label.' },
    { role: 'assistant', content: 'The release is called Maple.' },
    { role: 'user', content: 'Check the scratch files.' },
  ];
  for (let i = 0; i < 6; i++) {
    history.push({ role: 'assistant', content: '', toolCalls: [{ id: String(i), name: 'run_command', args: { command: 'PRIVATE_TEST_ARGUMENT' } }] },
      { role: 'tool', results: [{ callId: String(i), name: 'run_command', status: 'ok', output: '[exit code: 0]\n[CRITICAL] file missing\n' + 'log detail '.repeat(300) }] });
  }
  const before = structuredClone(history);
  const state = compactLocally(history)!;
  assert.equal(state.from, history.length);
  assert.match(state.summary, /Maple/);
  assert.match(state.summary, /run_command \(ok, 出力に\[CRITICAL\]\) ×6/);
  assert.doesNotMatch(state.summary, /PRIVATE_TEST_ARGUMENT|log detail/);
  assert.deepEqual(history, before);
  assert.equal(compactLocally(history, state), undefined);
});
