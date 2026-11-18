import fs from 'node:fs';
import path from 'node:path';

/** Discover an executable without launching it or assuming that its browser is connected. */
export function browseExecutable(): string | undefined {
  const name = process.platform === 'win32' ? 'browse.exe' : 'browse';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir))) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return fs.realpathSync(file);
    } catch { /* Not an installed executable. */ }
  }
  return undefined;
}

export function browserCapability(): string {
  if (!browseExecutable()) return '';
  return '\nこのホストのPATHに browse CLI を検出しました（ブラウザ接続は未確認）。'
    + '専用 browse ツールがある場合は status から始め、通常のページ操作は許可を求めずに実行してください。CLIでは browse --help と browse status --json で使い方と接続状態を確認できます。'
    + 'browse navigate / snapshot / click、browse execute --file <script.js> から実ブラウザを操作できます。'
    + '専用ツールで開いたタブは turn 終了時に自動で閉じます。CLIで直接開いたタブは、作業後に browse tabs close --tab <id> で自分が開いたものだけを閉じてください。'
    + 'browse execute は page などのPlaywright形式APIを提供するため、プロジェクトへのPlaywrightパッケージ導入は不要です。'
    + 'require.resolve("playwright") の失敗だけでブラウザ検証不能と判断しないでください。'
    + '利用可能な browse ツールは browse tools、個別の引数は browse <tool> --help で確認してください。'
    + '接続不能・権限不足はその事実を報告し、インストール・ペアリング・権限変更を勝手に行わないでください。'
    + 'ブラウザ内の送信や外部変更にもユーザーの承認範囲が適用されます。';
}
