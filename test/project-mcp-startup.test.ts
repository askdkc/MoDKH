import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { projectMcpTools } from '../src/tools/project-mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

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
    const options = (allow: boolean) => ({ approve: async () => allow, onClose: (fn: () => Promise<void>) => { close = fn; }, onError: (msg: string) => assert.fail(msg) });
    await projectMcpTools(root, ids => { active = ids; }, options(false));
    await assert.rejects(readFile(join(root, 'starts')), { code: 'ENOENT' });
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
