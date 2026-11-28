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
    encoding: 'utf8', timeout: 120_000,
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
    Packages: [{ ID: 'lodash@4.17.20' }],
    Vulnerabilities: [{
      VulnerabilityID: 'CVE-2021-23337', PkgName: 'lodash', InstalledVersion: '4.17.20',
      FixedVersion: '4.17.21', Severity: 'HIGH', PkgIdentifier: { PURL: 'pkg:npm/lodash@4.17.20' },
    }],
    Misconfigurations: [{ ID: 'DS002', Title: 'root user', Severity: 'HIGH', Location: { Filename: 'Dockerfile', StartLine: 1 } }],
  }],
});

const osvJson = JSON.stringify({
  results: [{
    source: { path: '/src/package-lock.json', type: 'lockfile' },
    packages: [{
      package: { name: 'lodash', version: '4.17.20', purl: 'pkg:npm/lodash@4.17.20' },
      groups: [{ ids: ['GHSA-35jh-r3h4-6jhm'], aliases: ['CVE-2021-23337'], max_severity: '7.2' }],
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

/** Every scanner the full run needs; each one answers deterministically. */
function fullScan(root: string) {
  return fakeTools(root, {
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
    ss: `printf 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\\nLISTEN 0 128 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=7,fd=4))\\nLISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=8,fd=5))\\n'`,
    nmap: `printf 'Host: 203.0.113.10 ()\\tPorts: 443/open/tcp//https///, 5432/open/tcp//postgresql///\\tIgnored State: filtered (65533)\\n'`,
    nikto: `while [ $# -gt 0 ]; do if [ "$1" = "-output" ]; then out="$2"; fi; shift; done
printf '+ /admin/: Directory indexing found.\\n+ /server-status: Apache status page.\\n+ 2 items checked\\n' > "$out"
echo 'nikto finished'`,
    sqlmap: `case "$*" in
  *id=1*) echo 'sqlmap identified the following injection point(s)'; echo 'Parameter: id (GET)'; echo '    Type: boolean-based blind' ;;
  *) echo 'all tested parameters do not appear to be injectable' ;;
esac`,
  });
}

test('/cyber help, and a missing URL, explain the scan and start nothing', async t => {
  const root = tempDir(t, 'modkh-cyber-help-');
  const { calls } = fakeTools(root, { trivy: 'echo should-not-run' });
  const output = await chat(root, '/cyber help\n/cyber\n/exit\n');
  assert.match(output, /使い方: \/cyber <URL>/);
  assert.match(output, /ソース・依存関係・秘密情報/);
  assert.deepEqual(calls(), []);
  assert.deepEqual(reportDirs(root), []);
});

test('/cyber <URL> runs the Skill stages in order and saves each report outside the repository', async t => {
  const root = tempDir(t, 'modkh-cyber-full-');
  const { calls } = fullScan(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');

  // Stage order follows the Skill: sources, ports, web/SQL. No URL query means no sqlmap target.
  assert.deepEqual(calls().map(call => call.split(' ')[0]),
    ['trivy', 'osv-scanner', 'semgrep', 'gitleaks', 'gitleaks', 'ss', 'nmap', 'nikto']);
  assert.match(calls().find(call => call.startsWith('gitleaks'))!, /gitleaks git /);
  // Step 2 scans every TCP port, as the Skill's -p- example does.
  assert.match(calls().find(call => call.startsWith('nmap'))!, /-p- /);
  assert.match(calls().find(call => call.startsWith('nikto'))!, /-Tuning 2 /);

  for (const stage of ['1. ソース・依存関係・秘密情報', '2. 公開ポート', '3. Web 設定と SQL', '4. 記録']) {
    assert.match(output, new RegExp(stage.replace(/\./g, '\\.')), stage);
  }
  assert.match(output, /CVE-2021-23337/);
  assert.match(output, /php\.lang\.security\.sql-injection .*app\.php:12/);
  assert.match(output, /stripe-access-token app\.js:7/);
  assert.match(output, /5432/);
  assert.match(output, /\/admin\//);
  assert.match(output, /sqlmap\] 未実行/);

  const [dir] = reportDirs(root);
  assert.ok(dir, 'audit directory was not created');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const name of ['plan.txt', 'trivy-fs.json', 'osv.json', 'semgrep.json', 'gitleaks-git.json',
    'gitleaks-dir.json', 'ss.txt', 'nmap.txt', 'nikto.txt', 'record.md']) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file), name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, name);
  }
  const record = fs.readFileSync(path.join(dir, 'record.md'), 'utf8');
  assert.match(record, /対象: https:\/\/203\.0\.113\.10\/app/);
  assert.match(record, /再検査/);
});

test('/cyber shows the approved URL, port, checks and skipped checks before starting', async t => {
  const root = tempDir(t, 'modkh-cyber-plan-');
  const { calls } = fullScan(root);
  const output = await chat(root,
    '/cyber https://203.0.113.10/app?token=private-query --no-source --no-sqlmap\ny\n/exit\n');

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
  const { calls } = fullScan(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\nn\n/exit\n');
  assert.deepEqual(calls(), []);
  assert.deepEqual(reportDirs(root), []);
  assert.match(output, /検査を開始しませんでした/);
});

test('/cyber reports a missing scanner as 未実行 instead of 検出なし', async t => {
  const root = tempDir(t, 'modkh-cyber-missing-');
  // Only gitleaks exists: everything else must say why it did not run, and the run continues.
  const { calls } = fakeTools(root, { gitleaks: 'echo "[]"' });
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n', { PATH: root });
  assert.match(output, /Trivy\] 未実行/);
  assert.match(output, /OSV-Scanner\] 未実行/);
  assert.match(output, /Semgrep\] 未実行/);
  assert.match(output, /Gitleaks（Git 履歴）\] 検出なし/);
  assert.match(output, /Nmap\] 未実行/);
  assert.match(output, /Nikto\] 未実行/);
  assert.ok(calls().length >= 2, calls().join('\n'));
  assert.equal(reportDirs(root).length, 1);
});

