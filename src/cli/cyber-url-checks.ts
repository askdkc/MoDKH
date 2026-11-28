import { cookieAttributes, responseEvidence, securityHeaders, type ResponseEvidence } from './cyber-review.ts';
import { isIP } from 'node:net';
import { displayUrl, type UrlTarget } from './cyber-url.ts';
import { oneLine, writeCheck } from './cyber-report.ts';
import { runProcess, type ProcessRun } from './cyber-process.ts';

const HTTP_TIMEOUT_MS = 15_000;
const TLS_TIMEOUT_MS = 15_000;
const NMAP_TIMEOUT_MS = 25_000;

/** Paths that must not answer 200 on a public site. HEAD only; no body is fetched. */
const EXPOSURE_PATHS = ['.env', '.git/config', 'server-status', '.DS_Store'] as const;

/** Service ports worth reporting next to the URL's own port. */
const SWEEP_PORTS = '21,22,25,80,443,445,1433,3000,3306,5432,6379,8000,8080,8443,9200,27017';

/** Open ports that are themselves a finding when the host is public. */
const DATASTORE_PORTS = new Set(['1433', '3306', '5432', '6379', '9200', '27017']);

function missingMessage(tool: string): string {
  return `${tool} が見つかりません（PATH を確認してください）。`;
}

/** curl writes any earlier block (proxy CONNECT, 100-continue) before the real response. */
function lastHeaderBlock(stdout: string): { status?: string; fields: [string, string][] } {
  const block = stdout.trimEnd().split(/\r?\n\r?\n/).at(-1) ?? '';
  const [statusLine, ...lines] = block.split(/\r?\n/);
  const status = /^HTTP\/[\d.]+\s+(\d{3})\b/.exec(statusLine ?? '')?.[1];
  const fields: [string, string][] = [];
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    fields.push([line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()]);
  }
  return { status, fields };
}

function headerValue(fields: readonly [string, string][], name: string): string | undefined {
  return fields.find(([key]) => key === name)?.[1];
}

/** Split a GET response into its header block and body; curl prints headers first. */
function splitResponse(stdout: string): { headers: string; body: string } {
  const index = stdout.indexOf('\r\n\r\n');
  const lfIndex = stdout.indexOf('\n\n');
  const cut = index >= 0 && (lfIndex < 0 || index < lfIndex) ? index : lfIndex;
  if (cut < 0) return { headers: stdout, body: '' };
  const separator = cut === index ? 4 : 2;
  return { headers: stdout.slice(0, cut), body: stdout.slice(cut + separator) };
}

async function resolveAddress(target: UrlTarget, signal: AbortSignal): Promise<string | undefined> {
  const host = target.url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return host;
  const run = await runProcess('dig', ['+short', '+time=5', '+tries=1', host, 'A'], signal, { timeoutMs: 8_000 });
  if (run.started && run.code === 0) {
    const found = run.stdout.split('\n').map(line => line.trim()).find(value => isIP(value) === 4);
    if (found) return found;
  }
  const { lookup } = await import('node:dns/promises');
  try {
    const { address } = await lookup(host);
    return address;
  } catch {
    return undefined;
  }
}

