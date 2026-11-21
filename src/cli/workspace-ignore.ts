import fs from 'node:fs';
import path from 'node:path';

/**
 * modkh がワークスペースに作る状態ディレクトリ。会話の成果物ではないので commit 対象にしない。
 * `.modkh/` はセッション記録とスキル設定、`.agenticreplay/` は通信記録。
 */
export const WORKSPACE_STATE_DIRS = ['.modkh', '.agenticreplay'] as const;

export interface WorkspaceIgnores {
  /** .gitignore に追加した行。既に揃っていれば空。 */
  added: string[];
  file: string;
}

/**
 * 1行がそのディレクトリを無視する記述か。
 * 先頭のスラッシュ、および先頭の二重アスタリスクとスラッシュの繰り返しは無視して比べる。
 * ルート直下を指す書き方が複数あるため、同じ意味の行を重ねて足さない。
 * 単一のアスタリスクで始まる行はルート直下に一致しないので、別の記述として扱う。
 */
function ignoresDir(line: string, dir: string): boolean {
  const pattern = line.trim();
  if (pattern.length === 0 || pattern.startsWith('#') || pattern.startsWith('!')) return false;
  return pattern.replace(/^(\*\*\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '') === dir;
}

/**
 * 書き込んでよい `.gitignore` を返す。dotfiles 管理のシンボリックリンクは、
 * リンク先がワークスペース内にあるときだけ辿る。ルート外のユーザーのファイルは書き換えない。
 */
function ignoreFileFor(root: string): string {
  const file = path.join(root, '.gitignore');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isFile()) return file;
  if (!stat.isSymbolicLink()) throw new Error('.gitignore が通常ファイルではありません');
  const real = fs.realpathSync(file);
  const inside = path.relative(fs.realpathSync(root), real);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error('.gitignore がワークスペース外を指しています');
  }
  if (!fs.statSync(real).isFile()) throw new Error('.gitignore が通常ファイルではありません');
  return file;
}

/**
 * `.git` があるワークスペースで、`.gitignore` に状態ディレクトリの行を揃える。
 *
 * - 既存の記述は書き換えない。欠けている行だけを末尾へ足すので、何度呼んでも増えない。
 * - `.git` が無いワークスペース(単なるディレクトリ)では何もしない(`undefined`)。
 *   `.git` はディレクトリでもファイル(worktree/submodule)でもよい。git本体は呼ばない。
 * - `.gitignore` がシンボリックリンクの場合は、リンク先がルート内にあるときだけ辿る。
 *   ルート外を指すリンクは書き換えず、例外で伝える(dotfiles 管理のリンクはルート内なら更新できる)。
 * - 書けない場合は例外を投げる。呼び出し元が会話を止めずに報告する。
 */
export function ensureWorkspaceIgnores(root: string): WorkspaceIgnores | undefined {
  if (!fs.statSync(path.join(root, '.git'), { throwIfNoEntry: false })) return undefined;
  const file = ignoreFileFor(root);

  const stat = fs.statSync(file, { throwIfNoEntry: false });
  const current = stat ? fs.readFileSync(file, 'utf8') : '';
  const lines = current.split(/\r?\n/);
  const added = WORKSPACE_STATE_DIRS
    .filter(dir => !lines.some(line => ignoresDir(line, dir)))
    .map(dir => `${dir}/`);
  if (added.length === 0) return { added, file };

  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const separator = current.length === 0 || current.endsWith('\n') ? '' : eol;
  fs.writeFileSync(file, `${current}${separator}${added.join(eol)}${eol}`, 'utf8');
  return { added, file };
}
