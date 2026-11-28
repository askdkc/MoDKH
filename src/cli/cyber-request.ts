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
  quickPorts?: boolean;
  udpPorts?: string;
}

const FLAGS = ['source', 'udp-ports'] as const;
const SWITCHES = ['no-source', 'no-sqlmap', 'no-nmap', 'no-nikto', 'quick-ports'] as const;

export const HELP = [
  '使い方: /cyber <URL> [オプション]',
  '  /cyber https://example.com/app',
  '      ホストの点検: 1. ソース・依存関係・秘密情報  2. 公開ポート  3. Web 設定と SQL  4. 記録',
  '      ソースは現在のワークスペース。結果はホーム直下の security-audit.* に保存します。',
  '  --source <パス>      点検するチェックアウトを指定（ワークスペース内のディレクトリ）',
  '  --quick-ports        代表的な17ポートだけを走査（既定は全 TCP ポート。-p- は時間がかかります）',
  '  --udp-ports <一覧>   UDP も確認する（例: 53,443）',
  '  --no-source          Trivy・OSV-Scanner・Semgrep・Gitleaks を起動しない',
  '  --no-sqlmap          クエリ付き URL でも sqlmap を起動しない',
  '  --no-nmap            Nmap を起動しない  --no-nikto  Nikto を起動しない',
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
  request.noSource = takeSwitch('no-source');
  request.noSqlmap = takeSwitch('no-sqlmap');
  request.noNmap = takeSwitch('no-nmap');
  request.noNikto = takeSwitch('no-nikto');
  request.quickPorts = takeSwitch('quick-ports');
  if ((source !== undefined && !source) || (udpPorts !== undefined && !udpPorts)) return { kind: 'usage' };
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
