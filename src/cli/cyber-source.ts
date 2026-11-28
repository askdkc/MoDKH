import { runProcess } from './cyber-process.ts';
import { oneLine, writeCheck, type CheckResult } from './cyber-report.ts';

const SOURCE_TIMEOUT_MS = 300_000;
const SOURCE_MAX_BYTES = 4 * 1024 * 1024;

/** One dependency vulnerability after merging Trivy and OSV-Scanner evidence. */
interface DependencyFinding {
  /** `pkg:npm/lodash@4.17.20|CVE-2021-23337` — one row per package version and advisory. */
  key: string;
  pkg: string;
  version: string;
  id: string;
  severity?: string;
  fixed?: string;
  sources: Set<'Trivy' | 'OSV-Scanner'>;
}

function normalizePurl(purl: string | undefined): string {
  if (!purl) return '';
  return purl.replace(/\?.*$/, '');
}

/** Prefer the CVE identifier so the same advisory from two tools merges into one row. */
function canonicalId(ids: readonly string[]): string {
  const cve = [...ids].sort().find(id => /^CVE-\d{4}-\d+$/i.test(id));
  return cve ?? [...ids].sort()[0] ?? '';
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function objectAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'object' && found !== null ? found as Record<string, unknown> : undefined;
}

function arrayAt(value: unknown, key: string): unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  const found = (value as Record<string, unknown>)[key];
  return Array.isArray(found) ? found : [];
}

function stringAt(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  if (typeof found === 'string') return found;
  // Gitleaks writes StartLine as a JSON number, so accept both shapes.
  if (typeof found === 'number' && Number.isFinite(found)) return String(found);
  return undefined;
}

/** True when the scanner ran and produced a parseable report, regardless of findings. */
function reportProblem(name: string, code: number | null, stdout: string, stderr: string, allowed: readonly number[]): string | null {
  if (code === null) return `${name}: 終了コードを取得できませんでした（実行が完了していません）。`;
  if (allowed.includes(code)) return null;
  const reason = oneLine(stderr || stdout);
  return `${name}: 終了コード ${code} で完走しませんでした。${reason ? `（${reason}）` : ''}`;
}

/** Output beyond the cap has no usable verdict; say so instead of parsing a partial report. */
function truncationProblem(name: string, truncated: boolean): string | null {
  return truncated ? `${name}: 出力が上限を超えたため、結果を採用しません。` : null;
}

