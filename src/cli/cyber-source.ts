import { oneLine, type Check } from './cyber-report.ts';
import { runTool } from './cyber-run.ts';

const TIMEOUT_MS = 600_000;

/** Fields a secret scanner reports that must never be written or printed. */
const SECRET_FIELDS = new Set(['secret', 'match', 'line', 'lines', 'before', 'after']);

export interface SourceStageOptions {
  directory: string;
  signal: AbortSignal;
  store: { write(name: string, contents: string): string };
  report(check: Check): void;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayAt(value: unknown, key: string): unknown[] {
  const found = isRecord(value) ? value[key] : undefined;
  return Array.isArray(found) ? found : [];
}

function textAt(value: unknown, key: string): string | undefined {
  const found = isRecord(value) ? value[key] : undefined;
  return typeof found === 'string' ? found : typeof found === 'number' ? String(found) : undefined;
}

/**
 * Drop every value a scanner may echo from the source itself. A secret scanner
 * returns the matched text; keeping only identity fields means a saved report
 * can be handed to a colleague without leaking the key it found.
 */
export function redactSecrets(entry: unknown): Record<string, string> | null {
  if (!isRecord(entry)) return null;
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) continue;
    if (typeof value === 'string' || typeof value === 'number') kept[key] = String(value);
  }
  return Object.keys(kept).length ? kept : null;
}

/** 0/10 for the tools that exit non-zero on findings; anything else is an incomplete run. */
function exitProblem(name: string, code: number | null, stderr: string, allowed: readonly number[]): string | null {
  if (code === null) return `${name}: 終了コードを取得できませんでした。`;
  if (allowed.includes(code)) return null;
  const reason = oneLine(stderr);
  return `${name}: 終了コード ${code} で完走しませんでした。${reason ? `（${reason}）` : ''}`;
}

function truncation(name: string, truncated: boolean): string | null {
  return truncated ? `${name}: 出力が上限を超えたため、結果を採用しません。` : null;
}

