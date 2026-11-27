import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('/cyber uses only the selected command-line checks without a model', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = ['trivy', 'osv-scanner', 'semgrep', 'gitleaks', 'sqlmap', 'nmap'];
  for (const name of [...tools, 'browse']) fs.writeFileSync(path.join(root, name),
    '#!/bin/sh\necho "${0##*/} $*" >> calls\n', { mode: 0o755 });
  const run = spawnSync(process.execPath, [new URL('../src/index.ts', import.meta.url).pathname, '--cwd', root], {
    input: '/cyber help\n/cyber\ny\n/cyber tools\ny\n/cyber nope\n/exit\n', encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Gitleaks/i);
  const calls = fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n');
  assert.deepEqual(calls.map(c => c.split(' ')[0]), [...tools, ...tools]);
  assert.ok(calls.includes('sqlmap --version') && calls.includes('nmap --version'));
  assert.match(run.stdout, /使い方: \/cyber/);
});
