import { oneLine, type Check } from './cyber-report.ts';
import { runTool } from './cyber-run.ts';
import type { Progress } from './cyber-progress.ts';
import { toolUrl, type ScanTarget } from './cyber-target.ts';
import type { ServicePort } from './cyber-ports.ts';

/**
 * Step 4: what the service scan found decides what else to look up. Two
 * independent engines are used, so a host with no matching CVE template still
 * gets the exploit-database view:
 *
 * - nuclei selects templates by the product names the scan read (`nginx`, `php`)
 *   and runs them against the URL, so a match is about this site's real stack.
 * - searchsploit queries the local Exploit-DB copy for product and version,
 *   which is the version-specific angle nuclei's templates do not cover.
 *
 * Both are optional: a missing binary is 未実行, never 検出なし.
 */
export interface FollowUpOptions {
  target: ScanTarget;
  services: readonly ServicePort[];
  timeoutMs: number;
  signal: AbortSignal;
  store: { write(name: string, contents: string): string };
  progress: Progress;
  report(check: Check): void;
}

/** Products worth searching for, in the order the scan found them. */
export function productTags(services: readonly ServicePort[]): string[] {
  const tags: string[] = [];
  for (const entry of services) {
    // "nginx 1.31.8 (PHP 8.5.12)" and the service label both carry a product name.
    const text = `${entry.service} ${entry.version}`.toLowerCase();
    for (const [pattern, tag] of [
      [/nginx/, 'nginx'], [/apache|httpd/, 'apache'], [/caddy/, 'caddy'],
      [/php/, 'php'], [/tomcat/, 'tomcat'], [/iis|microsoft-httpapi/, 'iis'],
      [/openssh/, 'openssh'], [/openssl/, 'openssl'], [/postgresql/, 'postgresql'],
      [/mariadb|mysql/, 'mysql'], [/redis/, 'redis'], [/elasticsearch/, 'elasticsearch'],
      [/dnsmasq/, 'dnsmasq'], [/postfix|exim|smtp/, 'smtp'], [/vsftpd|proftpd|pure-ftpd/, 'ftp'],
      [/wordpress/, 'wordpress'], [/drupal/, 'drupal'], [/joomla/, 'joomla'],
      [/laravel/, 'laravel'], [/rails/, 'rails'], [/node\.?js|node/, 'nodejs'],
    ] as const) {
      if (pattern.test(text) && !tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

/** The Exploit-DB query: product plus version, dropping a parenthesised extra. */
export function searchTerm(services: readonly ServicePort[]): string | undefined {
  const first = services.find(entry => entry.version && entry.version !== entry.service);
  if (!first) return undefined;
  const cleaned = first.version.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || undefined;
}

/** nuclei prints one JSON object per match. */
function nucleiFindings(stdout: string): string[] {
  const findings: string[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const item = JSON.parse(line) as { 'template-id'?: string; 'matched-at'?: string; info?: { name?: string; severity?: string } };
      const id = item['template-id'] ?? 'template';
      const severity = item.info?.severity ? ` [${item.info.severity}]` : '';
      const name = item.info?.name ? ` ${oneLine(item.info.name, 120)}` : '';
      const at = item['matched-at'] ? ` ${oneLine(item['matched-at'], 160)}` : '';
      findings.push(`${id}${severity}${name}${at}`);
    } catch { /* a partial line is not a finding */ }
  }
  return findings;
}

async function nucleiCheck(options: FollowUpOptions, tags: readonly string[]): Promise<Check> {
  const name = 'nuclei（サービス別テンプレート）';
  options.progress.start(name, `-tags ${tags.join(',')}`);
  const run = await runTool('nuclei',
    ['-u', toolUrl(options.target), '-tags', tags.join(','),
      '-jsonl', '-silent', '-no-color', '-severity', 'medium,high,critical', '-disable-update-check'],
    options.signal, { timeoutMs: options.timeoutMs, maxBytes: 512 * 1024 });
  if (!run.started) {
    return { name, status: '未実行', lines: ['nuclei が見つかりません（未導入のため、テンプレート検査を省略しました）。'] };
  }
  if (run.aborted) return { name, status: '中断', lines: ['テンプレート検査を中止しました。'] };
  if (run.timedOut) {
    return { name, status: '一部未確認',
      lines: [`${Math.round(options.timeoutMs / 1000)} 秒以内に応答がないため打ち切りました。取得済みの結果は採用しません。`] };
  }
  if (run.truncated) return { name, status: '失敗', lines: ['出力が上限を超えたため、結果を採用しません。'] };
  // nuclei exits 1 when there is nothing to run; that is 未実行, not a clean site.
  if (/no templates/i.test(`${run.stdout}${run.stderr}`)) {
    return { name, status: '未実行',
      lines: ['nuclei のテンプレートが未導入です。`nuclei -update-templates` の後に再実行してください。',
        `対象のタグ: ${tags.join(', ')}`] };
  }
  const findings = nucleiFindings(run.stdout);
  options.store.write('nuclei.jsonl', run.stdout);
  if (!findings.length) {
    return { name, status: '検出なし', lines: [`タグ ${tags.join(', ')} のテンプレートに該当しませんでした。`] };
  }
  return { name, status: '検出あり', count: findings.length, lines: findings };
}

/** searchsploit --json prints one object with a RESULTS_EXPLOIT array. */
function searchsploitFindings(stdout: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return []; }
  const results = (parsed as { RESULTS_EXPLOIT?: unknown } | null)?.RESULTS_EXPLOIT;
  if (!Array.isArray(results)) return [];
  return results.slice(0, 20).map((entry) => {
    const record = entry as Record<string, unknown>;
    const title = typeof record.Title === 'string' ? record.Title : '?';
    const id = typeof record['EDB-ID'] === 'string' ? record['EDB-ID'] : '';
    const date = typeof record.Date === 'string' ? record.Date : '';
    return `${oneLine(title, 160)}${id ? ` (EDB-ID ${id})` : ''}${date ? ` ${date}` : ''}`;
  });
}

async function searchsploitCheck(options: FollowUpOptions, term: string): Promise<Check> {
  const name = 'searchsploit（Exploit-DB）';
  options.progress.start(name, term);
  const run = await runTool('searchsploit', ['--json', term], options.signal,
    { timeoutMs: options.timeoutMs, maxBytes: 512 * 1024 });
  if (!run.started) {
    return { name, status: '未実行',
      lines: ['searchsploit が見つかりません（Exploit-DB のローカル索引が未導入）。',
        '導入する場合: Homebrew の exploitdb、または Kali の searchsploit を PATH に置いてください。'] };
  }
  if (run.aborted) return { name, status: '中断', lines: ['Exploit-DB の検索を中止しました。'] };
  if (run.timedOut) {
    return { name, status: '一部未確認',
      lines: [`${Math.round(options.timeoutMs / 1000)} 秒以内に応答がないため打ち切りました。`] };
  }
  const findings = searchsploitFindings(run.stdout);
  options.store.write('searchsploit.json', run.stdout);
  if (!findings.length) {
    return { name, status: '検出なし', lines: [`「${term}」に一致する Exploit-DB の項目はありませんでした。`] };
  }
  return {
    name, status: '検出あり', count: findings.length,
    lines: [...findings, 'Exploit-DB は公開されている攻撃コードの索引です。該当する版かを実際の構成で確認してください。'],
  };
}

/** Step 4: dig further into what the service scan identified. */
export async function runFollowUpStage(options: FollowUpOptions): Promise<void> {
  const tags = productTags(options.services);
  const term = searchTerm(options.services);
  if (!tags.length && !term) {
    options.report({
      name: '追加調査', status: '未実行',
      lines: ['サービスと版を特定できなかったため、調べる対象を選べませんでした。'],
    });
    return;
  }
  options.progress.note(`特定したサービス: ${tags.length ? tags.join(', ') : '（名前は不明）'}`);

  if (!options.signal.aborted && tags.length) {
    const nuclei = await nucleiCheck(options, tags);
    options.progress.done(nuclei.name, nuclei.status, nuclei.count);
    options.report(nuclei);
  } else if (!options.signal.aborted) {
    options.report({
      name: 'nuclei（サービス別テンプレート）', status: '未実行',
      lines: ['サービス名を特定できなかったため、テンプレートを選べませんでした。'],
    });
  }

  if (!options.signal.aborted) {
    if (term) {
      const searchsploit = await searchsploitCheck(options, term);
      options.progress.done(searchsploit.name, searchsploit.status, searchsploit.count);
      options.report(searchsploit);
    } else {
      options.report({
        name: 'searchsploit（Exploit-DB）', status: '未実行',
        lines: ['版が分からなかったため、Exploit-DB を検索していません。'],
      });
    }
  }
}
