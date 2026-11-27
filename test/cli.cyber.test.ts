import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

async function chat(root: string, input: string, env: NodeJS.ProcessEnv = {}) {
  const run = promisify(execFile)(process.execPath, [entry, '--cwd', root], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0', ...env },
  });
  run.child.stdin!.end(input);
  return (await run).stdout;
}

test('/cyber uses only the selected command-line checks without a model', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = ['trivy', 'osv-scanner', 'semgrep', 'gitleaks', 'sqlmap', 'nmap'];
  for (const name of [...tools, 'curl', 'browse']) fs.writeFileSync(path.join(root, name),
    '#!/bin/sh\necho "${0##*/} $*" >> calls\n', { mode: 0o755 });
  const output = await chat(root, '/cyber help\n/cyber\ny\n/cyber tools\ny\n/cyber nope\n/exit\n');
  assert.match(output, /Gitleaks/i);
  const calls = fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n');
  assert.deepEqual(calls.map(c => c.split(' ')[0]), [...tools, ...tools, 'curl']);
  assert.ok(calls.includes('curl --version'));
  assert.ok(calls.includes('sqlmap --version') && calls.includes('nmap --version'));
  assert.match(output, /使い方: \/cyber/);
});

test('/cyber inspects only the approved URL and reports the headers from that response', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-url-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.curlrc'), 'location\n');
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/go') res.writeHead(302, { location: '/elsewhere' });
    else res.writeHead(200, { 'Content-Security-Policy': "default-src 'self'", 'Set-Cookie': 'session=private-cookie' });
    res.end();
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const target = `${origin}/app/[1-2]?a=one&token=private-query#in-page`;
  const output = await chat(root, [
    `/cyber ${origin}/denied`, 'n', `/cyber ${target}`, 'y', `/cyber tools ${origin}/go`, 'y', '/exit', '',
  ].join('\n'), { CURL_HOME: root, no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' });
  assert.deepEqual(hits, ['HEAD /app/[1-2]?a=one&token=private-query', 'HEAD /go']);
  const port = (server.address() as AddressInfo).port;
  assert.ok(output.includes(`Nmap (127.0.0.1): ${port}/tcp open`) || output.includes('nmap が PATH に見つかりません'), output);
  assert.match(output, /HTTP 200\b/);
  assert.match(output, /Content-Security-Policy: あり/);
  assert.match(output, /X-Content-Type-Options: なし/);
  assert.match(output, /HTTP 302\b/);
  assert.doesNotMatch(output, /private-cookie|private-query/);
});

test('/cyber rejects invalid URL arguments before asking to run a tool', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const invalid = ['file:///tmp/input', 'https://user:private-pass@example.org/', 'https://', 'https://example.org/ extra'];
  const output = await chat(root, [...invalid.map(arg => '/cyber ' + arg), '/exit', ''].join('\n'));
  assert.equal(output.match(/使い方: \/cyber <URL>/g)?.length, invalid.length);
  assert.doesNotMatch(output, /承認要求|private-pass/);
});

test('/cyber runs Nmap for the single port in each approved URL', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'curl'), '#!/bin/sh\nprintf "HTTP/1.1 200 OK\\r\\n\\r\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'nmap'), `#!/bin/sh
echo "$*" >> ports
while [ "$1" != "-p" ] && [ "$#" -gt 0 ]; do shift; done
printf 'Host: localhost ()\\tPorts: %s/open/tcp//unknown///\\n' "$2"
`, { mode: 0o755 });
  const output = await chat(root, [
    '/cyber http://127.0.0.1:4567', 'n',
    '/cyber http://127.0.0.1/app', 'y',
    '/cyber tools https://[::1]/app', 'y',
    '/cyber https://127.0.0.1:8443/app?token=private', 'y', '/exit', '',
  ].join('\n'));
  const calls = fs.readFileSync(path.join(root, 'ports'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 3);
  for (const [i, port] of [80, 443, 8443].entries()) {
    assert.match(calls[i], new RegExp(` -p ${port} `));
    assert.match(calls[i], i === 1 ? / -6 .*::1$/ : / 127\.0\.0\.1$/);
    assert.match(output, new RegExp(`${port}/tcp open`));
  }
  assert.doesNotMatch(calls.join('\n'), /private|\/app|4567/);
});