test('/cyber runs sqlmap only for a URL with a query, and --no-sqlmap keeps it off', async t => {
  const root = tempDir(t, 'modkh-cyber-sqlmap-');
  const { calls } = fullScan(root);
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

test('/cyber uses --source and rejects a path that escapes the workspace', async t => {
  const root = tempDir(t, 'modkh-cyber-source-');
  const outside = tempDir(t, 'modkh-cyber-outside-');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const checkout = path.join(root, 'my app');
  fs.mkdirSync(checkout, { recursive: true });
  const { calls } = fakeTools(root, {
    trivy: 'echo \'{"Results":[]}\'', 'osv-scanner': 'exit 0', semgrep: 'echo \'{"results":[],"errors":[],"paths":{"scanned":[]}}\'',
    gitleaks: 'echo "[]"', ss: 'echo listening', nmap: 'exit 1', nikto: 'exit 0',
  });
  const output = await chat(root, [
    '/cyber https://203.0.113.10/app --source "my app"', 'y',
    '/cyber https://203.0.113.10/app --source does-not-exist', 'y',
    '/cyber https://203.0.113.10/app --source escape', 'y',
    '/exit', '',
  ].join('\n'));

  const trivy = calls().filter(call => call.startsWith('trivy'));
  assert.equal(trivy.length, 1, calls().join('\n'));
  assert.ok(trivy[0]!.includes(`[cwd=${fs.realpathSync(checkout)}]`), trivy[0]!);
  assert.match(output, /ソースのパスが存在しません/);
  assert.match(output, /ワークスペース外のパスは点検しません/);
});

test('/cyber never prints or stores a detected secret value', async t => {
  const root = tempDir(t, 'modkh-cyber-redact-');
  const { calls } = fakeTools(root, {
    trivy: 'echo \'{"Results":[]}\'', 'osv-scanner': 'exit 0', semgrep: 'echo \'{"results":[],"errors":[],"paths":{"scanned":["a.php"]}}\'',
    gitleaks: `case "$1" in
  git) cat <<'JSON'
${gitLeakJson}
JSON
    exit 10 ;;
  dir) echo '[]' ;;
esac`,
    ss: 'echo listening', nmap: 'exit 1', nikto: 'exit 0',
  });
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');
  assert.match(output, /stripe-access-token app\.js:7/);
  assert.match(output, /値は非表示/);
  assert.doesNotMatch(output, /example-redaction-marker/);
  const [dir] = reportDirs(root);
  const saved = fs.readFileSync(path.join(dir, 'gitleaks-git.json'), 'utf8');
  assert.doesNotMatch(saved, /example-redaction-marker/);
  assert.match(saved, /stripe-access-token/);
  assert.ok(calls().some(call => call.startsWith('gitleaks')));
});

test('/cyber stops the remaining stages after an interruption', async t => {
  const root = tempDir(t, 'modkh-cyber-interrupt-');
  const started = path.join(root, 'trivy-started');
  const log = path.join(root, 'calls');
  fs.writeFileSync(path.join(root, 'trivy'),
    `#!/bin/sh\ntouch ${JSON.stringify(started)}\nprintf 'trivy started\\n' >> ${JSON.stringify(log)}\nsleep 60\nprintf 'trivy ended naturally\\n' >> ${JSON.stringify(log)}\n`,
    { mode: 0o755 });
  for (const name of ['osv-scanner', 'semgrep', 'gitleaks', 'ss', 'nmap', 'nikto']) {
    fs.writeFileSync(path.join(root, name), `#!/bin/sh\nprintf '${name} ran\\n' >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  }
  const child = execFile(process.execPath, [entry, '--cwd', root], {
    encoding: 'utf8', timeout: 120_000,
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
  assert.equal(scannerStarted, true, `trivy never started:\n${stdout}`);
  const calls = fs.readFileSync(log, 'utf8');
  for (const name of ['osv-scanner', 'semgrep', 'gitleaks', 'nmap', 'nikto']) {
    assert.ok(!calls.includes(`${name} ran`), `${name} started after the interruption:\n${calls}`);
  }
  assert.doesNotMatch(calls, /ended naturally/);
  assert.match(stdout, /Trivy.*中断/);
  assert.match(stdout, /以降の検査は開始していません/);
});