async function trivy(options: SourceStageOptions): Promise<Check> {
  const run = await runTool('trivy',
    ['fs', '--scanners', 'vuln,misconfig', '--format', 'json', '--exit-code', '10', '--quiet', '--no-progress', '.'],
    options.signal, { cwd: options.directory, timeoutMs: TIMEOUT_MS });
  const name = 'Trivy';
  if (!run.started) return { name, status: '未実行', lines: ['trivy が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name, status: '中断', lines: ['依存関係と設定の検査を中止しました。'] };
  if (run.timedOut) return { name, status: '失敗', lines: ['時間切れです。'] };
  const cut = truncation(name, run.truncated);
  if (cut) return { name, status: '失敗', lines: [cut] };
  const problem = exitProblem(name, run.code, run.stderr, [0, 10]);
  if (problem) return { name, status: '失敗', lines: [problem] };
  const report = parseJson(run.stdout);
  if (!isRecord(report)) return { name, status: '失敗', lines: ['JSON を解析できませんでした。'] };
  options.store.write('trivy-fs.json', run.stdout);
  const results = arrayAt(report, 'Results');
  if (!results.length) return { name, status: '対象なし', lines: ['対応するパッケージや設定ファイルが見つかりませんでした。'] };
  const lines: string[] = [];
  let vulnerabilities = 0;
  let misconfigurations = 0;
  for (const result of results) {
    for (const item of arrayAt(result, 'Vulnerabilities')) {
      vulnerabilities++;
      const id = textAt(item, 'VulnerabilityID') ?? '?';
      const pkg = textAt(item, 'PkgName') ?? '?';
      const installed = textAt(item, 'InstalledVersion') ?? '?';
      const severity = textAt(item, 'Severity');
      const fixed = textAt(item, 'FixedVersion');
      lines.push(`${pkg}@${installed} ${id}${severity ? ` [${severity}]` : ''}${fixed ? ` → ${fixed}` : ''}`);
    }
    for (const item of arrayAt(result, 'Misconfigurations')) {
      misconfigurations++;
      const id = textAt(item, 'ID') ?? '?';
      const title = textAt(item, 'Title') ?? '';
      const severity = textAt(item, 'Severity');
      const location = isRecord(item) && isRecord(item.Location)
        ? `${textAt(item.Location, 'Filename') ?? ''}:${textAt(item.Location, 'StartLine') ?? ''}`
        : '';
      lines.push(`${id}${severity ? ` [${severity}]` : ''} ${oneLine(title, 120)} ${location}`.trimEnd());
    }
  }
  const count = vulnerabilities + misconfigurations;
  if (!count) {
    return { name, status: '検出なし', lines: [`対象 ${results.length} 件を検査し、既知の脆弱性・設定不備はありませんでした。`] };
  }
  return {
    name, status: '検出あり', count,
    lines: [`脆弱性 ${vulnerabilities} 件 / 設定不備 ${misconfigurations} 件`, ...lines.slice(0, 40),
      ...(lines.length > 40 ? [`ほか ${lines.length - 40} 件（保存した JSON を参照）`] : [])],
  };
}

async function osv(options: SourceStageOptions): Promise<Check> {
  const run = await runTool('osv-scanner', ['scan', 'source', '-r', '--format', 'json', '.'],
    options.signal, { cwd: options.directory, timeoutMs: TIMEOUT_MS });
  const name = 'OSV-Scanner';
  if (!run.started) return { name, status: '未実行', lines: ['osv-scanner が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name, status: '中断', lines: ['依存関係の検査を中止しました。'] };
  if (run.timedOut) return { name, status: '失敗', lines: ['時間切れです。'] };
  const cut = truncation(name, run.truncated);
  if (cut) return { name, status: '失敗', lines: [cut] };
  if (run.code === 128 && /no package sources found/i.test(`${run.stdout}${run.stderr}`)) {
    return { name, status: '対象なし', lines: ['ロックファイルなどパッケージ情報が見つかりませんでした。'] };
  }
  const problem = exitProblem(name, run.code, run.stderr, [0, 1]);
  if (problem) return { name, status: '失敗', lines: [problem] };
  const report = parseJson(run.stdout);
  if (!isRecord(report)) return { name, status: '失敗', lines: ['JSON を解析できませんでした。'] };
  options.store.write('osv.json', run.stdout);
  const results = arrayAt(report, 'results');
  if (!results.length) return { name, status: '対象なし', lines: ['パッケージ情報が見つかりませんでした。'] };
  const lines: string[] = [];
  for (const result of results) {
    for (const entry of arrayAt(result, 'packages')) {
      const pkg = isRecord(entry) ? entry.package : undefined;
      const packageName = textAt(pkg, 'name') ?? '?';
      const version = textAt(pkg, 'version') ?? '?';
      for (const group of arrayAt(entry, 'groups')) {
        const ids = [...arrayAt(group, 'ids'), ...arrayAt(group, 'aliases')]
          .filter((id): id is string => typeof id === 'string');
        const cve = ids.find(id => /^CVE-\d{4}-\d+$/i.test(id));
        const id = cve ?? ids[0];
        if (!id) continue;
        const severity = textAt(group, 'max_severity');
        lines.push(`${packageName}@${version} ${id}${severity ? ` [${severity}]` : ''}`);
      }
    }
  }
  if (!lines.length) return { name, status: '検出なし', lines: ['既知の勧告に該当するパッケージはありませんでした。'] };
  return {
    name, status: '検出あり', count: lines.length,
    lines: [...lines.slice(0, 40), ...(lines.length > 40 ? [`ほか ${lines.length - 40} 件（保存した JSON を参照）`] : [])],
  };
}

async function semgrep(options: SourceStageOptions): Promise<Check> {
  const run = await runTool('semgrep',
    ['scan', '--config', 'p/php', '--config', 'p/javascript', '--metrics=off', '--disable-version-check', '--json', '.'],
    options.signal, { cwd: options.directory, timeoutMs: TIMEOUT_MS });
  const name = 'Semgrep';
  if (!run.started) return { name, status: '未実行', lines: ['semgrep が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name, status: '中断', lines: ['ソースコードの検査を中止しました。'] };
  if (run.timedOut) return { name, status: '失敗', lines: ['時間切れです。'] };
  const cut = truncation(name, run.truncated);
  if (cut) return { name, status: '失敗', lines: [cut] };
  const report = parseJson(run.stdout);
  if (!isRecord(report) || !Array.isArray(report.results)) {
    return { name, status: '失敗', lines: [`結果を取得できませんでした（終了コード ${run.code ?? '不明'}）。`, oneLine(run.stderr)] };
  }
  options.store.write('semgrep.json', run.stdout);
  const results = arrayAt(report, 'results');
  const errors = arrayAt(report, 'errors');
  const scanned = arrayAt(isRecord(report.paths) ? report.paths : {}, 'scanned');
  const lines = results.map(result => {
    const rule = textAt(result, 'check_id') ?? '?';
    const file = textAt(result, 'path') ?? '';
    const line = isRecord(result) && isRecord(result.start) ? textAt(result.start, 'line') ?? '' : '';
    const extra = isRecord(result) ? result.extra : undefined;
    const severity = textAt(extra, 'severity');
    const message = textAt(extra, 'message');
    return `${rule}${severity ? ` [${severity}]` : ''} ${file}${line ? `:${line}` : ''}${message ? ` — ${oneLine(message, 160)}` : ''}`;
  });
  for (const error of errors) lines.push(`解析できなかったファイル: ${oneLine(JSON.stringify(error), 160)}`);
  if (!scanned.length && !results.length && !errors.length) {
    return { name, status: '対象なし', lines: ['検査対象のソースファイルが見つかりませんでした。'] };
  }
  if (results.length) return { name, status: '検出あり', count: results.length, lines };
  if (errors.length) return { name, status: '一部未確認', lines };
  return { name, status: '検出なし', lines: [`対象ファイル ${scanned.length} 件を検査し、p/php・p/javascript のルールに該当しませんでした。`] };
}

async function gitleaks(options: SourceStageOptions, mode: 'git' | 'dir'): Promise<Check> {
  const name = mode === 'git' ? 'Gitleaks（Git 履歴）' : 'Gitleaks（ファイル）';
  const args = mode === 'git'
    ? ['git', '--redact=100', '--no-banner', '--no-color', '--report-format', 'json', '--report-path', '-', '--exit-code', '10', '.']
    : ['dir', '--redact=100', '--no-banner', '--no-color', '--report-format', 'json', '--report-path', '-', '--exit-code', '10', '.'];
  const run = await runTool('gitleaks', args, options.signal, { cwd: options.directory, timeoutMs: TIMEOUT_MS });
  if (!run.started) return { name, status: '未実行', lines: ['gitleaks が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name, status: '中断', lines: ['秘密情報の検査を中止しました。'] };
  if (run.timedOut) return { name, status: '失敗', lines: ['時間切れです。'] };
  const cut = truncation(name, run.truncated);
  if (cut) return { name, status: '失敗', lines: [cut] };
  if (mode === 'git' && run.code !== 0 && run.code !== 10) {
    const reason = oneLine(run.stderr);
    if (/not a git repository/i.test(`${run.stdout}${run.stderr}`)) {
      return { name, status: '対象なし', lines: ['Git リポジトリではないため、履歴の検査は省略しました。'] };
    }
    return { name, status: '失敗', lines: [`終了コード ${run.code} で完走しませんでした。${reason ? `（${reason}）` : ''}`] };
  }
  const problem = mode === 'dir' ? exitProblem(name, run.code, run.stderr, [0, 10]) : null;
  if (problem) return { name, status: '失敗', lines: [problem] };
  const report = parseJson(run.stdout);
  if (!Array.isArray(report)) return { name, status: '失敗', lines: ['JSON を解析できませんでした。'] };
  const kept = report.map(redactSecrets).filter((entry): entry is Record<string, string> => entry !== null);
  options.store.write(mode === 'git' ? 'gitleaks-git.json' : 'gitleaks-dir.json', JSON.stringify(kept, null, 2));
  if (!kept.length) {
    return { name, status: '検出なし', lines: [mode === 'git'
      ? '手元に取得した Git 履歴に秘密情報の候補はありませんでした（検査範囲はフェッチ済みの履歴まで）。'
      : '現在のファイルに秘密情報の候補はありませんでした。'] };
  }
  const lines = kept.map(entry =>
    `${entry.RuleID ?? 'rule'} ${entry.File ?? '?'}:${entry.StartLine ?? '?'}${entry.Description ? ` — ${oneLine(entry.Description, 140)}` : ''}（値は非表示）`);
  return { name, status: '検出あり', count: kept.length, lines };
}

/**
 * Stage 1: dependencies, misconfiguration, code and secrets, in the checkout.
 * Each tool reports its own verdict; a missing tool is 未実行 and the run continues.
 */
export async function runSourceStage(options: SourceStageOptions): Promise<void> {
  const scans = [trivy, osv, semgrep];
  let completed = 0;
  for (const scan of scans) {
    if (options.signal.aborted) break;
    options.report(await scan(options));
    completed++;
  }
  for (const mode of ['git', 'dir'] as const) {
    if (options.signal.aborted) break;
    options.report(await gitleaks(options, mode));
    completed++;
  }
  if (options.signal.aborted && completed < scans.length + 2) {
    options.report({ name: 'ソース検査', status: '中断', lines: ['残りのツールは起動していません。'] });
  }
}
