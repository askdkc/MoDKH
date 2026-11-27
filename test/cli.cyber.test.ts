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
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0', ...env },
  });
  run.child.stdin!.end(input);
  return (await run).stdout;
}

/** Fake tools that log their argv and cwd, then emit the given structured output. */
function fakeTools(root: string, scripts: Record<string, string>) {
  const log = path.join(root, 'calls');
  for (const [name, body] of Object.entries(scripts)) {
    // The absolute log path matters: source scanners run with the source directory as their cwd.
    fs.writeFileSync(path.join(root, name),
      `#!/bin/sh\nprintf '%s %s [cwd=%s]\\n' "${name}" "$*" "$PWD" >> ${JSON.stringify(log)}\n${body}\n`, { mode: 0o755 });
  }
  const calls = () => fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { calls };
}

const trivyJson = JSON.stringify({
  Results: [{
    Target: 'package-lock.json', Packages: [{ ID: 'lodash@4.17.20' }],
    Vulnerabilities: [{
      VulnerabilityID: 'CVE-2021-23337', VendorIDs: ['GHSA-35jh-r3h4-6jhm'], PkgName: 'lodash',
      InstalledVersion: '4.17.20', FixedVersion: '4.17.21', Severity: 'HIGH',
      PkgIdentifier: { PURL: 'pkg:npm/lodash@4.17.20' },
    }],
  }],
});

const osvJson = JSON.stringify({
  results: [{
    source: { path: '/src/checkout/package-lock.json', type: 'lockfile' },
    packages: [{
      package: { name: 'lodash', version: '4.17.20', purl: 'pkg:npm/lodash@4.17.20?source=PUBLIC_REGISTRY' },
      groups: [{ ids: ['GHSA-35jh-r3h4-6jhm'], aliases: ['CVE-2021-23337', 'GHSA-35jh-r3h4-6jhm'], max_severity: '7.2' }],
    }],
  }],
});

test('/cyber keeps the direct-check modes and never asks a model', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { calls } = fakeTools(root, Object.fromEntries(
    ['trivy', 'osv-scanner', 'semgrep', 'gitleaks', 'sqlmap', 'nmap'].map(name => [name, `echo ${name}-version`])));
  fs.writeFileSync(path.join(root, 'curl'), '#!/bin/sh\necho "curl $*" >> calls\necho curl-version\n', { mode: 0o755 });
  const output = await chat(root, '/cyber help\n/cyber\ny\n/cyber tools\ny\n/cyber nope\n/exit\n');
  assert.match(output, /Gitleaks/i);
  assert.deepEqual(calls().map(call => call.split(' ')[0]),
    ['trivy', 'osv-scanner', 'semgrep', 'gitleaks', 'sqlmap', 'nmap', 'trivy', 'osv-scanner', 'semgrep', 'gitleaks', 'sqlmap', 'nmap', 'curl']);
  assert.match(output, /使い方: \/cyber <URL>/);
});

