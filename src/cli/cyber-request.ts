/**
 * The scan request as typed after `/cyber`.
 *
 * A value with spaces (a source path) runs to the next known flag, so no shell
 * quoting is needed. Unknown text is a usage error rather than a silent guess.
 */
export interface ScanRequest {
  kind: 'scan' | 'help' | 'usage';
  /** Raw URL argument; parsed later so a usage error never contacts the network. */
  target?: string;
  source?: string;
  noSource?: boolean;
  noSqlmap?: boolean;
  noNmap?: boolean;
  noNikto?: boolean;
  noFollowUp?: boolean;
  quickPorts?: boolean;
  udpPorts?: string;
  /** Per-command budget in seconds; the default is 60. */
  timeoutSec?: number;
}

const FLAGS = ['source', 'udp-ports', 'timeout'] as const;
const SWITCHES = ['no-source', 'no-sqlmap', 'no-nmap', 'no-nikto', 'no-followup', 'quick-ports'] as const;

/** The Skill's checks, plus what each needs, in the order they run. */
export const HELP = [
  '使い方: /cyber <URL> [オプション]',
  '  /cyber https://example.com/app',
  '      1. ソース: --source を指定したときだけ Trivy・OSV-Scanner・Semgrep・Gitleaks',
  '      2. サービス特定: Nmap -sV で稼働中のソフトウェアと版を調べる',
  '      3. 既知の脆弱性: 判明したサービスのポートに Nmap --script vuln（CVE 単位）',
  '      4. Web 設定: Nikto（Tuning 2） / 5. SQL: クエリ付き URL なら sqlmap',
  '      6. 追加調査: 判明したサービス名で nuclei、版で searchsploit（Exploit-DB）',
  '      7. 記録と、発見内容のまとめ',
  '      各コマンドは60秒で打ち切り、応答がなければ次の検査へ進みます。',
  '      実行中は何を走らせているかを表示し、終了時に発見内容をまとめて表示します。',
  '      結果はこの作業ディレクトリの .modkh/security-audit.* に保存します（0600）。',
  '  --source <パス>      チェックアウトも点検（既定では実行しません）',
  '  --timeout <秒>       1コマンドあたりの制限時間（既定 60）',
  '  --quick-ports        URL のポートだけを調べる（既定は代表的な35ポート＋URL のポート）',
  '  --udp-ports <一覧>   UDP も確認する（例: 53,443）',
  '  --no-nmap            サービスの特定と脆弱性スキャンを起動しない',
  '  --no-followup        追加調査（nuclei・searchsploit）を起動しない',
  '  --no-nikto           Nikto を起動しない  --no-sqlmap  sqlmap を起動しない',
  '  --no-source          --source を指定していてもソース検査を起動しない',
  '  /cyber help          この説明',
  '',
  'URL はユーザー名・パスワードを含まない HTTP(S) のアドレスを1つ指定します。',
  '接続先はそのホストだけで、リダイレクトは追跡しません。',
].join('\n');

/** Split the argument string into a target and options. */
export function parseRequest(argument: string): ScanRequest {
  const text = argument.trim();
  if (!text) return { kind: 'usage' };
  if (text === 'help' || text === '--help' || text === '-h') return { kind: 'help' };
  const request: ScanRequest = { kind: 'scan' };
  let rest = text;
  const takeFlag = (name: string): string | undefined => {
    const pattern = new RegExp(`(?:^|\\s)--${name}(?:\\s+|$)([\\s\\S]*?)(?=\\s--(?:${[...FLAGS, ...SWITCHES].join('|')})(?:\\s|$)|$)`);
    const match = pattern.exec(rest);
    if (!match) return undefined;
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`.trim();
    const value = match[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    return value;
  };
  const takeSwitch = (name: string): boolean => {
    const pattern = new RegExp(`(?:^|\\s)--${name}(?=\\s|$)`);
    if (!pattern.test(rest)) return false;
    rest = rest.replace(pattern, ' ').trim();
    return true;
  };

  const source = takeFlag('source');
  const udpPorts = takeFlag('udp-ports');
  const timeout = takeFlag('timeout');
  request.noSource = takeSwitch('no-source');
  request.noSqlmap = takeSwitch('no-sqlmap');
  request.noNmap = takeSwitch('no-nmap');
  request.noNikto = takeSwitch('no-nikto');
  request.noFollowUp = takeSwitch('no-followup');
  request.quickPorts = takeSwitch('quick-ports');
  if ((source !== undefined && !source) || (udpPorts !== undefined && !udpPorts)) return { kind: 'usage' };
  if (timeout !== undefined) {
    const seconds = Number(timeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) return { kind: 'usage' };
    request.timeoutSec = seconds;
  }
  if (udpPorts !== undefined) {
    const ports = udpPorts.split(',').map(Number);
    // A port list nmap would reject is a usage error, not a failed UDP check.
    if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)) return { kind: 'usage' };
  }
  if (source !== undefined) request.source = source;
  if (udpPorts !== undefined) request.udpPorts = udpPorts;
  // Anything left is either one URL or an unknown option.
  if (!rest || /\s/.test(rest) || /^--/.test(rest)) return { kind: 'usage' };
  request.target = rest;
  return request;
}
