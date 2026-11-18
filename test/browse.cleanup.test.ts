import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

for (const outcome of ['success', 'navigation failure', 'interrupt']) {
  test(`chat closes only its browse group before accepting the next turn (${outcome})`, { skip: process.platform === 'win32' }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-cleanup-'));
    try {
      const bin = path.join(home, 'bin');
      const root = path.join(home, 'workspace');
      const state = path.join(home, 'tabs.json');
      fs.mkdirSync(bin); fs.mkdirSync(root);
      fs.writeFileSync(state, JSON.stringify({ existing: [99] }));
      fs.writeFileSync(path.join(bin, 'browse'), `#!${process.execPath}
const fs = require('node:fs');
const state = ${JSON.stringify(state)};
const tabs = JSON.parse(fs.readFileSync(state));
const [op, flag, json] = process.argv.slice(2);
const {group, action, tab} = JSON.parse(json);
if (op === 'navigate') {
  tabs[group] = [12, 13]; // The tab and a popup, even when navigation reports an error.
  fs.writeFileSync(state, JSON.stringify(tabs));
  if (${outcome === 'navigation failure'}) { console.error('navigation failed'); process.exit(3); }
  if (${outcome === 'interrupt'}) { process.kill(process.ppid, 'SIGINT'); setTimeout(() => {}, 5000); }
  else console.log(JSON.stringify({tab: 12}));
} else if (op === 'snapshot' && tab === 12 && Object.values(tabs).some(ids => ids.includes(tab))) {
  console.log('tab is still open during the turn');
} else if (op === 'tabs' && action === 'close' && group && group !== 'existing') {
  const closed = tabs[group] || [];
  delete tabs[group]; fs.writeFileSync(state, JSON.stringify(tabs));
  console.log(JSON.stringify({closed}));
} else if (op === 'tabs' && action === 'list' && group) {
  console.log(JSON.stringify({tabs: tabs[group] || []}));
} else { console.error('unexpected browser call'); process.exit(4); }
`, { mode: 0o755 });
      const chat = new URL('../src/cli/chat.ts', import.meta.url).href;
      const fixed = new URL('../src/model/fixed.ts', import.meta.url).href;
      const script = `import { runChat } from ${JSON.stringify(chat)};
import { FixedModel } from ${JSON.stringify(fixed)};
import fs from 'node:fs';
const call = (args) => [{ type: 'tool-call', call: { id: args.action, name: 'browse', args } }, { type: 'finish', stopReason: 'tool-calls' }];
const done = [{type: 'finish', stopReason: 'stop'}];
const model = new FixedModel([call({action: 'navigate', url: 'https://example.com'}), ...(${outcome === 'success'} ? [call({action: 'snapshot', tab: 12}), done] : []), done]);
const stream = model.stream.bind(model);
model.stream = (req, signal) => {
  if (req.messages.some(m => m.role === 'user' && m.content === 'next')) {
    console.log('BEFORE_NEXT=' + fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
  }
  return stream(req, signal);
};
await runChat({args: {cwd: ${JSON.stringify(root)}, model: 'fixed/scripted'}, modelFactory: () => model});`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        input: 'browse with a popup\nnext\n/exit\n', encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, MODKH_HOME: home, PATH: bin + path.delimiter + process.env.PATH },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, outcome === 'success' ? /tab is still open during the turn/
        : outcome === 'interrupt' ? /中断しました/ : /navigation failed/);
      assert.match(result.stdout, /BEFORE_NEXT=\{"existing":\[99\]\}/);
      assert.deepEqual(JSON.parse(fs.readFileSync(state, 'utf8')), { existing: [99] });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}