async function dnsCheck(target: UrlTarget, signal: AbortSignal, write: (text: string) => void): Promise<void> {
  const host = target.url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    writeCheck(write, { name: 'DNS', status: '情報', lines: [`IP アドレス指定のため名前解決を省略: ${host}`] });
    return;
  }
  let digMissing = false;
  const records: Record<string, string[]> = { A: [], AAAA: [], TXT: [], CAA: [] };
  const queries: [string, string][] = [['A', host], ['AAAA', host], ['TXT', host], ['CAA', host], ['TXT', `_dmarc.${host}`]];
  for (const [type, name] of queries) {
    if (signal.aborted) break;
    const run = await runProcess('dig', ['+short', '+time=5', '+tries=1', name, type], signal, { timeoutMs: 8_000 });
    if (!run.started) { digMissing = true; break; }
    if (!run.started || run.aborted) continue;
    if (run.code !== 0) continue;
    const key = name.startsWith('_dmarc.') ? 'DMARC' : type;
    records[key] ??= [];
    for (const line of run.stdout.split('\n')) {
      const value = line.trim();
      if (value) records[key].push(value);
    }
  }
  if (digMissing) {
    writeCheck(write, { name: 'DNS', status: '未実行', lines: [missingMessage('dig')] });
    return;
  }
  if (signal.aborted) {
    writeCheck(write, { name: 'DNS', status: '中断', lines: ['名前解決を中止しました。'] });
    return;
  }
  const addresses = [...records.A ?? [], ...records.AAAA ?? []];
  if (!addresses.length) {
    writeCheck(write, { name: 'DNS', status: '失敗', lines: [`${host} の A/AAAA レコードを取得できませんでした。`] });
    return;
  }
  const spf = (records.TXT ?? []).find(record => /"v=spf1\b/i.test(record));
  const dmarc = (records.DMARC ?? []).join(' ');
  const issues: string[] = [];
  if (spf && /[+~?]?\s*all"?\s*$/.test(spf) && spf.includes('+all')) issues.push('SPF が +all を含み、任意の送信元を許可しています。');
  if (!spf) issues.push('SPF レコードがありません（送信元ドメインの詐称を防げません）。');
  if (!dmarc) issues.push('DMARC レコードがありません。');
  const lines = [
    `A/AAAA (${addresses.length}件): ${addresses.slice(0, 6).join(', ')}${addresses.length > 6 ? ' …' : ''}`,
    `SPF: ${spf ? oneLine(spf) : 'なし'}`,
    `DMARC: ${dmarc ? oneLine(dmarc) : 'なし'}`,
    `CAA: ${(records.CAA ?? []).join(' ') || 'なし'}`,
    ...issues,
  ];
  writeCheck(write, {
    name: 'DNS', status: issues.length ? '検出あり' : '検出なし',
    ...(issues.length ? { count: issues.length } : {}), lines,
  });
}

async function tcpPortCheck(target: UrlTarget, address: string | undefined, cwd: string, signal: AbortSignal, write: (text: string) => void): Promise<void> {
  if (!address) {
    writeCheck(write, { name: 'Nmap', status: '失敗', lines: ['対象ホストの IP アドレスを解決できませんでした。'] });
    return;
  }
  const run = await runProcess('nmap', ['--unprivileged', '-sT', '-Pn', '-n', ...(isIP(address) === 6 ? ['-6'] : []),
    '-p', target.port, '-oG', '-', address], signal, { cwd, timeoutMs: NMAP_TIMEOUT_MS });
  if (!run.started) { writeCheck(write, { name: 'Nmap', status: '未実行', lines: [missingMessage('nmap')] }); return; }
  if (run.aborted) { writeCheck(write, { name: 'Nmap', status: '中断', lines: ['ポート確認を中止しました。'] }); return; }
  if (run.timedOut) { writeCheck(write, { name: 'Nmap', status: '失敗', lines: ['時間切れです。'] }); return; }
  const match = /^Host: [^\n]*?\tPorts: (\d+)\/([a-z|]+)\/tcp\//m.exec(run.stdout);
  if (match?.[1] !== target.port) {
    writeCheck(write, { name: 'Nmap', status: '失敗', lines: ['ポートの状態を確認できませんでした。'] });
    return;
  }
  writeCheck(write, { name: 'Nmap', status: '情報', lines: [`${address}: ${target.port}/tcp ${match[2]}`] });
}

async function portSweep(address: string | undefined, cwd: string, signal: AbortSignal, write: (text: string) => void): Promise<void> {
  if (!address) {
    writeCheck(write, { name: 'Nmap 公開ポート', status: '失敗', lines: ['対象ホストの IP アドレスを解決できませんでした。'] });
    return;
  }
  const run = await runProcess('nmap', ['--unprivileged', '-sT', '-Pn', '-n', '-T4', '--host-timeout', '20s',
    '-p', SWEEP_PORTS, '-oG', '-', address], signal, { cwd, timeoutMs: NMAP_TIMEOUT_MS });
  if (!run.started) { writeCheck(write, { name: 'Nmap 公開ポート', status: '未実行', lines: [missingMessage('nmap')] }); return; }
  if (run.aborted) { writeCheck(write, { name: 'Nmap 公開ポート', status: '中断', lines: ['ポート走査を中止しました。'] }); return; }
  if (run.timedOut) { writeCheck(write, { name: 'Nmap 公開ポート', status: '失敗', lines: ['時間切れです。'] }); return; }
  const line = run.stdout.split('\n').find(entry => entry.startsWith('Host:') && /\t(?:Ports|Ignored State):/.test(entry));
  if (run.code !== 0 || run.truncated || !line) {
    writeCheck(write, { name: 'Nmap 公開ポート', status: '失敗', lines: ['ポートの確認結果を取得できませんでした。'] });
    return;
  }
  const open: { port: string; service: string }[] = [];
  for (const entry of line.split('\tPorts: ')[1]?.split(', ') ?? []) {
    const [port, state, , , service] = entry.split('/');
    if (state === 'open' && port) open.push({ port, service: service ?? '' });
  }
  const exposed = open.filter(entry => DATASTORE_PORTS.has(entry.port));
  const lines = open.length
    ? open.map(entry => `${entry.port}/tcp open${entry.service ? ` (${entry.service})` : ''}`)
    : ['走査した範囲に開いているポートはありませんでした。'];
  if (exposed.length) lines.push(`データストアのポートが公開されています: ${exposed.map(entry => entry.port).join(', ')}`);
  lines.push(`走査したポート: ${SWEEP_PORTS}`);
  writeCheck(write, {
    name: 'Nmap 公開ポート', status: exposed.length ? '検出あり' : '検出なし',
    ...(exposed.length ? { count: exposed.length } : {}), lines,
  });
}

async function tlsCheck(target: UrlTarget, signal: AbortSignal, write: (text: string) => void): Promise<{ verified: boolean; daysLeft?: number; protocol?: string } | undefined> {
  if (target.url.protocol !== 'https:') {
    writeCheck(write, { name: 'TLS', status: '未実行', lines: ['HTTP のため TLS 検査は対象外です。'] });
    return undefined;
  }
  const host = target.url.hostname.replace(/^\[|\]$/g, '');
  const connectHost = isIP(host) === 6 ? `[${host}]` : host;
  const args = ['s_client', '-connect', `${connectHost}:${target.port}`, '-showcerts', '-verify_hostname', host];
  if (!isIP(host)) args.push('-servername', host);
  const run = await runProcess('openssl', args, signal, { timeoutMs: TLS_TIMEOUT_MS, input: '', maxBytes: 192 * 1024 });
  if (!run.started) { writeCheck(write, { name: 'TLS', status: '未実行', lines: [missingMessage('openssl')] }); return undefined; }
  if (run.aborted) { writeCheck(write, { name: 'TLS', status: '中断', lines: ['TLS 検査を中止しました。'] }); return undefined; }
  const verify = /Verify return code:\s*(\d+)\s*\(([^)]*)\)/.exec(run.stdout);
  const protocol = /Protocol\s*:\s*(\S+)/.exec(run.stdout)?.[1];
  if (!verify) {
    writeCheck(write, { name: 'TLS', status: '失敗', lines: ['TLS ハンドシェイクの結果を読み取れませんでした（接続できないか、TLS ではありません）。'] });
    return undefined;
  }
  const code = Number(verify[1]);
  const certificate = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(run.stdout)?.[0];
  let parsed = '';
  if (certificate) {
    const details = await runProcess('openssl', ['x509', '-noout', '-subject', '-issuer', '-enddate', '-ext', 'subjectAltName'], signal,
      { timeoutMs: 10_000, input: certificate + '\n' });
    if (details.started && !details.aborted) parsed = details.stdout;
  }
  const end = /notAfter=([^\n]+)/.exec(parsed)?.[1];
  const expires = end ? Date.parse(end) : Number.NaN;
  const daysLeft = Number.isNaN(expires) ? undefined : Math.floor((expires - Date.now()) / 86_400_000);
  const subject = /subject=([^\n]+)/.exec(parsed)?.[1];
  const issuer = /issuer=([^\n]+)/.exec(parsed)?.[1];
  const san = /(?:DNS|IP Address):[^\n]+/.exec(parsed)?.[0];
  const issues: string[] = [];
  if (code !== 0) issues.push(`証明書を検証できません（openssl の戻り値 ${code}: ${verify[2]}）。`);
  if (protocol === 'TLSv1' || protocol === 'TLSv1.1') issues.push(`古い TLS バージョンです: ${protocol}`);
  if (daysLeft !== undefined && daysLeft < 0) issues.push('証明書の有効期限が切れています。');
  else if (daysLeft !== undefined && daysLeft < 30) issues.push(`証明書の残り有効期間が ${daysLeft} 日です。`);
  const lines = [
    `TLS ${protocol ?? '不明'} / 証明書検証 ${code === 0 ? '成功' : `失敗 (${code})`}`,
    ...(subject ? [`subject: ${oneLine(subject)}`] : []),
    ...(issuer ? [`issuer: ${oneLine(issuer)}`] : []),
    ...(end ? [`有効期限: ${end}${daysLeft === undefined ? '' : `（残り ${daysLeft} 日）`}`] : []),
    ...(san ? [`SAN: ${oneLine(san)}`] : []),
    ...issues,
  ];
  writeCheck(write, {
    name: 'TLS', status: issues.length ? '検出あり' : '検出なし',
    ...(issues.length ? { count: issues.length } : {}), lines,
  });
  return { verified: code === 0, ...(daysLeft === undefined ? {} : { daysLeft }), ...(protocol ? { protocol } : {}) };
}

