import { DATASTORE_PORTS, EXPECTED_PUBLIC_PORTS, SERVICE_PORTS } from './cyber-ports-policy.ts';
import { oneLine, type Check } from './cyber-report.ts';
import { runTool } from './cyber-run.ts';
import { isIpv6, type ScanTarget } from './cyber-target.ts';
import type { Progress } from './cyber-progress.ts';

/**
 * One command's time budget. Every check here is "run, then read the result"; a
 * tool that has not answered within the budget is reported unfinished and the
 * run moves on to the next check instead of waiting.
 */
export interface StageOptions {
  target: ScanTarget;
  /** Address the host resolves to; absent means name resolution failed. */
  address?: string;
  timeoutMs: number;
  /** Only the URL's own port, instead of the representative list. */
  quickPorts: boolean;
  udpPorts?: string;
  signal: AbortSignal;
  store: { write(name: string, contents: string): string };
  progress: Progress;
  report(check: Check): void;
}

/** One port and the version line Nmap read for it. */
export interface ServicePort {
  port: string;
  service: string;
  version: string;
}

/**
 * Nmap's greppable port field is
 * port/state/protocol/owner/service/sunrpc/version/
 * so the version is the seventh field, not the one after the service.
 */
function parseGrepable(stdout: string): { port: string; state: string; service: string; version: string }[] {
  const line = stdout.split('\n').find(entry => entry.startsWith('Host:') && /\tPorts: /.test(entry));
  if (!line) return [];
  const ports = line.split('\tPorts: ')[1] ?? '';
  const result: { port: string; state: string; service: string; version: string }[] = [];
  for (const entry of ports.split(', ')) {
    const fields = entry.split('/');
    const port = fields[0];
    const state = fields[1];
    if (!port || !state) continue;
    result.push({ port, state, service: fields[4] ?? '', version: fields[6] ?? '' });
  }
  return result;
}

/** Lines an Nmap script block contributes, so a CVE line is kept as printed. */
function scriptLines(stdout: string): string[] {
  return stdout.split('\n')
    .map(line => line.replace(/^\|[_ ]?/, '').trim())
    .filter(line => line.length > 0);
}

/** Add the URL's own port to a list, keeping order and avoiding a duplicate. */
export function withTargetPort(list: string, port: string): string {
  const ports = list.split(',').map(entry => entry.trim()).filter(Boolean);
  if (!ports.includes(port)) ports.unshift(port);
  return ports.join(',');
}

