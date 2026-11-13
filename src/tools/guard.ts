import path from 'node:path';
import fs from 'node:fs';
import { ToolError } from '../agent/types.ts';

/** 作業ルート内の絶対パスへ解決する。ルート外や空は ToolError。 */
export function resolveInRoot(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new ToolError('INVALID_PATH', 'path は空でない文字列で指定する');
  }
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new ToolError(
      'OUT_OF_ROOT',
      `作業ルート外への参照は拒否する: ${rel}`,
    );
  }
  return abs;
}

/**
 * symlink による脱出を防ぐ。パス自身(なければ最も近い存在する親)を実パスで確認する。
 * ファイル・ディレクトリの両方に使う。返り値は実パス。
 */
export function assertRealInRoot(root: string, abs: string): string {
  let probe = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      assertInsideRealRoot(root, real);
      return real;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) {
          throw new ToolError('OUT_OF_ROOT', `ルートが解決できない: ${abs}`);
        }
        probe = parent;
        continue;
      }
      throw e;
    }
  }
}

function assertInsideRealRoot(root: string, realAbs: string): void {
  const realRoot = fs.realpathSync(root);
  const rel = path.relative(realRoot, realAbs);
  // rel === '' はルート自身なので内側として扱う。ルート外だけを拒否する。
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(
      'OUT_OF_ROOT',
      `シンボリックリンク経由のルート外参照は拒否する: ${realAbs}`,
    );
  }
}
