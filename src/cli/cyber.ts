import fs from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type { ApprovalGate } from '../agent/types.ts';
import { HELP, parseRequest } from './cyber-request.ts';
import { runServiceStage, runUdpStage, runVulnerabilityStage, type ServicePort } from './cyber-ports.ts';
import { SERVICE_PORTS } from './cyber-ports-policy.ts';
import { runFollowUpStage } from './cyber-followup.ts';
import { runSourceStage } from './cyber-source.ts';
import { runWebStage } from './cyber-web.ts';
import { displayTarget, parseTarget, type ScanTarget } from './cyber-target.ts';
import { writeRecord, writeSummary, type RecordedCheck } from './cyber-record.ts';
import { AuditDirectory, plannedAuditDirectory } from './cyber-store.ts';
import { createProgress } from './cyber-progress.ts';
import { oneLine, writeCheck, type Check } from './cyber-report.ts';

/** Every command gets this long to answer before the run moves on. */
export const DEFAULT_TIMEOUT_SEC = 60;

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
  /** Undefined when --source was not given: the URL side does not need a checkout. */
  source?: string;
  runSource: boolean;
  runNmap: boolean;
  runNikto: boolean;
  runSqlmap: boolean;
  runFollowUp: boolean;
  quickPorts: boolean;
  timeoutSec: number;
  udpPorts?: string;
}

function portList(quickPorts: boolean, target: ScanTarget): string {
  return quickPorts ? `URL のポート ${target.port} のみ` : SERVICE_PORTS;
}

/** What the approval prompt claims will happen, including what will not run. */
export function describePlan(target: ScanTarget, plan: Plan, directory: string): string {
  const seconds = plan.timeoutSec;
  const lines = [
    `対象 URL: ${displayTarget(target)}`,
    `接続先ポート: ${target.port}/tcp`,
    '接続先はこのホストだけで、リダイレクトは追跡しません。',
    '',
    '実行する検査:',
    plan.runSource
      ? `  1. ソース: ${plan.source}（Trivy → OSV-Scanner → Semgrep → Gitleaks 履歴 → Gitleaks ファイル）`
      : '  1. ソース: 起動しません（--source 未指定。URL 側の検査だけを実行）',
    plan.runNmap
      ? `  2. サービス特定: Nmap -sV（${portList(plan.quickPorts, target)}）`
      : '  2. サービス特定: Nmap は起動しません',
    plan.runNmap
      ? '  3. 既知の脆弱性: 特定したサービスのポートに Nmap --script vuln（CVE 単位）'
      : '  3. 既知の脆弱性: Nmap は起動しません',
    plan.runNikto
      ? '  4. Web 設定: Nikto（Tuning 2。実ユーザーの Cookie とデータは使わない）'
      : '  4. Web 設定: Nikto は起動しません',
    plan.runSqlmap ? '  5. SQL: sqlmap（稼働先、--smart、level 1 / risk 1）' : '  5. SQL: sqlmap は起動しません',
    plan.runFollowUp
      ? '  6. 追加調査: 特定したサービスの名前で nuclei（CVE テンプレート）、版で searchsploit（Exploit-DB）'
      : '  6. 追加調査: 起動しません',
    ...(plan.udpPorts ? [`  7. UDP: ${plan.udpPorts}（open|filtered は「確定していない」と表示）`] : []),
    '',
    `各コマンドの制限時間: ${seconds} 秒。応答がなければ打ち切り、次の検査へ進みます。`,
    '',
    '起動しない検査:',
  ];
  const skipped = [
    plan.runNmap ? undefined : 'Nmap（サービス特定と脆弱性スキャン）',
    plan.runNikto ? undefined : 'Nikto',
    plan.runSqlmap ? undefined : 'sqlmap',
    plan.runFollowUp ? undefined : '追加調査（nuclei / searchsploit）',
    plan.runSource ? undefined : 'ソース検査（Trivy / OSV-Scanner / Semgrep / Gitleaks）',
  ].filter((entry): entry is string => entry !== undefined);
  if (!skipped.length) lines.push('  なし');
  for (const entry of skipped) lines.push(`  ${entry}`);
  lines.push('', `結果はこの作業ディレクトリの ${directory} に保存します（0600）。`);
  lines.push('Cookie の値と URL のクエリは表示・保存しません。');
  return lines.join('\n');
}

