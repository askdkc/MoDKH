import { stripVTControlCharacters } from 'node:util';
import { readBundledSkill } from '../agent/bundled-skills.ts';
import type { ApprovalGate } from '../agent/types.ts';
import { runShellProcess } from '../tools/shell-process.ts';
import { parseCyberUrl, runCyberUrl } from './cyber-url.ts';

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

export async function runCyber(arg: string, cwd: string, approval: ApprovalGate, write: (text: string) => void) {
  if (arg === 'help') {
    write(readBundledSkill('cyber') + '\n');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  try {
    const selected = !arg ? localChecks : arg === 'tools' ? checks : checks.filter(check => check.name === arg);
    if (!selected.length) {
      const target = parseCyberUrl(arg.replace(/^tools\s+/, ''));
      if (target) await runCyberUrl(target, cwd, approval, controller.signal, write);
      else write('使い方: /cyber <URL> | /cyber tools [URL] | /cyber [help | ' + checks.map(check => check.name).join(' | ') + ']\n'
        + 'URL はユーザー名やパスワードを含まない HTTP(S) のアドレスを1つ指定してください。\n');
      return;
    }
    const plan = selected.map(check => {
      const scan = arg !== 'tools' && check.scan;
      return { command: check.name + ' ' + (scan || check.version), findings: scan ? check.findings : undefined };
    });
    if (!await approval.approve({ kind: 'command', title: '/cyber ' + cwd,
      detail: plan.map(item => item.command).join('\n'), signal: controller.signal })) return;
    for (const { command, findings } of plan) {
      if (controller.signal.aborted) break;
      write('$ ' + command + '\n');
      try {
        const result = await runShellProcess(command, cwd, controller.signal, { timeoutMs: 180_000, maxOutputBytes: 24_000 });
        const status = result.timedOut ? '時間切れ' : result.signal ? '中断' : result.code === 0 ? '完了'
          : result.code === findings ? '検出あり' : '未確認';
        write(stripVTControlCharacters(result.stdout + result.stderr) + '\n' + status + ' (' + (result.signal ?? result.code) + ')\n');
      } catch (error) {
        write('未確認 (' + (error as Error).message + ')\n');
      }
    }
  } finally {
    process.off('SIGINT', stop);
  }
}
