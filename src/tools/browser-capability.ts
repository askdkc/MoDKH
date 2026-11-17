import fs from 'node:fs';
import path from 'node:path';

/** Discover an executable without launching it or assuming that its browser is connected. */
export function browserCapability(): string {
  const names = process.platform === 'win32' ? ['browse.exe', 'browse.cmd', 'browse.bat'] : ['browse'];
  const available = (process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)).some(dir =>
    names.some(name => {
      try {
        const file = path.join(dir, name);
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch { return false; }
    }));
  if (!available) return '';
  return '\nこのホストのPATHに browse CLI を検出しました（ブラウザ接続は未確認）。'
    + 'Web UIの操作・受け入れ検証ではまず browse --help と browse status --json で使い方と接続状態を確認してください。'
    + 'browse navigate / snapshot / click、browse execute --file <script.js> から実ブラウザを操作できます。'
    + 'browse execute は page などのPlaywright形式APIを提供するため、プロジェクトへのPlaywrightパッケージ導入は不要です。'
    + 'require.resolve("playwright") の失敗だけでブラウザ検証不能と判断しないでください。'
    + '利用可能な browse ツールは browse tools、個別の引数は browse <tool> --help で確認してください。'
    + '接続不能・権限不足はその事実を報告し、インストール・ペアリング・権限変更を勝手に行わないでください。'
    + 'ブラウザ内の送信や外部変更にもユーザーの承認範囲が適用されます。';
}