test('/cyber <URL> alone inspects the URL and starts no local scanner', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-url-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    // A hardened site answers 404 to the probe paths, so this fixture must too.
    if (['/.env', '/.git/config', '/server-status', '/.DS_Store'].includes(req.url ?? '')) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Security-Policy': "default-src 'self'", 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'geolocation=()', 'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Set-Cookie': 'sid=private-cookie-value; Secure; HttpOnly; SameSite=Lax' });
    res.end();
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const { calls } = fakeTools(root, {
    trivy: 'exit 0', 'osv-scanner': 'exit 0', semgrep: 'exit 0', gitleaks: 'exit 0',
  });
  const output = await chat(root, `/cyber http://127.0.0.1:${port}/app?token=private-query\ny\n/exit\n`,
    { no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' });
  // Only the approved host and path, and only GET/HEAD/OPTIONS: no scanner ran.
  assert.deepEqual([...new Set(hits.map(hit => hit.split(' ')[0]))].sort(), ['GET', 'HEAD', 'OPTIONS']);
  const approvedPath = '/app?token=private-query';
  for (const hit of hits) {
    const target = hit.split(' ')[1] ?? '';
    assert.ok(target === approvedPath || ['.env', '.git/config', 'server-status', '.DS_Store'].includes(target.replace(/^\//, '')),
      hit);
  }
  assert.equal(calls().filter(call => !call.startsWith('curl') && !call.startsWith('nmap')).length, 0, calls().join('\n'));
  assert.match(output, /\[HTTP\] 検出なし/);
  assert.match(output, /\[ソース検査\] 未実行/);
  assert.match(output, /\[sqlmap\] 未実行/);
  assert.doesNotMatch(output, /private-cookie-value|private-query/);
});

test('/cyber <URL> --source runs each source scanner once in that directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'my app');
  fs.mkdirSync(checkout, { recursive: true });
  const { calls } = fakeTools(root, {
    trivy: `cat <<'JSON'\n${trivyJson}\nJSON\nexit 10`,
    'osv-scanner': `cat <<'JSON'\n${osvJson}\nJSON\nexit 1`,
    semgrep: `cat <<'JSON'\n{"results":[{"check_id":"javascript.lang.security.audit.sqli","path":"app.js","start":{"line":3},"extra":{"severity":"ERROR","message":"SQL 文を連結しています"}}],"errors":[],"paths":{"scanned":["app.js"]}}\nJSON\nexit 1`,
    gitleaks: 'echo "[]"',
    curl: 'exit 7',
  });
  const server = createServer((_req, res) => { res.writeHead(200); res.end(); });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const output = await chat(root, `/cyber http://127.0.0.1:${port}/app --source "my app"\ny\n/exit\n`,
    { no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' });
  const sources = calls().filter(call => ['trivy', 'osv-scanner', 'semgrep', 'gitleaks'].some(name => call.startsWith(name + ' ')));
  assert.equal(sources.length, 4, calls().join('\n'));
  // The child cwd is the resolved source path, so compare against the real path.
  const expectedCwd = fs.realpathSync(checkout);
  for (const call of sources) assert.ok(call.includes(`[cwd=${expectedCwd}]`), call);
  // The same advisory from both scanners is one row, not two.
  assert.match(output, /CVE-2021-23337 \[HIGH\].*OSV-Scanner \+ Trivy/);
  assert.match(output, /依存関係の指摘 1 件/);
  assert.match(output, /javascript\.lang\.security\.audit\.sqli \[ERROR\] app\.js:3/);
  assert.match(output, /\[Gitleaks\] 検出なし/);
});

test('/cyber rejects an invalid source path or a symlink escape before any approval', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-bounds-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const { calls } = fakeTools(root, { trivy: 'exit 0', 'osv-scanner': 'exit 0', semgrep: 'exit 0', gitleaks: 'exit 0' });
  const output = await chat(root, [
    '/cyber https://example.org/app --source does-not-exist', 'y',
    '/cyber https://example.org/app --source escape', 'y',
    '/cyber https://example.org/app --source', 'y',
    '/exit', '',
  ].join('\n'));
  assert.doesNotMatch(output, /承認要求/);
  assert.match(output, /ソースのパスが存在しません/);
  assert.match(output, /ワークスペース外のパスは点検しません/);
  assert.equal(calls().length, 0, calls().join('\n'));
});

test('/cyber refuses to start when approval is denied', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-denied-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(200); res.end(); });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  fakeTools(root, { trivy: 'exit 0', 'osv-scanner': 'exit 0', semgrep: 'exit 0', gitleaks: 'exit 0' });
  const output = await chat(root, `/cyber http://127.0.0.1:${port}/app --source .\nn\n/exit\n`,
    { no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' });
  assert.deepEqual(hits, []);
  assert.match(output, /検査を開始しませんでした/);
});

test('/cyber reads a sqlmap summary only when it names the same target', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-sqlmap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'match.json'), JSON.stringify({
    target: 'https://example.org/app', date: '2026-11-27', verdict: '注入可能なパラメータは見つかりませんでした',
  }));
  fs.writeFileSync(path.join(root, 'other.json'), JSON.stringify({ target: 'https://example.net/other', verdict: '検出' }));
  // sqlmap on PATH would log a call; reading a summary must never start it.
  const { calls } = fakeTools(root, { sqlmap: 'echo should-not-run', curl: 'exit 7' });
  const output = await chat(root, [
    '/cyber https://example.org/app --sqlmap-summary other.json', 'y',
    '/cyber https://example.org/app --sqlmap-summary match.json', 'y',
    '/exit', '',
  ].join('\n'));
  assert.match(output, /要約の対象が一致しません/);
  assert.match(output, /sqlmap（外部診断）\] 情報/);
  assert.match(output, /2026-11-27/);
  assert.match(output, /MoDKH は sqlmap を起動していません/);
  assert.equal(calls().filter(call => call.startsWith('sqlmap')).length, 0, calls().join('\n'));
});

