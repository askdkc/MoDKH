import path from 'node:path';
import fs from 'node:fs';
import { ToolError, type Tool, type ToolContext } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';

// ---------------------------------------------------------------------------
// list_files: ルート相対の1ディレクトリを一覧する(浅い)。
// ---------------------------------------------------------------------------

export const listFilesTool: Tool = {
  readOnly: true,
  name: 'list_files',
  description:
    'ディレクトリ直下のエントリを一覧する。path は作業ルート相対(省略時はルート)。再帰しない。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '一覧するディレクトリ(ルート相対)' },
    },
  },
  async execute(args, ctx) {
    const dir = resolveInRoot(ctx.root, args.path ?? '.');
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
// search_files: テキストファイルを再帰検索する。最大50件で打ち切る。
// ---------------------------------------------------------------------------

const SEARCH_LIMIT = 50;
const SEARCH_MAX_FILE_BYTES = 1 * 1024 * 1024;

export const searchFilesTool: Tool = {
  readOnly: true,
  name: 'search_files',
  description:
    'pattern(正規表現)でテキストファイルを再帰検索し、「パス:行: 行内容」を返す。path で起点を絞れる。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正規表現パターン' },
      path: { type: 'string', description: '検索起点ディレクトリ(ルート相対、既定はルート)' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
      throw new ToolError('INVALID_ARGS', 'pattern は空でない文字列で指定する');
    }
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern);
    } catch (e) {
      throw new ToolError('INVALID_ARGS', `pattern が不正な正規表現: ${(e as Error).message}`);
    }
    const startDir = resolveInRoot(ctx.root, args.path ?? '.');
    assertRealInRoot(ctx.root, startDir);
    const hits: string[] = [];
    let truncated = false;
    walk(ctx.root, startDir, (file) => {
      if (hits.length >= SEARCH_LIMIT) { truncated = true; return; }
      const lines = readTextLines(file);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          hits.push(`${displayRel(ctx.root, file)}:${i + 1}: ${lines[i].trimEnd()}`);
          if (hits.length >= SEARCH_LIMIT) { truncated = true; return; }
        }
      }
    });
    const head = truncated
      ? `${hits.length} 件で打ち切り(上限 ${SEARCH_LIMIT})`
      : `${hits.length} 件`;
    return `検索 "${args.pattern}": ${head}\n${hits.join('\n')}`;
  },
};

function walk(root: string, dir: string, visit: (file: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { walk(root, p, visit); continue; }
    if (e.isFile()) visit(p);
  }
}

function readTextLines(file: string): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (stat.size > SEARCH_MAX_FILE_BYTES) return [];
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

function displayRel(root: string, file: string): string {
  return path.relative(root, file);
}

// ---------------------------------------------------------------------------
// read_file: テキストを行番号付きで読む。offset(1開始)/limit(既定500)。
// ---------------------------------------------------------------------------

const READ_DEFAULT_LIMIT = 500;
const READ_MAX_FILE_BYTES = 2 * 1024 * 1024;

export const readFileTool: Tool = {
  readOnly: true,
  name: 'read_file',
  description:
    'テキストファイルを読む。offset(1開始行)と limit(既定500行)が使える。path はルート相対。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '読むファイル(ルート相対)' },
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
    const sliced = lines.slice(offset - 1, offset - 1 + limit);
    const body = sliced.map((l, i) => `${offset + i}: ${l}`).join('\n');
    return `${args.path} (${lines.length - 1}行中 ${offset}行目から${sliced.length}行)\n${body}`;
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
