import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../agent/types.ts';
import { assertRealInRoot, resolveInRoot } from './guard.ts';
import { sha256 } from '../lisp/runtime.ts';

export function snapshot(root: string, value: unknown, extension: string): { name: string; relativePath: string; bytes: Buffer; digest: string } {
  if (typeof value !== 'string' || path.extname(value) !== extension) throw new ToolError('INVALID_ARGS', `Explicit ${extension} input required`);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(path.basename(value))) throw new ToolError('INVALID_ARGS', 'Input basename must start with a letter, not a verifier option');
  const file = resolveInRoot(root, value);
  const real = assertRealInRoot(root, file);
  if (real !== file) throw new ToolError('DENIED', 'Formal inputs must not be symlinks');
  const expected = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024 || stat.ino !== expected.ino || stat.dev !== expected.dev) throw new ToolError('INVALID_ARGS', 'Invalid or changed formal input (256 KiB limit)');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > 256 * 1024) throw new ToolError('TOO_LARGE', 'Formal input grew during read');
    return { name: path.basename(file), relativePath: path.relative(root, file), bytes, digest: sha256(bytes) };
  } finally { fs.closeSync(fd); }
}