async function trivyScan(cwd: string, signal: AbortSignal, findings: Map<string, DependencyFinding>): Promise<CheckResult> {
  const run = await runProcess('trivy', ['fs', '--scanners', 'vuln', '--format', 'json', '--exit-code', '10', '--quiet', '--no-progress', '.'],
    signal, { cwd, timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: SOURCE_MAX_BYTES });
  if (!run.started) return { name: 'Trivy', status: '未実行', lines: ['trivy が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name: 'Trivy', status: '中断', lines: ['依存関係の検査を中止しました。'] };
  if (run.timedOut) return { name: 'Trivy', status: '失敗', lines: ['時間切れです。'] };
  const cut = truncationProblem('Trivy', run.truncated);
  if (cut) return { name: 'Trivy', status: '失敗', lines: [cut] };
  // 0 = no findings, 10 = findings. Anything else is an incomplete scan.
  const problem = reportProblem('Trivy', run.code, run.stdout, run.stderr, [0, 10]);
  if (problem) return { name: 'Trivy', status: '失敗', lines: [problem] };
  const report = parseJson(run.stdout);
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { name: 'Trivy', status: '失敗', lines: ['JSON を解析できませんでした。'] };
  const results = arrayAt(report, 'Results');
  const packages = results.reduce<number>((sum, entry) => sum + arrayAt(entry, 'Packages').length, 0);
  if (!results.length) {
    return { name: 'Trivy', status: '対象なし', lines: ['対応するパッケージ情報が見つかりませんでした（対象ファイル 0 件）。'] };
  }
  let count = 0;
  for (const result of results) {
    for (const vulnerability of arrayAt(result, 'Vulnerabilities')) {
      const pkg = stringAt(vulnerability, 'PkgName') ?? '';
      const version = stringAt(vulnerability, 'InstalledVersion') ?? '';
      const ids = [stringAt(vulnerability, 'VulnerabilityID') ?? '', ...arrayAt(vulnerability, 'VendorIDs').filter((id): id is string => typeof id === 'string')];
      const id = canonicalId(ids.filter(Boolean));
      if (!pkg || !id) continue;
      count++;
      const key = `${normalizePurl(stringAt(objectAt(vulnerability, 'PkgIdentifier'), 'PURL')) || `${pkg}@${version}`}|${id}`;
      const existing = findings.get(key);
      if (existing) { existing.sources.add('Trivy'); continue; }
      const finding: DependencyFinding = { key, pkg, version, id, sources: new Set(['Trivy']) };
      const severity = stringAt(vulnerability, 'Severity');
      const fixed = stringAt(vulnerability, 'FixedVersion');
      if (severity) finding.severity = severity;
      if (fixed) finding.fixed = fixed;
      findings.set(key, finding);
    }
  }
  return {
    name: 'Trivy', status: count ? '検出あり' : '検出なし', ...(count ? { count } : {}),
    lines: count ? [`脆弱性 ${count} 件（パッケージ ${packages} 件を検査）`]
      : [`パッケージ ${packages} 件を検査し、既知の脆弱性はありませんでした。`],
  };
}

async function osvScan(cwd: string, signal: AbortSignal, findings: Map<string, DependencyFinding>): Promise<CheckResult> {
  const run = await runProcess('osv-scanner', ['scan', 'source', '-r', '--format', 'json', '.'],
    signal, { cwd, timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: SOURCE_MAX_BYTES });
  if (!run.started) return { name: 'OSV-Scanner', status: '未実行', lines: ['osv-scanner が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name: 'OSV-Scanner', status: '中断', lines: ['依存関係の検査を中止しました。'] };
  if (run.timedOut) return { name: 'OSV-Scanner', status: '失敗', lines: ['時間切れです。'] };
  const cut = truncationProblem('OSV-Scanner', run.truncated);
  if (cut) return { name: 'OSV-Scanner', status: '失敗', lines: [cut] };
  // 128 is "no package sources found": a complete run with nothing to inspect, not an error.
  if (run.code === 128 && /no package sources found/i.test(`${run.stdout}${run.stderr}`)) {
    return { name: 'OSV-Scanner', status: '対象なし', lines: ['対応するロックファイルなどが見つかりませんでした（対象ファイル 0 件）。'] };
  }
  const problem = reportProblem('OSV-Scanner', run.code, run.stdout, run.stderr, [0, 1]);
  if (problem) return { name: 'OSV-Scanner', status: '失敗', lines: [problem] };
  const report = parseJson(run.stdout);
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { name: 'OSV-Scanner', status: '失敗', lines: ['JSON を解析できませんでした。'] };
  const results = arrayAt(report, 'results');
  if (!results.length) {
    return { name: 'OSV-Scanner', status: '対象なし', lines: ['対応するパッケージ情報が見つかりませんでした（対象ファイル 0 件）。'] };
  }
  const added: string[] = [];
  const files = new Set<string>();
  let count = 0;
  for (const result of results) {
    const path = stringAt(objectAt(result, 'source'), 'path');
    if (path) files.add(path.slice(path.lastIndexOf('/') + 1));
    for (const entry of arrayAt(result, 'packages')) {
      const pkgInfo = objectAt(entry, 'package');
      const pkg = stringAt(pkgInfo, 'name') ?? '';
      const version = stringAt(pkgInfo, 'version') ?? '';
      const purl = normalizePurl(stringAt(pkgInfo, 'purl')) || `${pkg}@${version}`;
      for (const group of arrayAt(entry, 'groups')) {
        const ids = arrayAt(group, 'ids').filter((id): id is string => typeof id === 'string');
        const aliases = arrayAt(group, 'aliases').filter((id): id is string => typeof id === 'string');
        const id = canonicalId([...ids, ...aliases]);
        if (!pkg || !id) continue;
        count++;
        const key = `${purl}|${id}`;
        const existing = findings.get(key);
        if (existing) { existing.sources.add('OSV-Scanner'); continue; }
        const finding: DependencyFinding = { key, pkg, version, id, sources: new Set(['OSV-Scanner']) };
        const severity = stringAt(group, 'max_severity');
        if (severity) finding.severity = severity;
        findings.set(key, finding);
      }
    }
  }
  const scope = files.size ? `対象: ${[...files].slice(0, 4).join(', ')}${files.size > 4 ? ` ほか${files.size - 4}件` : ''}` : '';
  return {
    name: 'OSV-Scanner', status: count ? '検出あり' : '検出なし', ...(count ? { count } : {}),
    lines: count ? [`OSV の勧告 ${count} 件`, ...(scope ? [scope] : [])] : ['既知の勧告に該当するパッケージはありませんでした。'],
  };
}

async function semgrepScan(cwd: string, signal: AbortSignal): Promise<CheckResult> {
  const run = await runProcess('semgrep', ['scan', '--config', 'p/default', '--metrics=off', '--disable-version-check', '--json', '--error', '.'],
    signal, { cwd, timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: SOURCE_MAX_BYTES });
  if (!run.started) return { name: 'Semgrep', status: '未実行', lines: ['semgrep が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name: 'Semgrep', status: '中断', lines: ['ソースコードの検査を中止しました。'] };
  if (run.timedOut) return { name: 'Semgrep', status: '失敗', lines: ['時間切れです。'] };
  const cut = truncationProblem('Semgrep', run.truncated);
  if (cut) return { name: 'Semgrep', status: '失敗', lines: [cut] };
  const report = parseJson(run.stdout);
  if (!report || !Array.isArray((report as { results?: unknown }).results)) {
    // Semgrep prints no JSON when the rules cannot be fetched; that is a failed scan, not clean source.
    return { name: 'Semgrep', status: '失敗', lines: [`結果を取得できませんでした（終了コード ${run.code ?? '不明'}）。`, oneLine(run.stderr)] };
  }
  const errors = arrayAt(report, 'errors');
  const results = arrayAt(report, 'results');
  const scanned = arrayAt(objectAt(report, 'paths'), 'scanned');
  // exit 1 means findings with --error; 0 means a clean run.
  if (run.code !== 0 && run.code !== 1) {
    const first = errors.length ? oneLine(JSON.stringify(errors[0])) : oneLine(run.stderr);
    return { name: 'Semgrep', status: '失敗', lines: [`終了コード ${run.code} で完走しませんでした。${first ? `（${first}）` : ''}`] };
  }
  if (!scanned.length && !errors.length && !results.length) {
    return { name: 'Semgrep', status: '対象なし', lines: ['検査対象のソースファイルが見つかりませんでした（対象ファイル 0 件）。'] };
  }
  const lines: string[] = [];
  for (const result of results) {
    const rule = stringAt(result, 'check_id') ?? '';
    const file = stringAt(result, 'path') ?? '';
    const line = objectAt(result, 'start');
    const lineNumber = line ? stringAt(line, 'line') ?? '' : '';
    const extra = objectAt(result, 'extra');
    const severity = extra ? stringAt(extra, 'severity') : undefined;
    const message = extra ? stringAt(extra, 'message') : undefined;
    const location = lineNumber ? `${file}:${lineNumber}` : file;
    lines.push(`${rule}${severity ? ` [${severity}]` : ''} ${location}${message ? ` — ${oneLine(message, 160)}` : ''}`);
  }
  if (errors.length) lines.push(`解析できなかったファイル: ${errors.length}件（${oneLine(JSON.stringify(errors[0]), 160)}）`);
  return {
    name: 'Semgrep', status: results.length ? '検出あり' : errors.length ? '一部未確認' : '検出なし', ...(results.length ? { count: results.length } : {}),
    lines: results.length || errors.length ? lines : [`対象ファイル ${scanned.length} 件を検査し、p/default のルールに該当しませんでした。`],
  };
}

async function gitleaksScan(cwd: string, signal: AbortSignal): Promise<CheckResult> {
  // --report-path - keeps the JSON on stdout; --redact=100 means the secret value never reaches us.
  const run = await runProcess('gitleaks', ['dir', '--redact=100', '--no-banner', '--no-color', '--report-format', 'json', '--report-path', '-', '--exit-code', '10', '.'],
    signal, { cwd, timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: SOURCE_MAX_BYTES });
  if (!run.started) return { name: 'Gitleaks', status: '未実行', lines: ['gitleaks が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name: 'Gitleaks', status: '中断', lines: ['秘密情報の検査を中止しました。'] };
  if (run.timedOut) return { name: 'Gitleaks', status: '失敗', lines: ['時間切れです。'] };
  const cut = truncationProblem('Gitleaks', run.truncated);
  if (cut) return { name: 'Gitleaks', status: '失敗', lines: [cut] };
  const problem = reportProblem('Gitleaks', run.code, '', '', [0, 10]);
  if (problem) return { name: 'Gitleaks', status: '失敗', lines: [problem] };
  const report = parseJson(run.stdout);
  if (!Array.isArray(report)) return { name: 'Gitleaks', status: '失敗', lines: ['JSON を解析できませんでした。'] };
  if (!report.length) {
    const scanned = /scanned ~?(\d+(?:\.\d+)?) (?:bytes|KB|MB)/i.exec(run.stderr);
    const size = scanned ? `${scanned[1]}${/KB/i.test(run.stderr) ? ' KB' : /MB/i.test(run.stderr) ? ' MB' : ' bytes'}` : '不明';
    return { name: 'Gitleaks', status: '検出なし', lines: [`走査したデータ量: ${size}。秘密情報の候補はありませんでした。`] };
  }
  const lines = report.map(entry => {
    const rule = stringAt(entry, 'RuleID') ?? '';
    const file = stringAt(entry, 'File') ?? '';
    const line = stringAt(entry, 'StartLine') ?? '';
    const description = stringAt(entry, 'Description');
    return `${rule} ${file}:${line}${description ? ` — ${oneLine(description, 140)}` : ''}（値は非表示）`;
  });
  return { name: 'Gitleaks', status: '検出あり', count: report.length, lines };
}

/** Render the merged dependency findings once, so a reader sees one row per advisory. */
function dependencyReport(findings: Map<string, DependencyFinding>): { count: number; lines: string[] } {
  const entries = [...findings.values()];
  if (!entries.length) return { count: 0, lines: [] };
  const lines = entries.map(finding => {
    const sources = [...finding.sources].sort().join(' + ');
    const severity = finding.severity ? ` [${finding.severity}]` : '';
    const fixed = finding.fixed ? ` → ${finding.fixed}` : '';
    return `${finding.pkg}@${finding.version} ${finding.id}${severity}${fixed}（${sources}）`;
  });
  const both = entries.filter(finding => finding.sources.size === 2).length;
  lines.push(`依存関係の指摘 ${entries.length} 件。Trivy と OSV-Scanner の両方が指摘した ${both} 件は1件として数えています。`);
  return { count: entries.length, lines };
}

export interface SourceScanResult {
  /** Findings that also appear in the URL-side facts, so the report can join the two. */
  total: number;
  lines: string[];
}

/** Run the four local scanners in the approved directory and report each verdict separately. */
export async function runSourceChecks(cwd: string, signal: AbortSignal, write: (text: string) => void, facts?: { server?: string; poweredBy?: string }, selected?: string): Promise<SourceScanResult> {
  const findings = new Map<string, DependencyFinding>();
  let total = 0;
  const lines: string[] = [];
  // Trivy and OSV-Scanner overlap; their rows merge into one dependency section after both ran.
  for (const [name, scan] of [['trivy', trivyScan], ['osv-scanner', osvScan]] as const) {
    if (signal.aborted || (selected && name !== selected)) continue;
    writeCheck(write, await scan(cwd, signal, findings));
  }
  const merged = dependencyReport(findings);
  if (merged.count) {
    writeCheck(write, { name: '依存関係（統合）', status: '検出あり', count: merged.count, lines: merged.lines });
    total += merged.count;
    lines.push(...merged.lines);
  }
  for (const [name, scan] of [['semgrep', semgrepScan], ['gitleaks', gitleaksScan]] as const) {
    if (selected && name !== selected) continue;
    if (signal.aborted) {
      writeCheck(write, { name: 'ソース検査', status: '中断', lines: ['残りのツールは起動しませんでした。'] });
      return { total, lines };
    }
    const result = await scan(cwd, signal);
    writeCheck(write, result);
    if (result.status === '検出あり') {
      total += result.count ?? 0;
      lines.push(...result.lines);
    }
  }
  if (facts && total > 0) {
    const hints: string[] = [];
    if (facts.poweredBy) hints.push(`X-Powered-By: ${oneLine(facts.poweredBy, 80)}`);
    if (facts.server) hints.push(`Server: ${oneLine(facts.server, 80)}`);
    writeCheck(write, {
      name: '照合', status: '情報',
      lines: [
        `ソース側 ${total} 件が本番にもあるかは、デプロイしたリビジョンとの照合で決まります。URL 側の検査は稼働中の応答だけを見ます。`,
        ...(hints.length ? [`本番の応答: ${hints.join(' / ')}`] : []),
      ],
    });
  }
  return { total, lines };
}