async function headRequest(target: UrlTarget, signal: AbortSignal): Promise<ProcessRun> {
  return runProcess('curl', ['--disable', '--globoff', '--head', '--silent', '--show-error', '--proto', '=http,https',
    '--max-time', '15', '--', target.url.href], signal, { timeoutMs: HTTP_TIMEOUT_MS, maxBytes: 64 * 1024 });
}

async function getRequest(target: UrlTarget, signal: AbortSignal): Promise<ProcessRun> {
  // One GET carries the CORS probe, the body-content checks, and the header read when HEAD is
  // refused. Redirects are not followed, so no host other than the approved one is contacted.
  return runProcess('curl', ['--disable', '--globoff', '--silent', '--show-error', '--proto', '=http,https',
    '--max-time', '15', '--suppress-connect-headers', '--max-filesize', '262144', '--max-redirs', '0', '--dump-header', '-',
    '-H', 'Origin: https://modkh.invalid', '-H', 'Accept: text/html,application/xhtml+xml,*/*;q=0.5',
    '--', target.url.href], signal, { timeoutMs: HTTP_TIMEOUT_MS, maxBytes: 320 * 1024 });
}

async function optionsRequest(target: UrlTarget, signal: AbortSignal): Promise<ProcessRun> {
  return runProcess('curl', ['--disable', '--globoff', '--silent', '--show-error', '--proto', '=http,https',
    '--request', 'OPTIONS', '--max-time', '10', '--dump-header', '-', '--output', '/dev/null', '--', target.url.href],
    signal, { timeoutMs: 12_000, maxBytes: 32 * 1024 });
}

