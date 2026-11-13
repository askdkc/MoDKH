import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('CLI closes connected optional memory when journal persistence fails', () => {
  // Isolate prototype/stdio fault injection; this test writes no session or config files.
  const source = `
    import fs from 'node:fs';
    import { PassThrough } from 'node:stream';
    import { SessionStore, Session } from ${JSON.stringify(new URL('../src/session/store.ts', import.meta.url).href)};
    import { McpStdioClient } from ${JSON.stringify(new URL('../src/memory/mcp.ts', import.meta.url).href)};
    import { runChat } from ${JSON.stringify(new URL('../src/cli/chat.ts', import.meta.url).href)};
    const originalRead = fs.readFileSync;
    fs.readFileSync = function(p, ...rest) {
      if (String(p).endsWith('/config.json')) return JSON.stringify({memory:{enabled:true,command:'unused',args:[]}});
      return originalRead.call(this, p, ...rest);
    };
    const session = Session.fromText('test', 'unused', JSON.stringify({
      type:'session', id:'test', cwd:process.cwd(), model:'fixed/scripted', seq:0, createdAt:'now',
    }));
    SessionStore.prototype.create = () => session;
    Session.prototype.append = function(message) { this.messages.push(message); };
    Session.prototype.setStatus = function(status) { this.status = status; };
    Session.prototype.recordMemory = () => {};
    Session.prototype.persistFrom = () => { throw new Error('simulated journal failure'); };
    let connects = 0, closes = 0;
    McpStdioClient.prototype.connect = async () => { connects++; return true; };
    McpStdioClient.prototype.callTool = async name => name === 'memory_policy'
      ? JSON.stringify({global:{read:true,write:false}}) : 'reference';
    McpStdioClient.prototype.close = async () => { closes++; };
    const stdin = new PassThrough();
    Object.defineProperty(process, 'stdin', {value:stdin});
    stdin.end('hello' + String.fromCharCode(10));
    try { await runChat({args:{model:'fixed/scripted'}}); }
    catch (error) { console.log('OBSERVED ' + JSON.stringify({message:error.message,connects,closes})); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split('\n').find(value => value.startsWith('OBSERVED '));
  assert.ok(line, result.stdout);
  assert.deepEqual(JSON.parse(line.slice('OBSERVED '.length)), {
    message: 'simulated journal failure', connects: 1, closes: 1,
  });
});
