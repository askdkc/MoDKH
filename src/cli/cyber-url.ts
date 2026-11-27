import { execFile, type ExecFileException } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { aborted, promisify } from 'node:util';
import type { ApprovalGate } from '../agent/types.ts';

const runFile = promisify(execFile);
const timeoutMs = 15_000;

export function parseCyberUrl(input: string): URL | null {
  if (input.length > 4096 || !/^https?:\/\/[^/?#]/i.test(input) || /[\s\\\p{Cc}]/u.test(input)) return null;
  const url = URL.parse(input);
  if (!url || url.username || url.password) return null;
  url.hash = '';
  return url;
}

function summarizeHeaders(stdout: string, https: boolean): string {
  // A proxy's CONNECT response or an informational response can precede the target's headers.
  const block = stdout.trimEnd().split(/\r?\n\r?\n/).at(-1) ?? '';
  const [statusLine, ...fields] = block.split(/\r?\n/);
  const status = /^HTTP\/[\d.]+\s+(\d{3})\b/.exec(statusLine)?.[1];
  if (!status) return '未確認: HTTP ステータスを読み取れませんでした。';
  const lines = [`HTTP ${status}`];
  if (https) lines.push('TLS 証明書: 検証済み');
  if (status === '405' || status === '501') {
    return [...lines, 'この URL では HEAD を利用できないため、ヘッダーは未確認です。'].join('\n');
  }
  const names = new Set(fields.map(field => field.split(':', 1)[0].toLowerCase()));
  const checks = ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy'];
  if (https) checks.push('Strict-Transport-Security');
  for (const name of checks) lines.push(`${name}: ${names.has(name.toLowerCase()) ? 'あり' : 'なし'}`);
  return lines.join('\n');
}

function describeCurlFailure(error: ExecFileException, signal: AbortSignal): string {
  if (signal.aborted) return '中断しました。';
  if (error.code === 'ENOENT') return '未確認: curl が見つかりません。PATH を確認してください。';
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return '未確認: 応答が出力の上限を超えました。';
  if (error.killed) return `時間切れ: ${timeoutMs / 1000}秒以内に応答を取得できませんでした。`;
  if (error.code === 60) return '未確認: TLS 証明書を検証できませんでした（curl 60）。';
  return `未確認: curl で応答を取得できませんでした（${error.code ?? error.signal ?? '原因不明'}）。`;
}

async function checkTcpPort(host: string, port: string, cwd: string, signal: AbortSignal): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    // Nmap accepts target expressions. Pass one resolved IP as its only target.
    const { address, family } = await Promise.race([
      lookup(host.replace(/^\[|\]$/g, '')),
      aborted(deadline, signal).then((): never => { throw deadline.reason; }),
    ]);
    deadline.throwIfAborted();
    const args = ['--unprivileged', '-sT', '-Pn', '-n', ...(family === 6 ? ['-6'] : []), '-p', port, '-oG', '-', address];
    const { stdout } = await runFile('nmap', args, { cwd, signal: deadline, maxBuffer: 64 * 1024 });
    const match = /^Host: [^\n]*?\tPorts: (\d+)\/([a-z|]+)\/tcp\//m.exec(stdout);
    return match?.[1] === port ? `Nmap (${address}): ${port}/tcp ${match[2]}` : 'Nmap: ポートの状態を確認できませんでした。';
  } catch (error) {
    if (signal.aborted) return 'Nmap: 中断しました。';
    if (deadline.aborted) return 'Nmap: 時間切れです。';
    const code = (error as ExecFileException).code;
    if (code === 'ENOENT') return 'Nmap: 未実行（nmap が PATH に見つかりません）。';
    return `Nmap: ポートを確認できませんでした（${code ?? '原因不明'}）。`;
  }
}

export async function runCyberUrl(target: URL, cwd: string, approval: ApprovalGate, signal: AbortSignal, write: (text: string) => void) {
  const display = target.origin + target.pathname + (target.search ? '（クエリ非表示）' : '');
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  const tcpTarget = `${target.hostname}:${port}`;
  const detail = `Nmap で ${tcpTarget} への TCP 接続を確認します。\ncurl で HEAD を1回送信します。\nHEAD ${display}`;
  if (!await approval.approve({ kind: 'command', title: '/cyber ' + display, detail, outsideWorkspace: true, signal }) || signal.aborted) return;
  write(`Nmap · TCP ${tcpTarget}\n`);
  write(await checkTcpPort(target.hostname, port, cwd, signal) + '\n');
  if (signal.aborted) return;
  write(`curl · HEAD ${display}\n`);
  try {
    const { stdout } = await runFile('curl', ['--disable', '--globoff', '--head', '--silent', '--proto', '=http,https', '--', target.href],
      { cwd, signal, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8' });
    write(summarizeHeaders(stdout, target.protocol === 'https:') + '\n');
  } catch (error) {
    write(describeCurlFailure(error as ExecFileException, signal) + '\n');
  }
}