async function exposureProbes(target: UrlTarget, signal: AbortSignal): Promise<{ path: string; status?: string }[]> {
  const results: { path: string; status?: string }[] = [];
  for (const candidate of EXPOSURE_PATHS) {
    if (signal.aborted) break;
    const run = await runProcess('curl', ['--disable', '--globoff', '--head', '--silent', '--show-error', '--proto', '=http,https',
      '--max-time', '10', '--write-out', '\n%{http_code}', '--output', '/dev/null', '--', `${target.url.origin}/${candidate}`],
      signal, { timeoutMs: 12_000, maxBytes: 16 * 1024 });
    if (!run.started || run.aborted) break;
    results.push({ path: `/${candidate}`, status: /\n(\d{3})$/.exec(run.stdout)?.[1] });
  }
  return results;
}

interface HttpObservation {
  evidence?: ResponseEvidence;
  fields: [string, string][];
}

/** Union of two header blocks; the later block wins for duplicate names, order is preserved. */
function mergeFields(primary: readonly [string, string][], secondary: readonly [string, string][]): [string, string][] {
  const seen = new Set(primary.map(([key]) => key));
  return [...primary, ...secondary.filter(([key]) => !seen.has(key))];
}

async function httpChecks(target: UrlTarget, signal: AbortSignal, write: (text: string) => void): Promise<HttpObservation> {
  const head = await headRequest(target, signal);
  if (head.aborted) { writeCheck(write, { name: 'HTTP', status: '中断', lines: ['HEAD を中止しました。'] }); return { fields: [] }; }
  if (!head.started) { writeCheck(write, { name: 'HTTP', status: '未実行', lines: [missingMessage('curl')] }); return { fields: [] }; }
  if (head.timedOut) { writeCheck(write, { name: 'HTTP', status: '失敗', lines: ['HEAD が時間切れです。'] }); return { fields: [] }; }
  const headParsed = lastHeaderBlock(head.stdout);
  const https = target.url.protocol === 'https:';
  const lines: string[] = [];
  if (!headParsed.status) {
    lines.push(`HEAD で HTTP ステータスを読み取れませんでした（${oneLine(head.stderr || 'curl の出力なし')}）。`);
  } else if (https) {
    lines.push('HEAD: TLS 証明書を検証済み');
  }

  const issues: string[] = [];
  const get = await getRequest(target, signal);
  if (get.aborted) {
    writeCheck(write, { name: 'HTTP', status: '中断', lines: ['GET を中止しました。'] });
    return { fields: headParsed.fields };
  }
  if (!get.started) { writeCheck(write, { name: 'HTTP', status: '未実行', lines: [missingMessage('curl')] }); return { fields: headParsed.fields }; }
  if (get.timedOut) {
    writeCheck(write, { name: 'HTTP', status: '失敗', lines: ['GET が時間切れです。'] });
    return { fields: headParsed.fields };
  }
  // A GET is the request a browser makes, so its headers decide what a visitor actually receives.
  // HEAD is merged in as a fallback so a header that only HEAD returns is not called missing.
  const split = splitResponse(get.stdout);
  const parsed = { ...lastHeaderBlock(split.headers) };
  const status = parsed.status ?? headParsed.status;
  const fields = parsed.fields.length ? mergeFields(parsed.fields, headParsed.fields) : headParsed.fields;
  if (!status) {
    writeCheck(write, { name: 'HTTP', status: '失敗', lines: [...lines, 'HTTP ステータスを取得できませんでした。'] });
    return { fields };
  }
  lines.unshift(`HTTP ${status}`);

  for (const name of securityHeaders) {
    if (name === 'x-frame-options' && headerValue(fields, 'content-security-policy')?.includes('frame-ancestors')) {
      lines.push('X-Frame-Options: CSP の frame-ancestors で代替');
      continue;
    }
    const present = headerValue(fields, name) !== undefined;
    lines.push(`${name}: ${present ? 'あり' : 'なし'}`);
    if (!present) issues.push(`応答ヘッダー ${name} がありません。`);
  }
  if (https) {
    const hsts = headerValue(fields, 'strict-transport-security');
    lines.push(`Strict-Transport-Security: ${hsts ? 'あり' : 'なし'}`);
    if (!hsts) issues.push('HTTPS の応答に Strict-Transport-Security がありません。');
    else {
      const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
      if (maxAge < 15_552_000) issues.push(`Strict-Transport-Security の max-age が半年未満です (${maxAge})。`);
      if (!/includeSubDomains/i.test(hsts)) lines.push('Strict-Transport-Security: includeSubDomains なし');
    }
  }
  const csp = headerValue(fields, 'content-security-policy');
  if (csp) {
    if (csp.includes("'unsafe-inline'")) issues.push("Content-Security-Policy が 'unsafe-inline' を許可しています。");
    if (/(^|[\s;])\*($|[\s;])/.test(csp)) issues.push('Content-Security-Policy がワイルドカード * を許可しています。');
    if (!/frame-ancestors/.test(csp) && !headerValue(fields, 'x-frame-options')) issues.push('フレーム埋め込みを制限する指定がありません。');
  }
  const cookies = fields.filter(([key]) => key === 'set-cookie').map(([, value]) => value);
  for (const cookie of cookies) {
    const name = cookie.split('=', 1)[0].trim();
    const attrs = cookieAttributes(cookie);
    const lacking = [
      ...(https && !attrs.has('secure') ? ['Secure'] : []),
      ...(attrs.has('httponly') ? [] : ['HttpOnly']),
      ...(attrs.has('samesite') ? [] : ['SameSite']),
    ];
    if (lacking.length) issues.push(`Cookie ${name}: ${lacking.join(' / ')} がありません。`);
  }
  if (cookies.length) lines.push(`Set-Cookie: ${cookies.length}件（値は表示せず、属性だけを検査）`);

  const allowOrigin = headerValue(fields, 'access-control-allow-origin');
  if (allowOrigin === '*' || allowOrigin === 'https://modkh.invalid') {
    const credentials = headerValue(fields, 'access-control-allow-credentials');
    lines.push(`CORS: Access-Control-Allow-Origin ${allowOrigin}${credentials ? ' + Credentials' : ''}`);
    if (allowOrigin === '*' && credentials) issues.push('CORS が * と Credentials を同時に許可しています。');
    else if (allowOrigin === 'https://modkh.invalid') issues.push('CORS が任意の Origin をそのまま反映しています。');
  } else {
    lines.push('CORS: Access-Control-Allow-Origin なし');
  }

  const location = headerValue(fields, 'location');
  if (/^3\d\d$/.test(status) && location) {
    let shown = '解析できない Location';
    try {
      const next = new URL(location, target.url);
      shown = next.origin + next.pathname + (next.search ? '（クエリ非表示）' : '');
    } catch { /* keep the placeholder */ }
    lines.push(`リダイレクト先: ${shown}（追跡しない）`);
  }

  const body = split.body;
  if (body) {
    if (https && /(?:src|href|action)\s*=\s*["']http:\/\//i.test(body)) {
      issues.push('HTTPS の本文に http:// の読み込み（混在コンテンツ）があります。');
    }
    if (/^(?:5\d\d)$/.test(status) && /(?:stack trace|traceback|sql syntax|SQLException|at [\w$.]+\([^)]*:\d+\))/i.test(body)) {
      issues.push('サーバーが例外の詳細を応答本文に含めています。');
    }
  }

  if (!signal.aborted) {
    const options = await optionsRequest(target, signal);
    if (options.started && !options.aborted && !options.timedOut) {
      const allow = headerValue(lastHeaderBlock(options.stdout).fields, 'allow');
      if (allow) {
        lines.push(`OPTIONS Allow: ${oneLine(allow)}`);
        const risky = allow.split(',').map(value => value.trim().toUpperCase())
          .filter(value => ['PUT', 'DELETE', 'TRACE', 'PATCH'].includes(value));
        if (risky.length) issues.push(`応答が許可するメソッドに ${risky.join(', ')} があります。`);
      }
    }
  }

  if (!signal.aborted) {
    const probes = await exposureProbes(target, signal);
    if (probes.length) {
      lines.push(`公開パスの確認: ${probes.map(probe => `${probe.path} ${probe.status ?? '不明'}`).join(', ')}`);
      const found = probes.filter(probe => probe.status === '200').map(probe => probe.path);
      if (found.length) issues.push(`公開されない前提のパスが 200 を返します: ${found.join(', ')}`);
    }
  }

  const server = headerValue(fields, 'server');
  const poweredBy = headerValue(fields, 'x-powered-by');
  if (server) lines.push(`Server: ${oneLine(server)}`);
  if (poweredBy) lines.push(`X-Powered-By: ${oneLine(poweredBy)}`);

  writeCheck(write, {
    name: 'HTTP', status: issues.length ? '検出あり' : '検出なし',
    ...(issues.length ? { count: issues.length } : {}), lines: [...lines, ...issues],
  });
  // Use only a successful, complete GET for model observations. HEAD may have different headers.
  const evidence = get.code === 0 && !get.truncated && parsed.status && /^[2-5]\d\d$/.test(parsed.status)
    ? responseEvidence(Number(parsed.status), https, parsed.fields) : undefined;
  return { fields, evidence };
}

