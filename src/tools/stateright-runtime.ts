import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../cli/config.ts';

export function staterightRoot(): string { return path.join(configDir(), 'stateright'); }
/** Preserve stable symlink paths; never persist a resolved versioned executable. */
export function findStateright(explicit?: string): string | undefined {
  const candidates = explicit ? [path.resolve(explicit)] : [path.join(staterightRoot(), 'bin', 'modkh-stateright'),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, 'modkh-stateright'))];
  return candidates.find(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
}
