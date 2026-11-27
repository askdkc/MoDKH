import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { readBundledSkill } from '../agent/bundled-skills.ts';
import type { ApprovalGate } from '../agent/types.ts';
import { runShellProcess } from '../tools/shell-process.ts';
import { displayUrl, parseCyberUrl, type UrlTarget } from './cyber-url.ts';
import { runUrlChecks, type UrlFacts } from './cyber-url-checks.ts';
import { runSourceChecks } from './cyber-source.ts';
import { oneLine, writeCheck } from './cyber-report.ts';

const sourceTools = ['trivy', 'osv-scanner', 'semgrep', 'gitleaks'] as const;

interface Check {
  name: string;
  version: string;
  scan?: string;
  findings?: number;
}

const localChecks: Check[] = [
  { name: 'trivy', version: '--version', scan: 'fs --scanners vuln --exit-code 10 .', findings: 10 },
  { name: 'osv-scanner', version: '--version', scan: 'scan source -r .', findings: 1 },
  { name: 'semgrep', version: '--version', scan: 'scan --config p/default --metrics=off --error .', findings: 1 },
  { name: 'gitleaks', version: 'version', scan: 'dir --redact=100 --no-banner --exit-code 10 .', findings: 10 },
  { name: 'sqlmap', version: '--version' },
  { name: 'nmap', version: '--version' },
];
const checks: Check[] = [...localChecks, { name: 'curl', version: '--version' }];

/** `/cyber <URL> [--source <path>] [--sqlmap-summary <file>]`, plus the existing mode selectors. */
export interface CyberRequest {
  kind: 'url' | 'help' | 'usage' | 'local';
  url?: string;
  source?: string;
  sqlmapSummary?: string;
  /** Existing `/cyber tools` and `/cyber <tool>` selection. */
  selected?: string;
}

export const HELP_USAGE = '使い方: /cyber <URL> [--source <パス>] [--sqlmap-summary <JSON>]\n'
  + '  /cyber <URL>: URL の DNS・ポート・TLS・HTTP ヘッダー・Cookie・公開パス・診断テンプレートを検査\n'
  + '  /cyber <URL> --source .: 上記に加えて、そのパスの依存関係・ソースコード・秘密情報も点検\n'
  + '  /cyber: 現在の作業ディレクトリを点検  /cyber tools [URL]: ツールの版を表示\n'
  + '  /cyber help: 説明  /cyber <' + checks.map(check => check.name).join(' | ') + '>\n'
  + 'URL はユーザー名やパスワードを含まない HTTP(S) のアドレスを1つ指定してください。\n'
  + '--source のパスはワークスペース内の実在するディレクトリに限ります。空白を含むパスも指定できます。\n';

const FLAG_PATTERN = /--(source|sqlmap-summary)\s+([\s\S]*?)(?=\s--(?:source|sqlmap-summary)(?:\s|$)|$)/g;

/**
 * Split the argument string without shell quoting rules: the values are ours, and a source path
 * may contain spaces, so a value runs to the next known flag or to the end of the line.
 */
export function parseCyberRequest(arg: string): CyberRequest {
  const text = arg.trim();
  if (!text) return { kind: 'local', selected: '' };
  if (text === 'help') return { kind: 'help' };
  const firstFlag = /(?:^|\s)--(source|sqlmap-summary)(?=\s|$)/.exec(text);
  const head = (firstFlag ? (firstFlag.index ? text.slice(0, firstFlag.index) : '') : text).trim();
  const flags: { name: string; value: string }[] = [];
  if (firstFlag) {
    const rest = text.slice(firstFlag.index).trim();
    for (const match of rest.matchAll(FLAG_PATTERN)) {
      const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
      if (!value) return { kind: 'usage' };
      flags.push({ name: match[1], value });
    }
    // Anything left after removing the recognised flags is a malformed option.
    const leftover = rest.replace(FLAG_PATTERN, '').trim();
    if (!flags.length || leftover.length > 0) return { kind: 'usage' };
  }
  const options: { source?: string; sqlmapSummary?: string } = {};
  for (const flag of flags) {
    if (flag.name === 'source') options.source = flag.value;
    else options.sqlmapSummary = flag.value;
  }
  const hasOptions = flags.length > 0;
  const legacy = /^tools(?:\s+([\s\S]+))?$/.exec(head);
  if (legacy) {
    const url = legacy[1]?.trim();
    if (!url) return hasOptions ? { kind: 'usage' } : { kind: 'local', selected: 'tools' };
    return hasOptions ? { kind: 'usage' } : { kind: 'url', url };
  }
  if (head && checks.some(check => check.name === head)) {
    return hasOptions ? { kind: 'usage' } : { kind: 'local', selected: head };
  }
  if (!head) return { kind: 'usage' };
  return { kind: 'url', url: head, ...options };
}

