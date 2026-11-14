import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 8 * MAX_FILE_BYTES;
const MAX_FILES = 5000;
const MAX_HITS = 50;
const OUTPUT_BUDGET = 14 * 1024;
const EXCLUDED = new Set(['.git', 'node_modules', '.agenticreplay', 'dist', 'build', 'coverage', '.next', '.cache']);
interface Scan { skipped: number; mode: string }

/** Git owns ignore semantics; no handwritten approximation of .gitignore. No hooks or optional index writes. */
function* candidates(root: string, start: string, scan: Scan): Generator<string> {
  const relative = path.relative(root, start);
  let listing: string | undefined;
  try {
    listing = execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root,
      'ls-files', '-z', '--cached', '--others', '--exclude-standard',
      ...(relative ? ['--', `:(literal)${relative}/`] : [])], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
    });
    scan.mode = '.gitignore・Gitの除外設定を適用';
  } catch (error) {
    const e = error as { code?: string; stderr?: Buffer | string };
    if (e.code !== 'ENOENT' && !String(e.stderr).includes('not a git repository')) {
      throw new ToolError('SEARCH_FAILED', 'Gitによる検索対象の列挙に失敗しました。pathで対象を絞ってください');
    }
    scan.mode = 'Git管理外: .git/node_modules/.agenticreplay/dist/build/coverage/.next/.cache を除外';
  }
  if (listing !== undefined) {
    for (const name of [...new Set(listing.split('\0').filter(Boolean))].sort()) yield resolveInRoot(root, name);
  } else yield* walk(start, scan);
}
function* walk(directory: string, scan: Scan): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { scan.skipped++; return; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || EXCLUDED.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(file, scan);
    else if (entry.isFile()) yield file;
  }
}
function readSmallText(root: string, file: string): Buffer | undefined {
  assertRealInRoot(root, file);
  if (!fs.lstatSync(file).isFile()) return undefined;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, size) + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_FILE_BYTES) return undefined;
    const bytes = buffer.subarray(0, count);
    return bytes.includes(0) ? undefined : bytes;
  } finally { fs.closeSync(fd); }
}
function excerpt(line: string, at: number): string {
  if (line.length <= 400) return line;
  let start = Math.max(0, at - 100), end = Math.min(line.length, Math.max(at + 200, 400));
  if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start])) start--;
  if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1])) end++;
  return `${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''} [行の一部省略]`;
}

export const searchFilesTool: Tool = {
  readOnly: true,
  name: 'search_files',
  description: 'テキストを正規表現で検索する。Gitの除外設定を尊重し、最大50件・出力16 KiB。pathで対象を絞れる。省略がある場合は明示する。',
  parameters: { type: 'object', properties: {
    pattern: { type: 'string', maxLength: 512, description: '正規表現' },
    path: { type: 'string', description: '検索起点ディレクトリ（ルート相対）' },
  }, required: ['pattern'] },
  async execute(args, ctx) {
    if (typeof args.pattern !== 'string' || !args.pattern || args.pattern.length > 512) throw new ToolError('INVALID_ARGS', 'patternは1〜512文字の正規表現で指定する');
    let regex: RegExp;
    try { regex = new RegExp(args.pattern); }
    catch (e) { throw new ToolError('INVALID_ARGS', `patternが不正な正規表現: ${(e as Error).message}`); }
    const start = resolveInRoot(ctx.root, args.path ?? '.');
    assertRealInRoot(ctx.root, start);
    const scan: Scan = { skipped: 0, mode: '' }, hits: string[] = [];
    let files = 0, bytes = 0, outputBytes = 0, stopped = '';
    search: for (const file of candidates(ctx.root, start, scan)) {
      if (ctx.signal?.aborted) { stopped = '中断'; break; }
      if (++files > MAX_FILES || bytes >= MAX_SCAN_BYTES) { stopped = '探索上限（5,000ファイル・8 MiB）'; break; }
      let content: Buffer | undefined;
      try { content = readSmallText(ctx.root, file); }
      catch { scan.skipped++; continue; }
      if (!content) { scan.skipped++; continue; }
      bytes += content.length;
      if (bytes > MAX_SCAN_BYTES) { stopped = '読取上限8 MiB'; break; }
      const lines = content.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = regex.exec(lines[i]);
        if (!match) continue;
        const hit = `${path.relative(ctx.root, file)}:${i + 1}: ${excerpt(lines[i], match.index)}`;
        if (outputBytes + Buffer.byteLength(hit) + 1 > OUTPUT_BUDGET) { stopped = '出力上限16 KiB'; break search; }
        hits.push(hit); outputBytes += Buffer.byteLength(hit) + 1;
        if (hits.length >= MAX_HITS) { stopped = '上限50件'; break search; }
      }
    }
    return `検索 "${args.pattern}": ${hits.length} 件${stopped ? `で打ち切り（${stopped}）` : ''}\n対象: ${scan.mode}。1 MiB超・バイナリ・読取不可など${scan.skipped}件を除外。\n${hits.join('\n')}`;
  },
};