async function nucleiCheck(target: UrlTarget, signal: AbortSignal, write: (text: string) => void): Promise<void> {
  if (signal.aborted) return;
  const run = await runProcess('nuclei', ['-u', target.url.href, '-jsonl', '-silent', '-no-color', '-severity', 'medium,high,critical', '-disable-update-check'],
    signal, { timeoutMs: 120_000, maxBytes: 512 * 1024 });
  if (!run.started) {
    writeCheck(write, { name: 'nuclei', status: '未実行', lines: ['nuclei が見つかりません（未導入のため、テンプレート検査だけを省略しました）。'] });
    return;
  }
  if (run.aborted) { writeCheck(write, { name: 'nuclei', status: '中断', lines: ['テンプレート検査を中止しました。'] }); return; }
  if (run.truncated) {
    writeCheck(write, { name: 'nuclei', status: '失敗', lines: ['出力が上限を超えたため、結果を採用しません。'] });
    return;
  }
  const findings: string[] = [];
  for (const line of run.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const item = JSON.parse(line) as { 'template-id'?: string; 'matched-at'?: string; info?: { name?: string; severity?: string } };
      findings.push(`${item['template-id'] ?? 'template'} [${item.info?.severity ?? '?'}] ${item.info?.name ?? ''} ${item['matched-at'] ?? ''}`);
    } catch { /* a partial line is not a finding */ }
  }
  if (run.timedOut) {
    writeCheck(write, { name: 'nuclei', status: '失敗', lines: ['時間切れです。取得済みの結果は採用しません。'] });
    return;
  }
  // Nuclei exits 1 when it has no templates to run. That is 未実行, not a failed scan of the target.
  if (/no templates provided/i.test(`${run.stdout}${run.stderr}`) || /no templates (?:were )?found/i.test(run.stderr)) {
    writeCheck(write, { name: 'nuclei', status: '未実行',
      lines: ['nuclei のテンプレートが未導入のため、テンプレート検査を実行できませんでした。',
        `導入する場合: nuclei -update-templates（その後に /cyber ${displayUrl(target)} を再実行）`] });
    return;
  }
  if (run.code !== 0 && findings.length === 0) {
    writeCheck(write, { name: 'nuclei', status: '失敗', lines: [`終了コード ${run.code ?? '不明'} で結果を取得できませんでした。`, oneLine(run.stderr)] });
    return;
  }
  writeCheck(write, {
    name: 'nuclei', status: findings.length ? '検出あり' : '検出なし',
    ...(findings.length ? { count: findings.length } : {}),
    lines: findings.length ? findings.map(value => oneLine(value)) : ['対象のテンプレートに該当しませんでした。'],
  });
}

