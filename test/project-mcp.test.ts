import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tools/registry.ts';
import { projectMcpTools } from '../src/tools/project-mcp.ts';

test('project server is launched in the project only after approval; list and call preserve MCP payloads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'modkh-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { example: { command: process.execPath, args: ['server.cjs'] } } }));
  await writeFile(join(root, 'server.cjs'), `require('fs').writeFileSync('started','yes');
    require('readline').createInterface({input:process.stdin}).on('line', line => {
      const {method,id,params}=JSON.parse(line); if(id===undefined) return;
      const result=method==='initialize'?{protocolVersion:'2025-06-18'}:method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:params.arguments.value}]};
      console.log(JSON.stringify({jsonrpc:'2.0',id,result})); });`);
  const registry = new ToolRegistry(await projectMcpTools(root));
  const run = (name: string, args: Record<string, unknown>, allow: boolean) => registry.executeOne({ name, args, id:'1' }, { root, approval: { approve: async req => { assert.match(req.detail,/server\.cjs/); return allow; } } });
  const args = {server:'example'};
  assert.equal((await run('mcp_list_tools', args, false)).status, 'error');
  await assert.rejects(access(join(root,'started')));
  const list = await run('mcp_list_tools', args, true);
  assert.equal(list.status, 'ok'); assert.equal(JSON.parse(list.output).tools[0].inputSchema.type,'object');
  const call = await run('mcp_call_tool', {...args,name:'echo',arguments:{value:'works'}}, true);
  assert.equal(call.status,'ok'); assert.equal(JSON.parse(call.output).content[0].text,'works');
});
