import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const entry = process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname;

/** Run the CLI against a fixture root; HOME stays inside it so stray writes are visible. */
async function chat(root: string, input: string, env: NodeJS.ProcessEnv = {}) {
  const run = promisify(execFile)(process.execPath, [entry, '--cwd', root], {
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
    fs.writeFileSync(path.join(root, name),
      `#!/bin/sh\nprintf '%s %s [cwd=%s]\\n' "${name}" "$*" "$PWD" >> ${JSON.stringify(log)}\n${body}\n`, { mode: 0o755 });
  }
  const calls = () => fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { calls };
}

/** Audit directories the run created in the working directory. */
function auditDirs(root: string): string[] {
  const base = path.join(root, '.modkh');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter(name => name.startsWith('security-audit.'))
    .map(name => path.join(base, name)).sort();
}

const nmapScript = `case "$*" in
  *--script*vuln*)
    cat <<'TXT'
Nmap scan report for 203.0.113.10
PORT    STATE SERVICE  VERSION
443/tcp open  ssl/https nginx 1.31.8 (PHP 8.5.12)
| ssl-ccs-injection:
|   VULNERABLE:
|   SSL/TLS MITM vulnerability (CCS Injection)
|     State: VULNERABLE
|     IDs:  CVE:CVE-2014-0224
TXT
    ;;
  *)
    printf 'Host: 203.0.113.10 ()\\tPorts: 443/open/tcp//ssl|http//nginx 1.31.8 (PHP 8.5.12)/\\tIgnored State: closed (98)\\n'
    ;;
esac`;

const niktoScript = `while [ $# -gt 0 ]; do if [ "$1" = "-output" ]; then out="$2"; fi; shift; done
printf '+ /admin/: Directory indexing found.\\n+ 1 item checked\\n' > "$out"`;

/** Every tool the URL-side scan may call, each answering deterministically. */
function urlTools(root: string, extra: Record<string, string> = {}) {
  return fakeTools(root, {
    nmap: nmapScript,
    nikto: niktoScript,
    nuclei: `echo '{"template-id":"CVE-2021-41773","info":{"name":"nginx path traversal","severity":"critical"},"matched-at":"https://203.0.113.10/app"}'`,
    searchsploit: `echo '{"RESULTS_EXPLOIT":[{"Title":"nginx 1.31 - buffer overflow","EDB-ID":"12345"}]}'`,
    sqlmap: `echo 'all tested parameters do not appear to be injectable'`,
    ...extra,
  });
}

test('/cyber help explains the scan and starts nothing', async t => {
  const root = tempDir(t, 'modkh-cyber-help-');
  const { calls } = fakeTools(root, { nmap: 'echo should-not-run' });
  const output = await chat(root, '/cyber help\n/cyber\n/exit\n');
  assert.match(output, /使い方: \/cyber <URL>/);
  assert.match(output, /追加調査/);
  assert.deepEqual(calls(), []);
  assert.deepEqual(auditDirs(root), []);
});

test('/cyber reports each command while it runs, with the elapsed time', async t => {
  const root = tempDir(t, 'modkh-cyber-progress-');
  urlTools(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');
  // A human watching the run must see what is executing and when it finished.
  assert.match(output, /… サービス特定/);
  assert.match(output, /… 既知の脆弱性/);
  assert.match(output, /… Nikto/);
  assert.match(output, /[0-9]+\.[0-9]+ 秒/);
});

test('/cyber saves the reports in the working directory, not the home directory', async t => {
  const root = tempDir(t, 'modkh-cyber-location-');
  urlTools(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');

  const [dir] = auditDirs(root);
  assert.ok(dir, `nothing under ${root}/.modkh: ${output}`);
  assert.match(path.basename(dir), /^security-audit\.\d{8}-\d{6}$/);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const name of ['plan.txt', 'nmap-services.txt', 'record.md']) {
    const file = path.join(dir, name);
    assert.ok(fs.existsSync(file), name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, name);
  }
  // Nothing may land beside the home directory any more.
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('security-audit.')), []);
  assert.match(output, /\.modkh/);
});

