import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

/** Run the CLI against a fixture root; HOME stays inside it so audit reports are removable. */
async function chat(root: string, input: string, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const run = promisify(execFile)(process.execPath, [entry, '--cwd', root, ...args], {
    encoding: 'utf8', timeout: 180_000,
    env: {
      ...process.env, PATH: root + path.delimiter + process.env.PATH,
      HOME: root, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0', ...env,
    },
  });
  run.child.stdin!.end(input);
  return (await run).stdout;
}

function tempDir(t: { after(fn: () => void): void }, prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Fake scanners that log their argv and cwd, then emit the given structured output. */
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

/** Every audit directory the command created under the fixture HOME. */
function reportDirs(root: string): string[] {
  return fs.readdirSync(root).filter(name => name.startsWith('security-audit.'))
    .map(name => path.join(root, name)).sort();
}

const trivyJson = JSON.stringify({
  Results: [{
    Target: 'package-lock.json',
    Vulnerabilities: [{
      VulnerabilityID: 'CVE-2021-23337', PkgName: 'lodash', InstalledVersion: '4.17.20',
      FixedVersion: '4.17.21', Severity: 'HIGH',
    }],
  }],
});

const osvJson = JSON.stringify({
  results: [{
    source: { path: '/src/package-lock.json' },
    packages: [{
      package: { name: 'lodash', version: '4.17.20', purl: 'pkg:npm/lodash@4.17.20' },
      groups: [{ ids: ['GHSA-35jh-r3h4-6jhm'], aliases: ['CVE-2021-23337'] }],
    }],
  }],
});

const semgrepJson = JSON.stringify({
  results: [{
    check_id: 'php.lang.security.sql-injection', path: 'app.php', start: { line: 12 },
    extra: { severity: 'ERROR', message: 'SQL 文を連結しています' },
  }],
  errors: [],
  paths: { scanned: ['app.php'] },
});

const gitLeakJson = JSON.stringify([{
  RuleID: 'stripe-access-token', Description: 'Stripe Access Token', File: 'app.js', StartLine: 7,
  Secret: 'example-redaction-marker', Match: 'example-redaction-marker',
}]);

/** nmap answers both the version scan (greppable) and the vuln-script run (normal output). */
const nmapScript = `case "$*" in
  *--script*vuln*)
    cat <<'TXT'
Nmap scan report for 203.0.113.10
PORT    STATE SERVICE  VERSION
443/tcp open  ssl/https Caddy
| ssl-ccs-injection:
|   VULNERABLE:
|   SSL/TLS MITM vulnerability (CCS Injection)
|     State: VULNERABLE
|     IDs:  CVE:CVE-2014-0224
|     Disclosure date: 2014-06-05
TXT
    ;;
  *)
    printf 'Host: 203.0.113.10 ()\\tPorts: 443/open/tcp//https//Caddy httpd/, 22/open/tcp//ssh//OpenSSH 7.4/\\tIgnored State: closed (98)\\n'
    ;;
esac`;

/** A service scan plus the web checks; each command answers without a query. */
function urlScan(root: string, extra: Record<string, string> = {}) {
  return fakeTools(root, {
    nmap: nmapScript,
    nikto: `while [ $# -gt 0 ]; do if [ "$1" = "-output" ]; then out="$2"; fi; shift; done
printf '+ /admin/: Directory indexing found.\\n+ 2 items checked\\n' > "$out"
echo 'nikto finished'`,
    sqlmap: `case "$*" in
  *id=1*) echo 'sqlmap identified the following injection point(s)'; echo 'Parameter: id (GET)'; echo '    Type: boolean-based blind' ;;
  *) echo 'all tested parameters do not appear to be injectable' ;;
esac`,
    ...extra,
  });
}

/** The source scanners, used only when --source is passed. */
const sourceTools = {
  trivy: `cat <<'JSON'\n${trivyJson}\nJSON`,
  'osv-scanner': `cat <<'JSON'\n${osvJson}\nJSON\nexit 1`,
  semgrep: `cat <<'JSON'\n${semgrepJson}\nJSON`,
  gitleaks: `case "$1" in
  git) cat <<'JSON'
${gitLeakJson}
JSON
    exit 10 ;;
  *) echo '[]' ;;
esac`,
};

test('/cyber help, and a missing URL, explain the scan and start nothing', async t => {
  const root = tempDir(t, 'modkh-cyber-help-');
  const { calls } = fakeTools(root, { nmap: 'echo should-not-run' });
  const output = await chat(root, '/cyber help\n/cyber\n/exit\n');
  assert.match(output, /使い方: \/cyber <URL>/);
  assert.match(output, /既知の脆弱性/);
  assert.deepEqual(calls(), []);
  assert.deepEqual(reportDirs(root), []);
});

test('/cyber <URL> alone never runs the source scanners', async t => {
  const root = tempDir(t, 'modkh-cyber-url-only-');
  const { calls } = urlScan(root, sourceTools);
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');

  const tools = calls().map(call => call.split(' ')[0]);
  assert.deepEqual(tools, ['nmap', 'nmap', 'nikto'], calls().join('\n'));
  // Step 1 identifies the running service; step 2 probes the ports it found.
  assert.match(calls()[0]!, /-sV /);
  assert.match(calls()[0]!, /-p /);
  assert.match(calls()[1]!, /--script vuln and not brute/);
  assert.match(calls()[1]!, /-p 443,22 /);
  assert.match(output, /\[ソース検査\] 未実行[\s\S]*--source/);
  // The plan lists the skipped scanners by name; nothing else about them appears.
  const afterApproval = output.slice(output.indexOf('(承認)'));
  assert.doesNotMatch(afterApproval, /\[Trivy\]|\[OSV-Scanner\]|\[Semgrep\]|\[Gitleaks/);

  const [dir] = reportDirs(root);
  assert.ok(dir, 'audit directory was not created');
  for (const name of ['plan.txt', 'nmap-services.txt', 'nmap-vuln.txt', 'nikto.txt', 'record.md']) {
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  }
});

test('/cyber reports the service version and the CVE its vulnerability probe confirmed', async t => {
  const root = tempDir(t, 'modkh-cyber-service-');
  urlScan(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');
  assert.match(output, /443\/tcp open https Caddy httpd/);
  assert.match(output, /ssh OpenSSH 7\.4/);
  assert.match(output, /CVE-2014-0224/);
  assert.match(output, /ssl-ccs-injection/);
  assert.match(output, /\[既知の脆弱性（Nmap --script vuln）\] 検出あり/);
  assert.match(output, /\[Nikto\] 検出あり/);
  const [dir] = reportDirs(root);
  const record = fs.readFileSync(path.join(dir, 'record.md'), 'utf8');
  assert.match(record, /CVE-2014-0224/);
  assert.match(record, /再検査/);
});

test('/cyber shows the checks and the ones it will skip before starting', async t => {
  const root = tempDir(t, 'modkh-cyber-plan-');
  const { calls } = urlScan(root, sourceTools);
  const output = await chat(root, '/cyber https://203.0.113.10/app?token=private-query --no-sqlmap\ny\n/exit\n');

  const prompt = output.slice(0, output.indexOf('--- 承認要求'));
  assert.doesNotMatch(prompt, /private-query/);
  assert.doesNotMatch(output, /private-query/);
  assert.match(output, /対象 URL: https:\/\/203\.0\.113\.10\/app（クエリ非表示）/);
  assert.match(output, /接続先ポート: 443\/tcp/);
  assert.match(output, /起動しない検査:[\s\S]*ソース検査/);
  assert.match(output, /起動しない検査:[\s\S]*sqlmap/);
  assert.equal(calls().filter(call => call.startsWith('trivy') || call.startsWith('sqlmap')).length, 0);
});

test('/cyber refuses to start when approval is denied', async t => {
  const root = tempDir(t, 'modkh-cyber-denied-');
  const { calls } = urlScan(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\nn\n/exit\n');
  assert.deepEqual(calls(), []);
  assert.deepEqual(reportDirs(root), []);
  assert.match(output, /検査を開始しませんでした/);
});

test('/cyber reports a missing scanner as 未実行 instead of 検出なし', async t => {
  const root = tempDir(t, 'modkh-cyber-missing-');
  // Only nikto exists: everything else must say why it did not run, and the run continues.
  const { calls } = fakeTools(root, { nikto: 'exit 0' });
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n', { PATH: root });
  assert.match(output, /\[サービス特定（Nmap -sV）\] 未実行/);
  // Nikto exists but writes no report file: 検出なし is the correct verdict, and
  // the run must not call a scanner that is not installed.
  assert.match(output, /\[Nikto\] 検出なし/);
  // Only the installed scanner ran; the missing ones were never started.
  assert.deepEqual(calls().map(call => call.split(' ')[0]), ['nikto']);
  assert.equal(reportDirs(root).length, 1);
});

test('/cyber runs sqlmap only for a URL with a query, and --no-sqlmap keeps it off', async t => {
  const root = tempDir(t, 'modkh-cyber-sqlmap-');
  const { calls } = urlScan(root);
  const output = await chat(root, [
    '/cyber https://203.0.113.10/item?id=1', 'y',
    '/cyber https://203.0.113.10/item?id=1 --no-sqlmap', 'y',
    '/exit', '',
  ].join('\n'));
  const sqlmapCalls = calls().filter(call => call.startsWith('sqlmap'));
  assert.equal(sqlmapCalls.length, 1, calls().join('\n'));
  assert.match(sqlmapCalls[0]!, /-u https:\/\/203\.0\.113\.10\/item\?id=1/);
  assert.match(sqlmapCalls[0]!, /--batch/);
  assert.match(output, /sqlmap（稼働先）\] 検出あり/);
  assert.match(output, /sqlmap\] 未実行[\s\S]*--no-sqlmap/);
});

test('/cyber --source adds the source scanners and rejects a path that escapes the workspace', async t => {
  const root = tempDir(t, 'modkh-cyber-source-');
  const outside = tempDir(t, 'modkh-cyber-outside-');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const checkout = path.join(root, 'my app');
  fs.mkdirSync(checkout, { recursive: true });
  const { calls } = urlScan(root, sourceTools);
  const output = await chat(root, [
    '/cyber https://203.0.113.10/app --source "my app"', 'y',
    '/cyber https://203.0.113.10/app --source does-not-exist', 'y',
    '/cyber https://203.0.113.10/app --source escape', 'y',
    '/exit', '',
  ].join('\n'));

  const tools = calls().map(call => call.split(' ')[0]);
  // Source scanners first, then the URL side.
  assert.deepEqual(tools, ['trivy', 'osv-scanner', 'semgrep', 'gitleaks', 'gitleaks', 'nmap', 'nmap', 'nikto']);
  const trivy = calls().find(call => call.startsWith('trivy'))!;
  assert.ok(trivy.includes(`[cwd=${fs.realpathSync(checkout)}]`), trivy);
  assert.match(output, /ソースのパスが存在しません/);
  assert.match(output, /ワークスペース外のパスは点検しません/);
  assert.match(output, /CVE-2021-23337/);
  assert.match(output, /php\.lang\.security\.sql-injection .*app\.php:12/);
});

test('/cyber never prints or stores a detected secret value', async t => {
  const root = tempDir(t, 'modkh-cyber-redact-');
  urlScan(root, sourceTools);
  const output = await chat(root, '/cyber https://203.0.113.10/app --source .\ny\n/exit\n');
  assert.match(output, /stripe-access-token app\.js:7/);
  assert.match(output, /値は非表示/);
  assert.doesNotMatch(output, /example-redaction-marker/);
  const [dir] = reportDirs(root);
  const saved = fs.readFileSync(path.join(dir, 'gitleaks-git.json'), 'utf8');
  assert.doesNotMatch(saved, /example-redaction-marker/);
  assert.match(saved, /stripe-access-token/);
});

test('/cyber stops the remaining stages after an interruption', async t => {
  const root = tempDir(t, 'modkh-cyber-interrupt-');
  const started = path.join(root, 'nmap-started');
  const log = path.join(root, 'calls');
  fs.writeFileSync(path.join(root, 'nmap'),
    `#!/bin/sh\ntouch ${JSON.stringify(started)}\nprintf 'nmap started\\n' >> ${JSON.stringify(log)}\nsleep 60\nprintf 'nmap ended naturally\\n' >> ${JSON.stringify(log)}\n`,
    { mode: 0o755 });
  for (const name of ['nikto', 'sqlmap']) {
    fs.writeFileSync(path.join(root, name), `#!/bin/sh\nprintf '${name} ran\\n' >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  }
  const child = execFile(process.execPath, [entry, '--cwd', root], {
    encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, HOME: root, MODKH_HOME: root, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0' },
  });
  let stdout = '';
  child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.on('data', (chunk: string) => { stdout += chunk; });
  child.stdin!.end('/cyber https://203.0.113.10/app\ny\n/exit\n');
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const scannerStarted = fs.existsSync(started);
  child.kill('SIGINT');
  await new Promise<number | null>(resolve => child.on('close', resolve));
  assert.equal(scannerStarted, true, `nmap never started:\n${stdout}`);
  const calls = fs.readFileSync(log, 'utf8');
  assert.ok(!calls.includes('nikto ran'), `nikto started after the interruption:\n${calls}`);
  assert.doesNotMatch(calls, /ended naturally/);
  assert.match(stdout, /\[サービス特定（Nmap -sV）\] 中断/);
  assert.match(stdout, /以降の検査は開始していません/);
});

test('/cyber always scans the port the URL names, even when it is unusual', async t => {
  const root = tempDir(t, 'modkh-cyber-port-');
  const { calls } = fakeTools(root, {
    // 18432 is not in the representative list; without it the site would look closed.
    nmap: `case "$*" in
  *--script*vuln*) echo 'nothing to report' ;;
  *) printf 'Host: 127.0.0.1 ()\\tPorts: 18432/open/tcp//http//node/\\n' ;;
esac`,
    nikto: `while [ $# -gt 0 ]; do if [ "$1" = "-output" ]; then out="$2"; fi; shift; done
printf '+ ok\\n' > "$out"`,
  });
  const output = await chat(root, '/cyber http://127.0.0.1:18432/app\ny\n/exit\n');
  const nmapCalls = calls().filter(call => call.startsWith('nmap'));
  assert.equal(nmapCalls.length, 2, calls().join('\n'));
  for (const call of nmapCalls) assert.match(call, /-p [^\s]*\b18432\b/, call);
  assert.match(output, /18432\/tcp open http node/);
  assert.doesNotMatch(output, /開いているポートはありませんでした/);
});

test('/cyber gives each command its own timeout and moves on to the next scan', async t => {
  const root = tempDir(t, 'modkh-cyber-timeout-');
  const log = path.join(root, 'calls');
  // The version scan hangs; the run must not stop there.
  fs.writeFileSync(path.join(root, 'nmap'),
    `#!/bin/sh\nprintf 'nmap started\\n' >> ${JSON.stringify(log)}\ncase "$*" in
  *--script*vuln*) echo 'nothing to report' ;;
  *) sleep 30 ;;
esac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'nikto'),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-output" ]; then out="$2"; fi; shift; done
printf '+ /admin/: Directory indexing found.\\n' > "$out"\n`, { mode: 0o755 });
  const started = Date.now();
  // The fixture PATH precedes the real one so `sleep` exists but nmap is the fake.
  const output = await chat(root, '/cyber https://203.0.113.10/app --timeout 1\ny\n/exit\n');
  const elapsed = Date.now() - started;

  assert.match(output, /\[サービス特定（Nmap -sV）\] 一部未確認/);
  assert.match(output, /1 秒以内に応答がないため打ち切りました/);
  assert.match(output, /\[Nikto\] 検出あり/);
  assert.match(output, /\/admin\//);
  // 1s cap, not the 60s default and certainly not the old 15 minutes.
  assert.ok(elapsed < 45_000, `the run waited ${elapsed}ms for a hung scanner`);
});