/**
 * A source path must be an existing directory inside the workspace after symlinks are resolved.
 * The check runs before approval so the prompt shows exactly what will be scanned.
 */
export function resolveSourcePath(cwd: string, input: string): { path?: string; error?: string } {
  const absolute = path.resolve(cwd, input);
  let real: string;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    return { error: `ソースのパスが存在しません: ${input}` };
  }
  let root: string;
  try { root = fs.realpathSync(cwd); } catch { root = path.resolve(cwd); }
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { error: `ワークスペース外のパスは点検しません: ${input}` };
  }
  let stat;
  try { stat = fs.statSync(real); } catch { return { error: `ソースのパスを読めません: ${input}` }; }
  if (!stat.isDirectory()) return { error: `ディレクトリではありません: ${input}` };
  return { path: real };
}

interface SqlmapSummary {
  target: string;
  date?: string;
  verdict: string;
  details?: string;
}

const SUMMARY_MAX_BYTES = 64 * 1024;

/** Read the documented external sqlmap summary, and only when it names the same URL. */
export function readSqlmapSummary(cwd: string, input: string, target: URL): { summary?: SqlmapSummary; error?: string } {
  const absolute = path.resolve(cwd, input);
  let real: string;
  try { real = fs.realpathSync(absolute); } catch { return { error: `要約ファイルが存在しません: ${input}` }; }
  let root: string;
  try { root = fs.realpathSync(cwd); } catch { root = path.resolve(cwd); }
  const relative = path.relative(root, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { error: `ワークスペース外の要約は読みません: ${input}` };
  let stat;
  try { stat = fs.statSync(real); } catch { return { error: `要約を読めません: ${input}` }; }
  if (!stat.isFile()) return { error: `要約がファイルではありません: ${input}` };
  if (stat.size > SUMMARY_MAX_BYTES) return { error: `要約が大きすぎます（上限 ${SUMMARY_MAX_BYTES} バイト）: ${input}` };
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(real, 'utf8')); } catch { return { error: `要約を JSON として読めません: ${input}` }; }
  if (typeof parsed !== 'object' || parsed === null) return { error: '要約は JSON オブジェクトで指定してください。' };
  const record = parsed as Record<string, unknown>;
  const url = typeof record.target === 'string' ? record.target : undefined;
  const verdict = typeof record.verdict === 'string' ? record.verdict : undefined;
  if (!url || !verdict) return { error: '要約には target と verdict が必要です。' };
  const summaryTarget = parseCyberUrl(url);
  if (!summaryTarget || summaryTarget.url.href !== target.href) {
    return { error: `要約の対象が一致しません（要約: ${url}）` };
  }
  const date = typeof record.date === 'string' ? record.date : undefined;
  const details = typeof record.details === 'string' ? record.details : undefined;
  return { summary: { target: url, verdict, ...(date ? { date } : {}), ...(details ? { details } : {}) } };
}

function writeSqlmapSummary(write: (text: string) => void, summary: SqlmapSummary): void {
  writeCheck(write, {
    name: 'sqlmap（外部診断）', status: '情報',
    lines: [
      `対象: ${summary.target}`,
      ...(summary.date ? [`診断日: ${summary.date}`] : []),
      `判定: ${oneLine(summary.verdict, 400)}`,
      ...(summary.details ? [`詳細: ${oneLine(summary.details, 400)}`] : []),
      '外部で実行した診断の要約です。MoDKH は sqlmap を起動していません。',
    ],
  });
}