test('/cyber investigates the services it found, using their names and versions', async t => {
  const root = tempDir(t, 'modkh-cyber-followup-');
  const { calls } = urlTools(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');

  const nuclei = calls().find(call => call.startsWith('nuclei'));
  assert.ok(nuclei, calls().join('\n'));
  assert.match(nuclei, /-tags [^\s]*nginx/);
  assert.match(nuclei, /-tags [^\s]*php/);
  const searchsploit = calls().find(call => call.startsWith('searchsploit'));
  assert.ok(searchsploit, calls().join('\n'));
  assert.match(searchsploit, /nginx 1\.31\.8/);

  assert.match(output, /▶ 5\. 追加調査/);
  assert.match(output, /CVE-2021-41773/);
  assert.match(output, /nginx 1\.31 - buffer overflow/);
});

test('/cyber skips the follow-up with a reason when no engine is installed', async t => {
  const root = tempDir(t, 'modkh-cyber-noengine-');
  // Only the two URL scanners exist, so the investigation cannot run.
  fakeTools(root, { nmap: nmapScript, nikto: niktoScript });
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n', { PATH: root });
  assert.match(output, /\[nuclei（サービス別テンプレート）\] 未実行/);
  assert.match(output, /\[searchsploit（Exploit-DB）\] 未実行/);
});

test('/cyber ends with a report of what it found', async t => {
  const root = tempDir(t, 'modkh-cyber-summary-');
  urlTools(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');
  const summary = output.slice(output.indexOf('■ 発見した内容'));
  assert.ok(summary.length > 0, output);
  assert.match(summary, /既知の脆弱性/);
  assert.match(summary, /CVE-2014-0224/);
  assert.match(summary, /\/admin\//);
  assert.match(summary, /判定できなかった項目/);
  assert.match(summary, /record\.md/);
});

test('/cyber still reports a clean site as clean in the summary', async t => {
  const root = tempDir(t, 'modkh-cyber-clean-');
  fakeTools(root, {
    nmap: `case "$*" in
  *--script*vuln*) echo 'nothing to report' ;;
  *) printf 'Host: 203.0.113.10 ()\\tPorts: 443/open/tcp//https//nginx 1.31.8/\\n' ;;
esac`,
    nikto: `while [ $# -gt 0 ]; do if [ "$1" = "-output" ]; then out="$2"; fi; shift; done
printf '+ 0 items checked\\n' > "$out"`,
    nuclei: 'exit 0',
    searchsploit: `echo '{"RESULTS_EXPLOIT":[]}'`,
  });
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n');
  assert.match(output, /■ 発見した内容/);
  assert.match(output, /検出ありの項目はありませんでした/);
});

test('/cyber shows the checks and the ones it will skip before starting', async t => {
  const root = tempDir(t, 'modkh-cyber-plan-');
  urlTools(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app?token=private-query --no-sqlmap\ny\n/exit\n');
  assert.doesNotMatch(output, /private-query/);
  assert.match(output, /対象 URL: https:\/\/203\.0\.113\.10\/app（クエリ非表示）/);
  assert.match(output, /接続先ポート: 443\/tcp/);
  assert.match(output, /起動しない検査:[\s\S]*ソース検査/);
  assert.match(output, /起動しない検査:[\s\S]*sqlmap/);
  assert.match(output, /\.modkh\/security-audit/);
});

test('/cyber refuses to start when approval is denied', async t => {
  const root = tempDir(t, 'modkh-cyber-denied-');
  const { calls } = urlTools(root);
  const output = await chat(root, '/cyber https://203.0.113.10/app\nn\n/exit\n');
  assert.deepEqual(calls(), []);
  assert.deepEqual(auditDirs(root), []);
  assert.match(output, /検査を開始しませんでした/);
});

test('/cyber reports a missing scanner as 未実行 instead of 検出なし', async t => {
  const root = tempDir(t, 'modkh-cyber-missing-');
  const { calls } = fakeTools(root, { nikto: 'exit 0' });
  const output = await chat(root, '/cyber https://203.0.113.10/app\ny\n/exit\n', { PATH: root });
  assert.match(output, /\[サービス特定（Nmap -sV）\] 未実行/);
  assert.match(output, /\[Nikto\] 検出なし/);
  assert.deepEqual(calls().map(call => call.split(' ')[0]), ['nikto']);
});

test('/cyber runs sqlmap only for a URL with a query, and --no-sqlmap keeps it off', async t => {
  const root = tempDir(t, 'modkh-cyber-sqlmap-');
  const { calls } = urlTools(root);
  const output = await chat(root, [
    '/cyber https://203.0.113.10/item?id=1', 'y',
    '/cyber https://203.0.113.10/item?id=1 --no-sqlmap', 'y',
    '/exit', '',
  ].join('\n'));
  const sqlmapCalls = calls().filter(call => call.startsWith('sqlmap'));
  assert.equal(sqlmapCalls.length, 1, calls().join('\n'));
  assert.match(sqlmapCalls[0]!, /-u https:\/\/203\.0\.113\.10\/item\?id=1/);
  assert.match(output, /sqlmap（稼働先）\] 検出なし/);
  assert.match(output, /sqlmap\] 未実行[\s\S]*--no-sqlmap/);
});

test('/cyber always scans the port the URL names, even when it is unusual', async t => {
  const root = tempDir(t, 'modkh-cyber-port-');
  const { calls } = fakeTools(root, {
    nmap: `case "$*" in
  *--script*vuln*) echo 'nothing to report' ;;
  *) printf 'Host: 127.0.0.1 ()\\tPorts: 18432/open/tcp//http//node/\\n' ;;
esac`,
    nikto: niktoScript,
  });
  const output = await chat(root, '/cyber http://127.0.0.1:18432/app\ny\n/exit\n');
  const nmapCalls = calls().filter(call => call.startsWith('nmap'));
  assert.ok(nmapCalls.length >= 1, calls().join('\n'));
  for (const call of nmapCalls) assert.match(call, /-p [^\s]*\b18432\b/, call);
  assert.match(output, /18432\/tcp open http node/);
});

test('/cyber --source adds the source scanners and keeps a rejected path out', async t => {
  const root = tempDir(t, 'modkh-cyber-source-');
  const outside = tempDir(t, 'modkh-cyber-outside-');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const checkout = path.join(root, 'my app');
  fs.mkdirSync(checkout, { recursive: true });
  const { calls } = urlTools(root, {
    trivy: 'echo \'{"Results":[{"Vulnerabilities":[{"VulnerabilityID":"CVE-2021-23337","PkgName":"lodash","InstalledVersion":"4.17.20","Severity":"HIGH"}]}]}\'',
    'osv-scanner': 'echo \'{"results":[]}\'',
    semgrep: 'echo \'{"results":[],"errors":[],"paths":{"scanned":["a.php"]}}\'',
    gitleaks: 'echo "[]"',
  });
  const output = await chat(root, [
    '/cyber https://203.0.113.10/app --source "my app"', 'y',
    '/cyber https://203.0.113.10/app --source does-not-exist', 'y',
    '/cyber https://203.0.113.10/app --source escape', 'y',
    '/exit', '',
  ].join('\n'));

  const tools = calls().map(call => call.split(' ')[0]);
  assert.deepEqual(tools.slice(0, 5), ['trivy', 'osv-scanner', 'semgrep', 'gitleaks', 'gitleaks']);
  assert.ok(calls()[0]!.includes(`[cwd=${fs.realpathSync(checkout)}]`), calls()[0]!);
  assert.match(output, /CVE-2021-23337/);
  assert.match(output, /ソースのパスが存在しません/);
  assert.match(output, /ワークスペース外のパスは点検しません/);
});

test('/cyber never prints or stores a detected secret value', async t => {
  const root = tempDir(t, 'modkh-cyber-redact-');
  urlTools(root, {
    trivy: 'echo \'{"Results":[]}\'',
    'osv-scanner': 'echo \'{"results":[]}\'',
    semgrep: 'echo \'{"results":[],"errors":[],"paths":{"scanned":["a.php"]}}\'',
    gitleaks: `case "$1" in
  git) cat <<'JSON'
[{"RuleID":"stripe-access-token","Description":"Stripe Access Token","File":"app.js","StartLine":7,"Secret":"example-redaction-marker","Match":"example-redaction-marker"}]
JSON
    exit 10 ;;
  *) echo '[]' ;;
esac`,
  });
  const output = await chat(root, '/cyber https://203.0.113.10/app --source .\ny\n/exit\n');
  assert.match(output, /stripe-access-token app\.js:7/);
  assert.doesNotMatch(output, /example-redaction-marker/);
  const [dir] = auditDirs(root);
  const saved = fs.readFileSync(path.join(dir, 'gitleaks-git.json'), 'utf8');
  assert.doesNotMatch(saved, /example-redaction-marker/);
});

test('/cyber stops the remaining stages after an interruption', async t => {
  const root = tempDir(t, 'modkh-cyber-interrupt-');
  const started = path.join(root, 'nmap-started');
  const log = path.join(root, 'calls');
  fs.writeFileSync(path.join(root, 'nmap'),
    `#!/bin/sh\ntouch ${JSON.stringify(started)}\nprintf 'nmap started\\n' >> ${JSON.stringify(log)}\nsleep 60\nprintf 'nmap ended naturally\\n' >> ${JSON.stringify(log)}\n`,
    { mode: 0o755 });
  for (const name of ['nikto', 'nuclei', 'searchsploit']) {
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
  assert.match(stdout, /中断/);
});

test('/cyber gives each command its own timeout and moves on to the next scan', async t => {
  const root = tempDir(t, 'modkh-cyber-timeout-');
  fs.writeFileSync(path.join(root, 'nmap'),
    `#!/bin/sh\ncase "$*" in
  *--script*vuln*) echo 'nothing to report' ;;
  *) sleep 30 ;;
esac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'nikto'), `#!/bin/sh\n${niktoScript}\n`, { mode: 0o755 });

  const started = Date.now();
  const output = await chat(root, '/cyber https://203.0.113.10/app --timeout 1\ny\n/exit\n');
  const elapsed = Date.now() - started;

  assert.match(output, /\[サービス特定（Nmap -sV）\] 一部未確認/);
  assert.match(output, /1 秒以内に応答がないため打ち切りました/);
  assert.match(output, /\[Nikto\] 検出あり/);
  assert.ok(elapsed < 45_000, `the run waited ${elapsed}ms for a hung scanner`);
});
