import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { projectMcpTools } from '../src/tools/project-mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { TerminalApprovalGate } from '../src/cli/approval.ts';
import type { PermissionPolicy } from '../src/cli/permissions.ts';

test('both framework servers connect before a tool call and reuse their processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'framework-mcp-'));
  const path = process.env.PATH;
  let close: (() => Promise<void>) | undefined;
  let active: string[] = [];
  try {
    for (const name of ['svelte.config.js', 'artisan', 'boost.json']) await writeFile(join(root, name), '');
    for (const bin of ['npx', 'php']) await writeFile(join(root, bin), `#!${process.execPath}\nrequire('fs').appendFileSync('starts','${bin}\\n');
      require('readline').createInterface({input:process.stdin}).on('line', line => {
        const {id,method}=JSON.parse(line); if(id===undefined) return;
        console.log(JSON.stringify({jsonrpc:'2.0',id,result:method==='initialize'?{protocolVersion:'2025-06-18'}:{tools:[]}}));
      });`, { mode: 0o755 });
    process.env.PATH = root + delimiter + path;
    const requests: { title: string; detail: string; outsideWorkspace: boolean }[] = [];
    const options = (allow: boolean) => ({ approve: async (request: typeof requests[number]) => { requests.push(request); return allow; }, onClose: (fn: () => Promise<void>) => { close = fn; }, onError: (msg: string) => assert.fail(msg) });
    await projectMcpTools(root, ids => { active = ids; }, options(false));
    await assert.rejects(readFile(join(root, 'starts')), { code: 'ENOENT' });
    // 起動時の自動接続は作業ルートで走る固定コマンドなので、既定の workspace ポリシーでも
    // 確認を挟まずに接続できる。要求がルート外を主張すると毎回プロンプトになる。
    assert.ok(requests.length > 0);
    for (const request of requests) {
      assert.equal(request.outsideWorkspace, false, request.title);
      assert.match(request.title, /プロジェクトMCPに接続/);
      assert.match(request.detail, /^(npx -y @sveltejs\/mcp|php artisan boost:mcp)$/);
    }
    await close?.();
    const registry = new ToolRegistry(await projectMcpTools(root, ids => { active = ids; }, options(true)));
    assert.deepEqual(active, ['laravel-boost', 'svelte']);
    for (const server of active) assert.equal((await registry.executeOne({ id:'1', name:'mcp_list_tools', args:{ server } }, { root, approval:{ approve:async () => true } })).status, 'ok');
    assert.deepEqual((await readFile(join(root, 'starts'), 'utf8')).trim().split('\n').sort(), ['npx', 'php']);
    await close?.();
    assert.deepEqual(active, []);
  } finally {
    await close?.();
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true });
  }
});

/** Real gates instead of a stub: the policy decides whether a prompt appears. */
async function startupWith(policy: PermissionPolicy) {
  const root = await mkdtemp(join(tmpdir(), 'framework-mcp-policy-'));
  const saved = process.env.PATH;
  const written: string[] = [];
  const started = join(root, 'starts');
  let close: (() => Promise<void>) | undefined;
  try {
    await writeFile(join(root, 'svelte.config.js'), '');
    await writeFile(join(root, 'npx'), `#!${process.execPath}\nrequire('fs').appendFileSync('starts','npx\\n');
      require('readline').createInterface({input:process.stdin}).on('line', line => {
        const {id,method}=JSON.parse(line); if(id===undefined) return;
        console.log(JSON.stringify({jsonrpc:'2.0',id,result:method==='initialize'?{protocolVersion:'2025-06-18'}:{tools:[]}}));
      });`, { mode: 0o755 });
    process.env.PATH = root + delimiter + saved;
    const approval = new TerminalApprovalGate({ ask: async () => 'n', write: text => { written.push(text); } }, policy);
    await projectMcpTools(root, undefined, {
      approve: request => approval.approve({ kind: 'command', ...request }),
      onError: () => {},
      onClose: fn => { close = fn; },
    });
    await close?.();
    return { prompted: written.join('').includes('承認要求'), started: await readFile(started, 'utf8').then(() => true, () => false) };
  } finally {
    process.env.PATH = saved;
    await rm(root, { recursive: true, force: true });
  }
}

test('workspace と all は起動時の MCP 接続を確認なしで通し、none は毎回確認する', async () => {
  // The default policy must not prompt: a startup connection is a command modkh itself chose.
  assert.deepEqual(await startupWith('workspace'), { prompted: false, started: true });
  assert.deepEqual(await startupWith('all'), { prompted: false, started: true });
  // A policy that asks for everything still covers this path; the refusal keeps the process down.
  assert.deepEqual(await startupWith('none'), { prompted: true, started: false });
});