/** What the URL side learned, so the source section can be read next to it. */
export interface UrlFacts {
  display: string;
  evidence?: ResponseEvidence;
  server?: string;
  poweredBy?: string;
  tls?: { verified: boolean; daysLeft?: number; protocol?: string };
}

/** Run every URL check in order; an interruption stops the list instead of starting the next tool. */
export async function runUrlChecks(target: UrlTarget, cwd: string, signal: AbortSignal, write: (text: string) => void): Promise<UrlFacts> {
  const facts: UrlFacts = { display: displayUrl(target) };
  await dnsCheck(target, signal, write);
  if (signal.aborted) return facts;
  const address = await resolveAddress(target, signal);
  await tcpPortCheck(target, address, cwd, signal, write);
  if (signal.aborted) return facts;
  await portSweep(address, cwd, signal, write);
  if (signal.aborted) return facts;
  facts.tls = await tlsCheck(target, signal, write);
  if (signal.aborted) return facts;
  const http = await httpChecks(target, signal, write);
  if (signal.aborted) return facts;
  await nucleiCheck(target, signal, write);
  facts.evidence = http.evidence;
  const server = headerValue(http.fields, 'server');
  const poweredBy = headerValue(http.fields, 'x-powered-by');
  if (server) facts.server = server;
  if (poweredBy) facts.poweredBy = poweredBy;
  return facts;
}

export { displayUrl };
export type { UrlTarget };
export { parseCyberUrl } from './cyber-url.ts';
