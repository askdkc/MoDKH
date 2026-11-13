import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openKiokukoMemory, type KiokukoMemory } from '../src/memory/kiokuko.ts';
import { McpStdioClient } from '../src/memory/mcp.ts';

const FAKE_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-memory-mcp.cjs');

// Exercise the real stdio transport, including lost acknowledgements and shutdown.
const BOUNDARY_SERVER = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const mode = process.env.MODE;
if (mode === 'stubborn') process.on('SIGTERM', () => {});
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const name = m.params.name || m.method;
  fs.appendFileSync(process.env.LOG_FILE, JSON.stringify({call: name, args: m.params.arguments}) + '\n');
  const send = (result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result}) + '\n');
  if (m.method === 'initialize') return send({serverInfo:{name:'boundary'}});
  if (name === 'memory_policy') {
    const reply = () => send({content:[{type:'text', text:JSON.stringify({global:{read:mode !== 'deny',write:true},projects:[{id:'p',name:'P',read:mode !== 'deny'}]})}]});
    if (mode === 'slow-policy') return setTimeout(reply, 200);
    return reply();
  }
  if (name === 'memory_capture') {
    if (mode === 'delayed') return setTimeout(() => send({content:[{type:'text',text:'saved'}]}), 200);
    if (mode === 'error') return send({isError:true,content:[{type:'text',text:'rejected'}]});
    if (mode === 'empty') return send(null);
  }
  send({content:[{type:'text', text: name === 'pid' ? String(process.pid) : 'saved'}]});
});
`;

async function withMemory(mode: string, run: (mem: KiokukoMemory, dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-mem-boundary-'));
  const mem = openKiokukoMemory(true, {
    command: process.execPath, args: ['-e', BOUNDARY_SERVER],
    env: { LOG_FILE: path.join(dir, 'calls.jsonl'), MODE: mode },
    callTimeoutMs: mode === 'slow-policy' ? 1000 : 60,
  });
  try { await run(mem, dir); }
  finally { await mem.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('memory_policy の read:false は検索を送信しない', async () => {
  await withMemory('deny', async (mem, dir) => {
    assert.ok(await mem.policy());
    assert.equal(await mem.recall('private'), null);
    assert.equal(await mem.recall('private', 'p'), null);
    assert.equal(readCalls(dir).filter((c) => c.call === 'memory_recall').length, 0);
  });
});

test('承認表示の後に提案が変更されても表示した内容だけを保存する', async () => {
  await withMemory('ok', async (mem, dir) => {
    const proposal = { title: 'approved title', body: 'approved body' };
    assert.equal(await mem.captureIfApproved(proposal, async (display) => {
      assert.match(display, /approved body/);
      proposal.title = 'changed'; proposal.body = 'changed';
      return true;
    }), 'saved');
    assert.deepEqual(readCalls(dir).find((c) => c.call === 'memory_capture')?.args,
      { title: 'approved title', body: 'approved body' });
  });
});

test('Stop後は接続せず、承認中のStop後も保存を送信しない', async () => {
  await withMemory('ok', async (mem, dir) => {
    const stopped = AbortSignal.abort();
    assert.equal(await mem.policy(stopped), null);
    assert.equal(readCalls(dir).length, 0);
    const ac = new AbortController();
    assert.equal(await mem.captureIfApproved({ title: 't', body: 'b' }, async () => {
      ac.abort(); return true;
    }, ac.signal), 'declined');
    assert.equal(readCalls(dir).filter((c) => c.call === 'memory_capture').length, 0);
  });
});

test('policy応答待ちのStop後に新しい承認を出さない', async () => {
  await withMemory('slow-policy', async (mem, dir) => {
    const ac = new AbortController();
    let prompts = 0;
    const watch = setInterval(() => {
      if (readCalls(dir).some((c) => c.call === 'memory_policy')) ac.abort();
    }, 5);
    try {
      const outcome = await mem.captureIfApproved({ title: 't', body: 'b' }, async () => {
        prompts++; return true;
      }, ac.signal);
      assert.equal(ac.signal.aborted, true);
      assert.equal(outcome, 'declined');
      assert.equal(prompts, 0);
      assert.equal(readCalls(dir).filter((c) => c.call === 'memory_capture').length, 0);
    } finally { clearInterval(watch); }
  });
});

test('保存送信後の応答タイムアウトはunknownで、自動再送しない', async () => {
  await withMemory('delayed', async (mem, dir) => {
    assert.ok(await mem.policy());
    assert.equal(await mem.captureIfApproved({ title: 't', body: 'b' }, async () => true), 'unknown');
    assert.equal(readCalls(dir).filter((c) => c.call === 'memory_capture').length, 1);
  });
});

test('保存送信後のStopはunknown、MCPの明示エラーはunavailable', async () => {
  await withMemory('delayed', async (mem, dir) => {
    assert.ok(await mem.policy());
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30);
    try {
      assert.equal(await mem.captureIfApproved({ title: 't', body: 'b' }, async () => true, ac.signal), 'unknown');
      assert.equal(readCalls(dir).filter((c) => c.call === 'memory_capture').length, 1);
    } finally { clearTimeout(timer); }
  });
  await withMemory('error', async (mem) => {
    assert.equal(await mem.captureIfApproved({ title: 't', body: 'b' }, async () => true), 'unavailable');
  });
});

test('承認UIの失敗を補助機能のunavailableに分離する', async () => {
  await withMemory('ok', async (mem, dir) => {
    assert.equal(await mem.captureIfApproved({ title: 't', body: 'b' }, async () => {
      throw new Error('confirmation unavailable');
    }), 'unavailable');
    assert.equal(readCalls(dir).filter((c) => c.call === 'memory_capture').length, 0);
  });
});

test('不正な保存応答をsavedとは表示しない', async () => {
  await withMemory('empty', async (mem) => {
    assert.equal(await mem.captureIfApproved({ title: 't', body: 'b' }, async () => true), 'unknown');
  });
});

test('closeはSIGTERMを無視するMCP子プロセスも回収してから戻る', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-mcp-close-'));
  const client = new McpStdioClient({ command: process.execPath, args: ['-e', BOUNDARY_SERVER],
    env: { LOG_FILE: path.join(dir, 'calls.jsonl'), MODE: 'stubborn' } });
  let pid: number | undefined;
  try {
    assert.equal(await client.connect(), true);
    pid = Number(await client.callTool('pid', {}));
    await client.close();
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readCalls(dir: string): { call: string; args?: Record<string, unknown> }[] {
  try {
    return fs
      .readFileSync(path.join(dir, 'calls.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { call: string; args?: Record<string, unknown> });
  } catch {
    return [];
  }
}

test('既定は無効: 接続せず null / declined を返す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-mem-'));
  const mem = openKiokukoMemory(false, {
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { LOG_FILE: path.join(dir, 'calls.jsonl') },
  });
  assert.equal(await mem.policy(), null);
  assert.equal(await mem.recall('anything'), null);
  assert.equal(
    await mem.captureIfApproved({ title: 't', body: 'b' }, async () => true),
    'declined',
  );
  await mem.close();
  assert.equal(readCalls(dir).length, 0); // 子プロセスを起動していない
  fs.rmSync(dir, { recursive: true, force: true });
});

test('有効時: policy→検索→承認時のみ capture が stdio MCP で通る', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-mem-'));
  const mem = openKiokukoMemory(true, {
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { LOG_FILE: path.join(dir, 'calls.jsonl') },
  });
  try {
    const policy = await mem.policy();
    assert.ok(policy);
    assert.equal(policy.globalRead, true);
    assert.equal(policy.globalWrite, true);
    assert.deepEqual(policy.projects.map((p) => p.id), ['proj-1']);

    assert.match((await mem.recall('セッション再開')) ?? '', /セッション再開 @global/);
    assert.match((await mem.recall('セッション再開', 'proj-1')) ?? '', /@proj-1/);

    // 宣伝していないプロジェクトIDは拒否
    assert.equal(await mem.recall('q', 'unknown-project'), null);

    // 承認された提案そのものが memory_capture に渡る
    const saved = await mem.captureIfApproved(
      { title: 'session resume lesson', body: 'JSONL追記とunknown結果の扱い' },
      async (display) => {
        assert.match(display, /メモリ保存の提案/);
        assert.match(display, /session resume lesson/);
        return true;
      },
    );
    assert.equal(saved, 'saved');

    // 拒否なら memory_capture を呼ばない
    const declined = await mem.captureIfApproved(
      { title: 'no', body: 'no' },
      async () => false,
    );
    assert.equal(declined, 'declined');
  } finally {
    await mem.close();
  }
  const calls = readCalls(dir).filter((c) => c.call !== 'initialize');
  // policy はアダプター内でキャッシュされるため memory_policy は1回だけ呼ばれる
  assert.deepEqual(
    calls.map((c) => c.call),
    ['memory_policy', 'memory_recall', 'memory_recall', 'memory_capture'],
  );
  const capture = calls.find((c) => c.call === 'memory_capture');
  assert.equal(capture?.args?.['title'], 'session resume lesson');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('接続不能でも例外を出さず、null で続行する', async () => {
  const mem = openKiokukoMemory(true, {
    command: 'dkh-no-such-command-xyz',
  });
  const policy = await mem.policy();
  assert.equal(policy, null);
  assert.equal(await mem.recall('q'), null);
  assert.equal(
    await mem.captureIfApproved({ title: 't', body: 'b' }, async () => true),
    'unavailable',
  );
  await mem.close();
});
