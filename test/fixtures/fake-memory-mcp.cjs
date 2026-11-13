// 偽MCPサーバ(memory_policy / memory_recall / memory_capture)。
// 呼び出し記録を LOG_FILE に追記する。stdin から newline-delimited JSON-RPC を受ける。
const fs = require('node:fs');
const logPath = process.env.LOG_FILE || '/tmp/dkh-fake-mcp-calls.jsonl';
const policy = {
  global: { read: true, write: true },
  projects: [{ id: 'proj-1', name: 'Demo', read: true }],
};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function log(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      log({ call: 'initialize' });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'fake-kiokuko' },
        },
      });
    } else if (msg.method === 'notifications/initialized') {
      // 通知は応答しない
    } else if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            { name: 'memory_policy' },
            { name: 'memory_recall' },
            { name: 'memory_capture' },
          ],
        },
      });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      log({ call: name, args });
      let text = '';
      if (name === 'memory_policy') text = JSON.stringify(policy);
      else if (name === 'memory_recall') {
        text = 'ヒット: ' + args.query + (args.project ? ' @' + args.project : ' @global');
      } else if (name === 'memory_capture') text = 'saved';
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text }] },
      });
    }
  }
});