export interface CyberRun {
  arg: string;
  cwd: string;
  approval: ApprovalGate;
  write(text: string): void;
  /** Live activity line for an interactive terminal. */
  activity?(text: string | null): void;
  /** Test seam: the audit root defaults to the working directory. */
  auditRoot?: string;
}

/**
 * `/cyber <URL>` — the Skill's checks against one host. A source checkout is
 * optional: without one the run identifies the running services, probes their
 * known vulnerabilities, investigates those services further and reports what
 * it found.
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
  let source: string | undefined;
  if (request.source !== undefined) {
    const resolved = resolveSource(cwd, request.source);
    if (resolved.error) { write(`${resolved.error}\n`); return; }
    source = resolved.path;
  }
  const plan: Plan = {
    ...(source ? { source } : {}),
    runSource: source !== undefined && !request.noSource,
    runNmap: !request.noNmap,
    runNikto: !request.noNikto,
    runSqlmap: !request.noSqlmap && target.hasQuery,
    runFollowUp: !request.noFollowUp,
    quickPorts: request.quickPorts === true,
    timeoutSec: request.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
    ...(request.udpPorts ? { udpPorts: request.udpPorts } : {}),
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  try {
    const auditRoot = run.auditRoot ?? cwd;
    // Show the exact destination before creating it: a denied prompt leaves nothing behind.
    const relative = path.relative(cwd, plannedAuditDirectory(auditRoot)) || plannedAuditDirectory(auditRoot);
    const approved = await approval.approve({
      kind: 'command',
      title: '/cyber ' + displayTarget(target),
      detail: describePlan(target, plan, relative),
      outsideWorkspace: true,
      signal: controller.signal,
    });
    if (!approved || controller.signal.aborted) {
      write('(検査を開始しませんでした)\n');
      return;
    }
    let store: AuditDirectory;
    try {
      store = new AuditDirectory(auditRoot);
    } catch (e) {
      write(`(レポートの保存先を作れません: ${(e as Error).message})\n`);
      return;
    }

    const startedAt = new Date().toISOString();
    const recorded: RecordedCheck[] = [];
    const progress = createProgress({ write, ...(run.activity ? { activity: run.activity } : {}) });
    // Number the stages as they run, so a skipped optional stage (UDP) leaves no gap.
    let stageNumber = 0;
    const stage = (title: string) => {
      stageNumber++;
      const name = `${stageNumber}. ${title}`;
      write(`\n▶ ${name}\n`);
      return (check: Check) => {
        writeCheck(write, check);
        recorded.push({ stage: name, check });
      };
    };
    store.write('plan.txt', [
      `対象 URL: ${displayTarget(target)}`,
      `接続先ポート: ${target.port}/tcp`,
      `ソース: ${source ?? '（未指定）'}`,
      `実行開始: ${startedAt}`,
      '',
      describePlan(target, plan, relative),
      '',
    ].join('\n'));
    write(`▶ URL: ${displayTarget(target)}\n`);
    write(`(結果の保存先: ${store.directory})\n`);

    const timeoutMs = plan.timeoutSec * 1000;
    const address = plan.runNmap || plan.udpPorts
      ? await resolveAddress(target.host, controller.signal) : undefined;
    const common = {
      target, ...(address ? { address } : {}),
      timeoutMs, quickPorts: plan.quickPorts,
      ...(plan.udpPorts ? { udpPorts: plan.udpPorts } : {}),
      signal: controller.signal, store, progress,
    };

    // Skill step 1 comes first: the checkout's own dependencies and secrets.
    // Without --source there is no checkout, so the step says so and the run
    // continues with the URL side only.
    const sourceReport = stage('ソース・依存関係・秘密情報');
    if (plan.runSource && source) {
      if (controller.signal.aborted) {
        sourceReport({ name: 'ソース検査', status: '中断', lines: ['ソース検査は開始していません。'] });
      } else {
        await runSourceStage({
          directory: source, timeoutMs, signal: controller.signal, store, progress, report: sourceReport,
        });
      }
    } else {
      sourceReport({
        name: 'ソース検査', status: '未実行',
        lines: [
          '--source でチェックアウトを指定していないため、Trivy / OSV-Scanner / Semgrep / Gitleaks を起動していません。',
          '依存関係や秘密情報も点検するには、そのサイトのチェックアウトで --source . を付けてください。',
          'このまま URL 側の検査（サービス特定・既知の脆弱性・Web 設定・SQL・追加調査）を続けます。',
        ],
      });
    }

    const serviceReport = stage('サービス特定');
    let services: ServicePort[] = [];
    if (!plan.runNmap) {
      serviceReport({
        name: 'サービス特定', status: '未実行',
        lines: ['--no-nmap が指定されたため、Nmap を起動していません。'],
      });
    } else if (controller.signal.aborted) {
      serviceReport({ name: 'サービス特定', status: '中断', lines: ['以降の検査は開始していません。'] });
    } else {
      services = await runServiceStage({ ...common, report: serviceReport });
    }

    const vulnReport = stage('既知の脆弱性');
    if (!plan.runNmap) {
      vulnReport({
        name: '既知の脆弱性', status: '未実行',
        lines: ['--no-nmap が指定されたため、脆弱性スキャンを起動していません。'],
      });
    } else if (controller.signal.aborted) {
      vulnReport({ name: '既知の脆弱性', status: '中断', lines: ['以降の検査は開始していません。'] });
    } else {
      await runVulnerabilityStage({ ...common, report: vulnReport }, services);
    }

    const webReport = stage('Web 設定と SQL');
    if (controller.signal.aborted) {
      webReport({ name: 'Web 検査', status: '中断', lines: ['以降の検査は開始していません。'] });
    } else {
      await runWebStage({
        target, timeoutMs, signal: controller.signal, store, progress, report: webReport,
      }, plan.runSqlmap);
    }

    const followUpReport = stage('追加調査');
    if (!plan.runFollowUp) {
      followUpReport({
        name: '追加調査', status: '未実行',
        lines: ['--no-followup が指定されたため、nuclei と searchsploit を起動していません。'],
      });
    } else if (controller.signal.aborted) {
      followUpReport({ name: '追加調査', status: '中断', lines: ['以降の検査は開始していません。'] });
    } else {
      await runFollowUpStage({
        target, services, timeoutMs, signal: controller.signal, store, progress, report: followUpReport,
      });
    }

    if (plan.udpPorts) {
      const udpReport = stage('UDP ポート');
      if (controller.signal.aborted) udpReport({ name: 'UDP ポート', status: '中断', lines: ['UDP の確認は開始していません。'] });
      else await runUdpStage({ ...common, report: udpReport });
    }

    stage('記録');
    // Tools that wrote their own report used the process umask; seal every path now.
    store.seal();
    const recordFile = store.write('record.md', writeRecord({
      target: displayTarget(target),
      port: target.port,
      host: target.host,
      source: source ?? '（未指定。URL 側の検査のみ）',
      startedAt,
      directory: store.directory,
      checks: recorded,
      aborted: controller.signal.aborted,
    }));

    // The run ends with what was found, not with a file path.
    for (const line of writeSummary({ checks: recorded, directory: store.directory, aborted: controller.signal.aborted })) {
      write(`${line}\n`);
    }
    writeCheck(write, {
      name: '記録', status: '情報',
      lines: [`record.md: ${oneLine(recordFile, 240)}`,
        `保存ファイル: ${fs.readdirSync(store.directory).sort().join(', ')}`],
    });
    write(controller.signal.aborted ? '(中断しました。以降の検査は開始していません)\n' : '(検査を終了しました)\n');
  } finally {
    process.off('SIGINT', stop);
  }
}
