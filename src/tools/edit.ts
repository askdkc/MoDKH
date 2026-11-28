import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';
import { renderDiff } from './diff.ts';
import { safeAnalysis } from './files.ts';

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string') {
    throw new ToolError('INVALID_ARGS', `${name} は文字列で指定する`);
  }
  return v;
}

/** 未作成部分も含む実際の作成先。等価な親ディレクトリの追加は対象変更にしない。 */
function creationTarget(root: string, abs: string): string {
  assertRealInRoot(root, abs);
  let probe = abs;
  for (;;) {
    try { return path.resolve(fs.realpathSync(probe), path.relative(probe, abs)); }
    catch (e) {
      const parent = path.dirname(probe);
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === probe) throw e;
      probe = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// create_file: 新規作成(既存は拒否)。承認ゲートに内容の差分を見せてから書く。
// ---------------------------------------------------------------------------

export const createFileTool: Tool = {
  name: 'create_file',
  description: '新しいファイルを作る(既存なら失敗)。content は全文。承認を得てから書き込む。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '作るファイル(ルート相対)' },
      content: { type: 'string', description: '書き込む全文' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const rel = requireString(args.path, 'path');
    const content = requireString(args.content, 'content');
    const abs = resolveInRoot(ctx.root, rel);
    if (fs.existsSync(abs)) {
      throw new ToolError('ALREADY_EXISTS', `既に存在する: ${rel}(edit_file を使う)`);
    }
    // 承認前は検査だけ行い、親ディレクトリも作らない。
    const approvedTarget = creationTarget(ctx.root, abs);
    const diff = renderDiff(rel, '', content);
    const ok = await ctx.approval.approve({
      kind: 'edit',
      title: `新規作成 ${rel}`,
      detail: diff,
      // The target was resolved and proven inside the root above.
      outsideWorkspace: false,
    });
    if (!ok) throw new ToolError('DENIED', `承認されなかったため書き込まない: ${rel}`);
    if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため書き込まない');
    try {
      if (creationTarget(ctx.root, abs) !== approvedTarget || fs.existsSync(abs)) {
        throw new Error('作成先が変更されたか、既に存在する');
      }
    } catch (e) {
      throw new ToolError('NOT_EXECUTED', `承認後の作成先を確認できないため書き込まない: ${(e as Error).message}`);
    }
    const createdParent = fs.mkdirSync(path.dirname(abs), { recursive: true });
    // ここからは親ディレクトリを作成済みかもしれない。予期しない失敗を未実行とは扱わない。
    assertRealInRoot(ctx.root, abs);
    try { fs.writeFileSync(abs, content, { encoding: 'utf8', flag: 'wx' }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (createdParent !== undefined) {
        throw new ToolError('CREATE_CONFLICT', '親ディレクトリは作成したが、競合したファイルには書き込んでいない');
      }
      throw new ToolError('NOT_EXECUTED', '同名ファイルが作成されたため書き込んでいない');
    }
    const notice = ctx.analyze ? await safeAnalysis(() => ctx.analyze!(abs, 'write')) : '';
    return { status: 'ok', fileDigest: createHash('sha256').update(content).digest('hex'),
      output: `${rel} を作成した(${Buffer.byteLength(content, 'utf8')}バイト)${notice ? `\n\n${notice}` : ''}` };
  },
};

// ---------------------------------------------------------------------------
// edit_file: 一致1回の置換。見つからない・複数あるはどちらも拒否。
// 承認ゲートに差分を見せ、承認されて初めて書き込む。
// ---------------------------------------------------------------------------

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'old_string と一致する部分を new_string で置き換える。一致は1回だけ(0回・複数回は失敗)。差分を見せて承認後に書き込む。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '編集するファイル(ルート相対)' },
      old_string: { type: 'string', description: '置き換える対象(一意に一致すること)' },
      new_string: { type: 'string', description: '置き換え後の文字列' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args, ctx) {
    const rel = requireString(args.path, 'path');
    const before = requireString(args.old_string, 'old_string');
    const after = requireString(args.new_string, 'new_string');
    if (before.length === 0) {
      throw new ToolError('INVALID_ARGS', 'old_string は空にできない');
    }
    const abs = resolveInRoot(ctx.root, rel);
    const approvedTarget = assertRealInRoot(ctx.root, abs);
    let old: string;
    try {
      old = fs.readFileSync(abs, 'utf8');
    } catch {
      throw new ToolError('NOT_FOUND', `読めないファイル: ${rel}`);
    }
    const at = old.indexOf(before);
    if (at < 0) throw new ToolError('MATCH_MISSING', 'old_string が見つからない');
    if (old.indexOf(before, at + 1) >= 0) {
      throw new ToolError('MATCH_AMBIGUOUS', 'old_string が複数箇所で一致する(一意にする)');
    }
    const updated = old.slice(0, at) + after + old.slice(at + before.length);
    const diff = renderDiff(rel, old, updated);
    const ok = await ctx.approval.approve({
      kind: 'edit',
      title: `編集 ${rel}`,
      detail: diff,
      outsideWorkspace: false,
    });
    if (!ok) throw new ToolError('DENIED', `承認されなかったため書き込まない: ${rel}`);
    if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため書き込まない');
    try {
      if (assertRealInRoot(ctx.root, abs) !== approvedTarget || fs.readFileSync(abs, 'utf8') !== old) {
        throw new Error('承認待ちの間に対象が変更された');
      }
    } catch (e) {
      throw new ToolError('NOT_EXECUTED', `承認後の対象を確認できないため書き込まない: ${(e as Error).message}`);
    }
    fs.writeFileSync(abs, updated, { encoding: 'utf8' });
    const notice = ctx.analyze ? await safeAnalysis(() => ctx.analyze!(abs, 'write')) : '';
    return { status: 'ok', fileDigest: createHash('sha256').update(updated).digest('hex'),
      output: `${rel} を編集した${notice ? `\n\n${notice}` : ''}` };
  },
};
