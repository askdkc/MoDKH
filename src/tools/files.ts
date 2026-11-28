import fs from 'node:fs';
import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';

// ---------------------------------------------------------------------------
// list_files: ルート相対の1ディレクトリを一覧する(浅い)。
// ---------------------------------------------------------------------------

export const listFilesTool: Tool = {
  readOnly: true,
  name: 'list_files',
  description:
    'ディレクトリ直下のエントリを一覧する。path は作業ルート相対(省略または空文字ならルート)。再帰しない。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '一覧するディレクトリ(ルート相対、ルートは .)' },
    },
  },
  async execute(args, ctx) {
    const requested = args.path ?? '';
    const dir = resolveInRoot(ctx.root, requested === '' ? '.' : requested);
    assertRealInRoot(ctx.root, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new ToolError('LIST_FAILED', `一覧できない: ${dir}: ${(e as Error).message}`);
    }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    const rows = entries.map((e) => {
      const suffix = e.isDirectory() ? '/' : '';
      return e.name + suffix;
    });
    return `作業場所: ${dir}\n${rows.length === 0 ? '(空)' : rows.join('\n')}`;
  },
};

// ---------------------------------------------------------------------------
// search_files: 除外設定と出力量の上限は専用モジュールが所有する。
// ---------------------------------------------------------------------------

export { searchFilesTool } from './search.ts';

const READ_DEFAULT_LIMIT = 500;
const READ_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Analysis is advisory: a failure is reported but never replaces the tool's own result. */
export async function safeAnalysis(run: () => Promise<string | null>): Promise<string> {
  try { return (await run()) ?? ''; }
  catch (e) { return `解析: 失敗 — ${e instanceof Error ? e.message : String(e)}（本文の操作は成功）`; }
}

// The same page may be requested with explicit defaults or a different relative spelling.
export function readPageKey(root: string, args: Record<string, unknown>): string | undefined {
  if (Object.keys(args).some(key => !['path', 'offset', 'limit'].includes(key))) return;
  try {
    return JSON.stringify([resolveInRoot(root, args.path), argPositiveInt(args.offset, 'offset') ?? 1,
      argPositiveInt(args.limit, 'limit') ?? READ_DEFAULT_LIMIT]);
  } catch { return; }
}

export const readFileTool: Tool = {
  readOnly: true,
  name: 'read_file',
  description:
    'テキストファイルを読む。offset(1開始行)と limit(既定500行)が使える。path はルート相対。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '読むファイル(ルート相対)' },
      purpose: { type: 'string', description: 'What you want to learn from this range, retained after compaction.' },
      full_text: { type: 'boolean', description: 'Include previously inspected unchanged lines when exact source text is needed.' },
      offset: { type: 'number', description: '開始行(1開始)' },
      limit: { type: 'number', description: '読む行数(既定500)' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const abs = resolveInRoot(ctx.root, args.path);
    assertRealInRoot(ctx.root, abs);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new ToolError('READ_FAILED', `読めないファイル: ${args.path}`);
    }
    if (stat.isDirectory()) {
      throw new ToolError('READ_FAILED', `ディレクトリは読めない: ${args.path}`);
    }
    if (stat.size > READ_MAX_FILE_BYTES) {
      throw new ToolError('READ_FAILED', `大きすぎるファイル(${stat.size}バイト): ${args.path}`);
    }
    const offset = argPositiveInt(args.offset, 'offset') ?? 1;
    const limit = argPositiveInt(args.limit, 'limit') ?? READ_DEFAULT_LIMIT;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const sliced = lines.slice(offset - 1, offset - 1 + limit);
    const body = sliced.map((l, i) => `${offset + i}: ${l}`).join('\n');
    const analysis = ctx.analyze ? await safeAnalysis(() => ctx.analyze!(abs, 'read')) : null;
    return `${args.path} (${lines.length}行中 ${offset}行目から${sliced.length}行)\n${body}${analysis ? `\n\n${analysis}` : ''}`;
  },
};

function argPositiveInt(v: unknown, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new ToolError('INVALID_ARGS', `${name} は1以上の整数`);
  }
  return n;
}