function budget(options: StageOptions): number {
  return options.timeoutMs;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 1000)} 秒`;
}

/** A tool that ran out of time is unfinished, not a clean result. */
function unfinished(options: StageOptions, next: string): Check['lines'] {
  return [
    `${minutes(budget(options))}以内に応答がないため打ち切りました。${next}`,
    '取得できた範囲では判定していません。時間を延ばすか、対象ポートを絞って再実行してください。',
  ];
}

/**
 * Step 2: find out what software the site runs. A version scan answers that on
 * its own, and its result decides which ports the vulnerability probe uses.
 */
export async function runServiceStage(options: StageOptions): Promise<ServicePort[]> {
  const name = 'サービス特定（Nmap -sV）';
  const address = options.address;
  if (!address) {
    options.report({ name, status: '失敗', lines: [`${options.target.host} の IP アドレスを解決できませんでした。`] });
    return [];
  }
  if (isIpv6(address) && options.quickPorts) {
    // Keep the fast path simple; the full list still covers IPv6 with the -6 flag.
    options.report({ name, status: '未実行', lines: ['IPv6 では --quick-ports を省略しました。'] });
    return [];
  }
  // The URL's own port is always included: a site on 8080 or an unusual port would
  // otherwise look closed because the representative list does not name it.
  const list = options.quickPorts
    ? options.target.port
    : withTargetPort(SERVICE_PORTS, options.target.port);
  options.progress.start('サービス特定', `nmap -sV -p ${list}`);
  const run = await runTool('nmap',
    ['-n', '-Pn', '-sT', '-sV', '--version-light', '--max-rate', '50', '--reason',
      ...(isIpv6(address) ? ['-6'] : []), '-p', list, '-oG', '-', address],
    options.signal, { timeoutMs: budget(options), maxBytes: 2 * 1024 * 1024 });
  if (!run.started) {
    options.progress.done(name, '未実行');
    options.report({ name, status: '未実行', lines: ['nmap が見つかりません（PATH を確認してください）。'] });
    return [];
  }
  if (run.aborted) {
    options.progress.done(name, '中断');
    options.report({ name, status: '中断', lines: ['サービスの特定を中止しました。'] });
    return [];
  }
  if (run.timedOut) {
    options.progress.done(name, '一部未確認');
    options.report({ name, status: '一部未確認', lines: unfinished(options, '次の検査へ進みます。') });
    return [];
  }
  if (run.truncated || run.code !== 0) {
    options.progress.done(name, '失敗');
    options.report({
      name, status: '失敗',
      lines: [`終了コード ${run.code ?? '不明'} で結果を取得できませんでした。`, oneLine(run.stderr)],
    });
    return [];
  }
  options.store.write('nmap-services.txt', run.stdout);
  const found = parseGrepable(run.stdout);
  const open = found.filter(entry => entry.state === 'open');
  if (!open.length) {
    options.progress.done(name, '検出なし');
    options.report({ name, status: '検出なし', lines: [`${address} の走査範囲に開いているポートはありませんでした。`] });
    return [];
  }
  const services: ServicePort[] = open.map(entry => ({
    port: entry.port, service: entry.service, version: entry.version.trim() || entry.service,
  }));
  const datastores = open.filter(entry => DATASTORE_PORTS.has(entry.port));
  const unexpected = services.filter(entry => !EXPECTED_PUBLIC_PORTS.has(entry.port));
  const lines = services.map(entry =>
    `${entry.port}/tcp open ${entry.service}${entry.version !== entry.service ? ` ${entry.version}` : ''}`);
  if (unexpected.length) lines.push(`公開を想定していない開いているポート: ${unexpected.map(entry => entry.port).join(', ')}`);
  if (datastores.length) lines.push(`データストアのポートが公開されています: ${datastores.map(entry => entry.port).join(', ')}`);
  lines.push(`走査したポート: ${list}`);
  options.progress.done(name, datastores.length ? '検出あり' : '情報', datastores.length || undefined);
  options.report({
    name, status: datastores.length ? '検出あり' : '情報',
    ...(datastores.length ? { count: datastores.length } : {}), lines,
  });
  return services;
}

/**
 * Step 3: probe the software the site actually runs for its known
 * vulnerabilities. Nmap's `vuln` category is the CVE-backed probe that works
 * against a single URL; it is aimed at the ports the service scan identified.
 */
export async function runVulnerabilityStage(options: StageOptions, services: readonly ServicePort[]): Promise<void> {
  const name = '既知の脆弱性（Nmap --script vuln）';
  const address = options.address;
  if (!address) {
    options.report({ name, status: '失敗', lines: ['IP アドレスを解決できなかったため、脆弱性の検査を実行できません。'] });
    return;
  }
  // Only the URL's own port when nothing was identified, so the probe still covers the site.
  const portList = services.length
    ? [...new Set(services.map(entry => entry.port))].join(',')
    : options.target.port;
  const categories = options.quickPorts ? 'vuln' : 'vuln and not brute';
  options.progress.start('既知の脆弱性', `nmap --script ${categories} -p ${portList}`);
  const run = await runTool('nmap',
    ['-n', '-Pn', '-sT', '-sV', '--version-light', '--script', categories, '-p', portList,
      ...(isIpv6(address) ? ['-6'] : []), '-oN', '-', address],
    options.signal, { timeoutMs: budget(options), maxBytes: 2 * 1024 * 1024 });
  if (!run.started) {
    options.progress.done(name, '未実行');
    options.report({ name, status: '未実行', lines: ['nmap が見つかりません（PATH を確認してください）。'] });
    return;
  }
  if (run.aborted) {
    options.progress.done(name, '中断');
    options.report({ name, status: '中断', lines: ['脆弱性の検査を中止しました。'] });
    return;
  }
  if (run.timedOut) {
    options.progress.done(name, '一部未確認');
    options.report({ name, status: '一部未確認', lines: unfinished(options, '次の検査へ進みます。') });
    return;
  }
  if (run.truncated) {
    options.progress.done(name, '失敗');
    options.report({ name, status: '失敗', lines: ['出力が上限を超えたため、結果を採用しません。'] });
    return;
  }
  options.store.write('nmap-vuln.txt', run.stdout);
  const lines = scriptLines(run.stdout);
  const cves = [...new Set(lines.flatMap(line => line.match(/CVE-\d{4}-\d{4,}/g) ?? []))];
  const vulnerable = lines.filter(line => /VULNERABLE/i.test(line));
  const executed = [...new Set(lines.filter(line => /^[a-z0-9-]+:$/.test(line)).map(line => line.replace(/:$/, '')))];
  if (!cves.length && !vulnerable.length) {
    const checked = executed.length
      ? `実行したスクリプト: ${executed.slice(0, 8).join(', ')}${executed.length > 8 ? ' ほか' : ''}`
      : '該当するスクリプトはありませんでした';
    options.progress.done(name, '検出なし');
    options.report({ name, status: '検出なし', lines: [`対象ポート ${portList} で CVE を伴う指摘はありませんでした。`, checked] });
    return;
  }
  const count = cves.length || vulnerable.length;
  options.progress.done(name, '検出あり', count);
  options.report({
    name, status: '検出あり', count,
    lines: [
      ...(cves.length ? [`CVE: ${cves.join(', ')}`] : []),
      ...vulnerable.slice(0, 10).map(line => oneLine(line, 200)),
      ...executed.slice(0, 10).map(script => `スクリプト: ${script}`),
      `対象ポート: ${portList}`,
      'Nmap の vuln カテゴリは既知 CVE を対象にした検査です。指摘は実際の版とベンダーの情報で裏づけてください。',
    ],
  });
}

/** Optional UDP check, kept because `open|filtered` must never be reported as open. */
export async function runUdpStage(options: StageOptions): Promise<void> {
  const name = 'UDP ポート';
  const address = options.address;
  if (!address || !options.udpPorts) return;
  options.progress.start('UDP ポート', `nmap -sU -p ${options.udpPorts}`);
  const run = await runTool('nmap',
    ['-n', '-Pn', '-sU', '-p', options.udpPorts, '--max-rate', '10', '--reason',
      ...(isIpv6(address) ? ['-6'] : []), '-oG', '-', address],
    options.signal, { timeoutMs: budget(options), maxBytes: 512 * 1024 });
  if (!run.started) {
    options.progress.done(name, '未実行');
    options.report({ name, status: '未実行', lines: ['nmap が見つかりません。'] });
    return;
  }
  if (run.aborted) {
    options.progress.done(name, '中断');
    options.report({ name, status: '中断', lines: ['UDP の確認を中止しました。'] });
    return;
  }
  if (run.timedOut || run.truncated || run.code !== 0) {
    options.progress.done(name, '一部未確認');
    options.report({
      name, status: '一部未確認',
      lines: [`${minutes(budget(options))}以内に結果を取得できませんでした。`, oneLine(run.stderr)],
    });
    return;
  }
  options.store.write('nmap-udp.txt', run.stdout);
  const entries = parseGrepable(run.stdout);
  const open = entries.filter(entry => entry.state === 'open');
  const uncertain = entries.filter(entry => entry.state === 'open|filtered');
  options.progress.done(name, '情報');
  options.report({
    name, status: '情報',
    lines: [
      ...(open.length
        ? open.map(entry => `${entry.port}/udp open`)
        : [`${options.udpPorts} に開いている UDP ポートはありませんでした。`]),
      ...(uncertain.length
        ? [`open|filtered: ${uncertain.map(entry => entry.port).join(', ')}（開いていると確定したわけではありません）`]
        : []),
    ],
  });
}