test('/cyber reports a missing scanner as 未実行 and keeps the other checks going', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Only gitleaks exists; the other three must be reported as 未実行 rather than failing the run.
  const { calls } = fakeTools(root, { gitleaks: 'echo "[]"', curl: 'exit 7' });
  const server = createServer((_req, res) => { res.writeHead(200); res.end(); });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  // A PATH with only this fixture makes "not installed" a fact rather than a host accident.
  const output = await chat(root, `/cyber http://127.0.0.1:${port}/ --source .\ny\n/exit\n`,
    { PATH: root, no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' });
  assert.match(output, /\[Trivy\] 未実行/);
  assert.match(output, /\[OSV-Scanner\] 未実行/);
  assert.match(output, /\[Semgrep\] 未実行/);
  assert.match(output, /\[Gitleaks\] 検出なし/);
  assert.ok(calls().some(call => call.startsWith('gitleaks ')), calls().join('\n'));
});

test('/cyber stops the remaining source tools after an interruption', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-interrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = path.join(root, 'trivy-started');
  const log = path.join(root, 'calls');
  // Trivy marks that it really started, then hangs. Waiting for that marker makes the
  // interruption decisive instead of racing the report output.
  fs.writeFileSync(path.join(root, 'trivy'),
    `#!/bin/sh\ntouch ${JSON.stringify(started)}\nprintf 'trivy started\\n' >> ${JSON.stringify(log)}\nsleep 60\nprintf 'trivy ended naturally\\n' >> ${JSON.stringify(log)}\n`,
    { mode: 0o755 });
  for (const name of ['osv-scanner', 'semgrep', 'gitleaks']) {
    fs.writeFileSync(path.join(root, name), `#!/bin/sh\nprintf '${name} ran\\n' >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(root, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const child = execFile(process.execPath, [entry, '--cwd', root], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0' },
  });
  let stdout = '';
  child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.on('data', (chunk: string) => { stdout += chunk; });
  child.stdin!.end('/cyber https://127.0.0.1:1/app --source .\ny\n/exit\n');
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const scannerStarted = fs.existsSync(started);
  child.kill('SIGINT');
  await new Promise<number | null>(resolve => child.on('close', resolve));
  assert.equal(scannerStarted, true, `trivy never started:\n${stdout}`);
  const calls = fs.readFileSync(log, 'utf8');
  for (const name of ['osv-scanner', 'semgrep', 'gitleaks']) {
    assert.ok(!calls.includes(`${name} ran`), `${name} started after the interruption:\n${calls}`);
  }
  // A killed scanner must not also report a normal completion.
  assert.doesNotMatch(calls, /ended naturally/);
  assert.match(stdout, /\[Trivy\] 中断/);
  assert.match(stdout, /以降の検査は開始していません/);
});

test('/cyber never prints a detected secret value or a URL query value', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-cyber-redact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = 'example-redaction-marker';
  fakeTools(root, {
    trivy: 'exit 0', 'osv-scanner': 'exit 0', semgrep: 'exit 0', curl: 'exit 7',
    // Simulate a scanner returning an unredacted value to exercise the report boundary.
    gitleaks: `cat <<'JSON'\n[{"RuleID":"stripe-access-token","Description":"Stripe Access Token","File":"app.js","StartLine":1,"Secret":"${secret}","Match":"${secret}"}]\nJSON\nexit 10`,
  });
  const server = createServer((_req, res) => { res.writeHead(200, { 'Set-Cookie': 'sid=session-cookie-value' }); res.end(); });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  const output = await chat(root, `/cyber http://127.0.0.1:${port}/app?token=private-query-value --source .\ny\n/exit\n`,
    { no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' });
  assert.ok(!output.includes(secret));
  assert.doesNotMatch(output, /session-cookie-value|private-query-value/);
  assert.match(output, /stripe-access-token app\.js:1/);
  assert.match(output, /値は非表示/);
});
