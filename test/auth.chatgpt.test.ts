import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { ResponsesApiModel } from '../src/model/chatgpt/responses.ts';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { MODKH_SKILL_BINDING, readBundledSkill } from '../src/agent/bundled-skills.ts';
import type { AgentMessage } from '../src/agent/types.ts';

test('Responses API アダプターが偽SSEでストリーミング+関数往復を完走する', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const input = body['input'] as { type?: string }[];
      const hasOutput = input.some((i) => i.type === 'function_call_output');
      const send = (ev: Record<string, unknown>) => {
        res.write(`event: ${ev['type']}\ndata: ${JSON.stringify(ev)}\n\n`);
      };
      if (!hasOutput) {
        send({ type: 'response.output_text.delta', delta: 'ファ' });
        send({ type: 'response.output_text.delta', delta: 'イルを読みます' });
        send({
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: 'fc1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        });
        send({ type: 'response.completed' });
      } else {
        send({ type: 'response.output_text.delta', delta: 'hello world を確認した' });
        send({ type: 'response.completed' });
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-responses-'));
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n');
    const model = new ResponsesApiModel({
      accessToken: 'sk-test',
      model: 'gpt-fake',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const deltas: string[] = [];
    const executed: string[] = [];
    const messages: AgentMessage[] = [{ role: 'user', content: 'a.txt を読んで' }];
    const r = await runAgentLoop(messages, {
      model,
      registry: new ToolRegistry(defaultTools()),
      root,
      system: 'テスト用指示',
      signal: new AbortController().signal,
      approval: { approve: async () => true },
      hooks: {
        onText: (d) => deltas.push(d),
        onToolResult: (tr) => executed.push(`${tr.name}:${tr.status}`),
      },
    });
    assert.equal(r.outcome, 'complete');
    assert.deepEqual(deltas, ['ファ', 'イルを読みます', 'hello world を確認した']);
    assert.deepEqual(executed, ['read_file:ok']);
    // 要求は公式契約どおり: フラットな function ツール、store:false、会話状態はCLI保持
    const first = requests[0];
    assert.equal(first['store'], false);
    // 日本語の依頼ではホスト指示にルーターと日本語スキルが追加される。
    const instructions = 'テスト用指示\n\n' + MODKH_SKILL_BINDING
      + `\n[kiokuko-soul]\n${readBundledSkill('kiokuko-soul')}\n`
      + `\n[natural-japanese-output]\n${readBundledSkill('natural-japanese-output')}\n`;
    assert.equal(first['instructions'], instructions);
    const [namespace] = first['tools'] as { type: string; name: string; tools: { type: string; name: string; strict: boolean }[] }[];
    assert.equal(namespace.type, 'namespace');
    assert.equal(namespace.name, 'modkh');
    const tools = namespace.tools;
    assert.ok(tools.some((t) => t.type === 'function' && t.name === 'read_file'));
    assert.equal(tools[0].strict, false);
    const second = requests[1];
    assert.equal(second['instructions'], instructions);
    assert.doesNotMatch(JSON.stringify(second['input']), /MODKH host binding|\[natural-japanese-output\]/);
    const input2 = second['input'] as { type?: string; output?: string }[];
    const outItem = input2.find((i) => i.type === 'function_call_output');
    assert.ok(outItem);
    assert.match(outItem.output ?? '', /hello world/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    server.close();
  }
});

test('Responses API のHTTPエラーは error としてループに伝わる', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    const model = new ResponsesApiModel({
      accessToken: 'sk-test',
      model: 'gpt-fake',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    const messages: AgentMessage[] = [{ role: 'user', content: 'hi' }];
    const r = await runAgentLoop(messages, {
      model,
      registry: new ToolRegistry(defaultTools()),
      root: os.tmpdir(),
      signal: new AbortController().signal,
      approval: { approve: async () => true },
    });
    assert.equal(r.outcome, 'error');
    assert.match(r.errorMessage ?? '', /500/);
  } finally {
    server.close();
  }
});
