import fs from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type { ApprovalGate } from '../agent/types.ts';
import { HELP, parseRequest } from './cyber-request.ts';
import { runPortStage } from './cyber-ports.ts';
import { SWEEP_PORTS } from './cyber-ports-policy.ts';
import { runSourceStage } from './cyber-source.ts';
import { runWebStage } from './cyber-web.ts';
import { displayTarget, parseTarget, type ScanTarget } from './cyber-target.ts';
import { writeRecord, type RecordedCheck } from './cyber-record.ts';
import { AuditDirectory } from './cyber-store.ts';
import { oneLine, writeCheck, type Check } from './cyber-report.ts';

/** A source path must be an existing directory inside the workspace after symlinks resolve. */
export function resolveSource(cwd: string, input: string): { path?: string; error?: string } {
  const absolute = path.resolve(cwd, input);
  let real: string;
  try { real = fs.realpathSync(absolute); } catch { return { error: `ソースのパスが存在しません: ${input}` }; }
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

/** The address Nmap contacts: the literal IP, else the first A/AAAA answer. */
async function resolveAddress(host: string, signal: AbortSignal): Promise<string | undefined> {
  if (isIP(host)) return host;
  if (signal.aborted) return undefined;
  try {
    const { address } = await lookup(host);
    return address;
  } catch {
    return undefined;
  }
}

export interface Plan {
  source: string;
  runSource: boolean;
  runSqlmap: boolean;
  runNmap: boolean;
  runNikto: boolean;
  quickPorts: boolean;
  udpPorts?: string;
}

/** What the approval prompt claims will happen, including what will not run. */
export function describePlan(target: ScanTarget, plan: Plan): string {
  const lines = [
    `対象 URL: ${displayTarget(target)}`,
    `接続先ポート: ${target.port}/tcp`,
    '接続先はこのホストだけで、リダイレクトは追跡しません。',
    '',
    '実行する検査:',
    plan.runSource
      ? `  1. ソース・依存関係・秘密情報: ${plan.source}（Trivy → OSV-Scanner → Semgrep → Gitleaks 履歴 → Gitleaks ファイル）`
      : '  1. ソース・依存関係・秘密情報: 起動しません',
    plan.runNmap
      ? `  2. 公開ポート: サーバー上の待ち受け（ss -lntup）→ Nmap ${plan.quickPorts ? `代表ポート ${SWEEP_PORTS}` : 'TCP 全ポート'}${plan.udpPorts ? ` → UDP ${plan.udpPorts}` : ''}`
      : '  2. 公開ポート: サーバー上の待ち受け（ss -lntup）だけ。Nmap は起動しません',
    plan.runNikto
      ? '  3. Web 設定: Nikto（Tuning 2、5分上限、実ユーザーの Cookie とデータは使わない）'
      : '  3. Web 設定: Nikto は起動しません',
    plan.runSqlmap ? '  4. SQL: sqlmap（稼働先、--smart、level 1 / risk 1）' : '  4. SQL: sqlmap は起動しません',
    '',
    '起動しない検査:',
  ];
  const skipped = [
    plan.runSource ? undefined : 'ソース検査（Trivy / OSV-Scanner / Semgrep / Gitleaks）',
    plan.runNmap ? undefined : 'Nmap のポート走査',
    plan.runNikto ? undefined : 'Nikto',
    plan.runSqlmap ? undefined : 'sqlmap',
  ].filter((entry): entry is string => entry !== undefined);
  if (!skipped.length) lines.push('  なし');
  for (const entry of skipped) lines.push(`  ${entry}`);
  lines.push('', '結果はリポジトリ外のホーム直下 security-audit.* に保存します。');
  lines.push('Cookie の値と URL のクエリは表示・保存しません。');
  return lines.join('\n');
}

export interface CyberRun {
  arg: string;
  cwd: string;
  approval: ApprovalGate;
  write(text: string): void;
  /** Test seam: where audit directories are created (default: the home directory). */
  auditRoot?: string;
}

/**
 * `/cyber <URL>` — the Skill's four steps against one host, plus an optional
 * source checkout. Nothing runs before the approval prompt lists the target,
 * the port, the checks and the ones that will be skipped.
 */
export async function runCyber(run: CyberRun): Promise<void> {
  const { arg, cwd, approval, write } = run;
  const request = parseRequest(arg);
  if (request.kind !== 'scan') { write(`${HELP}\n`); return; }
  const target = parseTarget(request.target ?? '');
  if (!target) {
    write('HTTP(S) のアドレスを1つ指定してください。ユーザー名やパスワードは指定できません。\n');
    write(`${HELP}\n`);
    return;
  }
  let source = cwd;
  if (request.source !== undefined) {
    const resolved = resolveSource(cwd, request.source);
    if (resolved.error) { write(`${resolved.error}\n`); return; }
    source = resolved.path!;
  }
  const plan: Plan = {
    source,
    runSource: !request.noSource,
    runSqlmap: !request.noSqlmap && target.hasQuery,
    runNmap: !request.noNmap,
    runNikto: !request.noNikto,
    quickPorts: request.quickPorts === true,
    ...(request.udpPorts ? { udpPorts: request.udpPorts } : {}),
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  try {
    const approved = await approval.approve({
      kind: 'command',
      title: '/cyber ' + displayTarget(target),
      detail: describePlan(target, plan),
      outsideWorkspace: true,
      signal: controller.signal,
    });
    if (!approved || controller.signal.aborted) {
      write('(検査を開始しませんでした)\n');
      return;
    }

    const store = new AuditDirectory(run.auditRoot);
    const startedAt = new Date().toISOString();
    const recorded: RecordedCheck[] = [];
    const stage = (name: string) => {
      write(`\n▶ ${name}\n`);
      return (check: Check) => {
        writeCheck(write, check);
        recorded.push({ stage: name, check });
      };
    };
    store.write('plan.txt', [
      `対象 URL: ${displayTarget(target)}`,
      `接続先ポート: ${target.port}/tcp`,
      `ソース: ${source}`,
      `実行開始: ${startedAt}`,
      '',
      describePlan(target, plan),
      '',
    ].join('\n'));
    write(`▶ URL: ${displayTarget(target)}\n`);
    write(`(結果の保存先: ${store.directory})\n`);

    const sourceReport = stage('1. ソース・依存関係・秘密情報');
    if (plan.runSource) {
      await runSourceStage({ directory: source, signal: controller.signal, store, report: sourceReport });
    } else {
      sourceReport({
        name: 'ソース検査', status: '未実行',
        lines: ['--no-source が指定されたため、Trivy / OSV-Scanner / Semgrep / Gitleaks を起動していません。'],
      });
    }

    const portReport = stage('2. 公開ポート');
    if (controller.signal.aborted) {
      portReport({ name: 'ポート検査', status: '中断', lines: ['以降の検査は開始していません。'] });
    } else {
      const address = await resolveAddress(target.host, controller.signal);
      await runPortStage({
        target, ...(address ? { address } : {}), source,
        quickPorts: plan.quickPorts, remote: plan.runNmap,
        ...(plan.udpPorts ? { udpPorts: plan.udpPorts } : {}),
        signal: controller.signal, store, report: portReport,
      });
    }

    const webReport = stage('3. Web 設定と SQL');
    if (controller.signal.aborted) {
      webReport({ name: 'Web 検査', status: '中断', lines: ['以降の検査は開始していません。'] });
    } else {
      await runWebStage({ target, signal: controller.signal, store, report: webReport }, plan.runSqlmap);
    }

    stage('4. 記録');
    // Tools that wrote their own report used the process umask; seal every path now.
    store.seal();
    const recordFile = store.write('record.md', writeRecord({
      target: displayTarget(target),
      port: target.port,
      host: target.host,
      source,
      startedAt,
      directory: store.directory,
      checks: recorded,
      aborted: controller.signal.aborted,
    }));
    const found = recorded.filter(entry => entry.check.status === '検出あり').length;
    const unresolved = recorded.filter(entry => ['未実行', '失敗', '一部未確認', '中断'].includes(entry.check.status)).length;
    writeCheck(write, {
      name: '記録', status: '情報',
      lines: [
        `検出あり ${found} 件 / 判定できなかった項目 ${unresolved} 件`,
        `保存ファイル: ${fs.readdirSync(store.directory).sort().join(', ')}`,
        `記録: ${oneLine(recordFile, 200)}`,
        '記録には対象・接続元・日時・検出内容・再検査手順を残しています。デプロイ版と修正内容を追記してください。',
      ],
    });
    write(controller.signal.aborted ? '(中断しました。以降の検査は開始していません)\n' : '(検査を終了しました)\n');
  } finally {
    process.off('SIGINT', stop);
  }
}