/** Everything the approval prompt claims will happen, including what will NOT run. */
export function describeUrlPlan(target: UrlTarget, source: string | undefined): string {
  const lines = [
    `対象 URL: ${displayUrl(target)}`,
    `接続先ポート: ${target.port}/tcp`,
    'URL 側: DNS (dig) → Nmap（指定ポートと代表ポート）→ TLS (openssl) → HTTP (curl: HEAD/GET/OPTIONS、同一オリジンの固定パス) → nuclei（導入時のみ）',
    'リダイレクトは追跡しません。接続するのは対象ホストだけです。',
  ];
  if (source) {
    lines.push(`ソース: ${source}`);
    lines.push(`ソース側: ${sourceTools.join(' → ')}（子プロセスの作業ディレクトリはこのパス）`);
  } else {
    lines.push(`ソース側: 未実行（--source 未指定のため ${sourceTools.join(' / ')} を起動しません）`);
  }
  lines.push('Cookie の値と URL のクエリは表示しません。');
  return lines.join('\n');
}

/** The existing direct-check mode (`/cyber`, `/cyber tools`, `/cyber <tool>`). */
async function runDirectChecks(selected: string, cwd: string, approval: ApprovalGate, signal: AbortSignal, write: (text: string) => void): Promise<void> {
  const chosen = !selected ? localChecks : selected === 'tools' ? checks : checks.filter(check => check.name === selected);
  const plan = chosen.map(check => {
    const scan = selected !== 'tools' && check.scan;
    return { command: check.name + ' ' + (scan || check.version), findings: scan ? check.findings : undefined };
  });
  if (!await approval.approve({ kind: 'command', title: '/cyber ' + cwd,
    detail: plan.map(item => item.command).join('\n'), signal })) return;
  for (const { command, findings } of plan) {
    if (signal.aborted) break;
    write('$ ' + command + '\n');
    try {
      const result = await runShellProcess(command, cwd, signal, { timeoutMs: 180_000, maxOutputBytes: 24_000 });
      const status = result.timedOut ? '時間切れ' : result.signal ? '中断' : result.code === 0 ? '完了'
        : result.code === findings ? '検出あり' : '未確認';
      write(stripVTControlCharacters(result.stdout + result.stderr) + '\n' + status + ' (' + (result.signal ?? result.code) + ')\n');
    } catch (error) {
      write('未確認 (' + (error as Error).message + ')\n');
    }
  }
}

export async function runCyber(arg: string, cwd: string, approval: ApprovalGate, write: (text: string) => void) {
  if (arg === 'help') {
    write(readBundledSkill('cyber') + '\n' + HELP_USAGE);
    return;
  }
  const request = parseCyberRequest(arg);
  if (request.kind === 'usage') { write(HELP_USAGE); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  try {
    if (request.kind === 'local') {
      await runDirectChecks(request.selected ?? '', cwd, approval, controller.signal, write);
      return;
    }
    const target = parseCyberUrl(request.url ?? '');
    if (!target) { write(HELP_USAGE); return; }
    let source: string | undefined;
    if (request.source !== undefined) {
      const resolved = resolveSourcePath(cwd, request.source);
      if (resolved.error) { write(`${resolved.error}\n`); return; }
      source = resolved.path;
    }
    let summary: SqlmapSummary | undefined;
    if (request.sqlmapSummary !== undefined) {
      const read = readSqlmapSummary(cwd, request.sqlmapSummary, target.url);
      if (read.error) { write(`${read.error}\n`); return; }
      summary = read.summary;
    }
    if (!await approval.approve({ kind: 'command', title: '/cyber ' + displayUrl(target),
      detail: describeUrlPlan(target, source), outsideWorkspace: true, signal: controller.signal })
      || controller.signal.aborted) {
      write('(検査を開始しませんでした)\n');
      return;
    }
    write(`▶ URL: ${displayUrl(target)}\n`);
    const facts: UrlFacts = await runUrlChecks(target, cwd, controller.signal, write);
    if (source) {
      write(`\n▶ ソース: ${source}\n`);
      await runSourceChecks(source, controller.signal, write, facts);
    } else {
      writeCheck(write, {
        name: 'ソース検査', status: '未実行',
        lines: [
          `--source を指定していないため ${sourceTools.join(' / ')} を起動していません。`,
          `ソースも点検するには: /cyber ${displayUrl(target)} --source .`,
        ],
      });
    }
    if (summary) writeSqlmapSummary(write, summary);
    else writeCheck(write, { name: 'sqlmap', status: '未実行', lines: ['外部診断結果なし（--sqlmap-summary 未指定）。'] });
    write(controller.signal.aborted ? '(中断しました。以降の検査は開始していません)\n' : '(検査を終了しました)\n');
  } finally {
    process.off('SIGINT', stop);
  }
}
