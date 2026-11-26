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
    + '専用 browse ツールがある場合は status から始め、通常のページ操作は許可を求めずに実行してください。'
    + '専用ツールは status / navigate / snapshot / click / fill / screenshot / list を提供します。navigate 以外は snapshot が返した tab を渡し、ref は直前の snapshot のものを使います。'
    + '専用ツールに無い操作が必要なときだけ、browse --help と browse status --json で使い方を確認し、run_command の承認を得て browse CLI を実行します。browse execute --file <script.js> はPlaywright形式の page APIを使えるため、プロジェクトへのPlaywrightパッケージ導入は不要です。'
    + 'CLIで直接開いたタブは自動終了の対象外です。開いたタブのIDを控え、作業後に browse tabs close --tab <id> で自分が開いたものだけを閉じてください。'
    + 'require.resolve("playwright") の失敗だけでブラウザ検証不能と判断しないでください。'
    + '個別の引数は browse <tool> --help で確認してください。'
    + '接続不能・権限不足はその事実を報告し、インストール・ペアリング・権限変更を勝手に行わないでください。'
    + 'ブラウザ内の送信や外部変更にもユーザーの承認範囲が適用されます。';
}
