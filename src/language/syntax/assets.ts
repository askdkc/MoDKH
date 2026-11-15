import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Grammar assets ship inside the package (see scripts/build-grammars.mjs). Loading is lazy and
 * cached by grammar id: a broken or missing grammar degrades that language only.
 * Resolution works both from dist/language/syntax and from src/language/syntax.
 */
function candidateDirectories(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(here, '..', 'grammars'),                                  // dist/language/grammars
    path.join(here, '..', '..', '..', 'dist', 'language', 'grammars'),  // src/language/syntax
  ];
}

function assetDirectory(): string | null {
  for (const directory of candidateDirectories()) {
    try { if (fs.readdirSync(directory).length > 0) return directory; } catch { /* try the next */ }
  }
  return null;
}

export interface GrammarPaths { wasm: string; license: string; bytes: Uint8Array }

export function grammarPaths(id: string): GrammarPaths | null {
  if (!/^[a-z][a-z0-9_]*$/.test(id)) return null;
  const directory = assetDirectory();
  if (!directory) return null;
  const file = path.join(directory, `tree-sitter-${id}.wasm`);
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || !Array.isArray(manifest.grammars)) throw new Error('Grammar integrity manifest missing or unsupported; rebuild the package');
  const entries = manifest.grammars.filter((entry: { id?: string }) => entry.id === id);
  if (entries.length !== 1) throw new Error(`Grammar ${id} is not uniquely declared in the manifest`);
  const bytes = fs.readFileSync(file), entry = entries[0];
  if (entry.bytes !== bytes.length || entry.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error(`Grammar ${id} digest mismatch`);
  const license = path.join(directory, 'LICENSE');
  if (manifest.license?.file !== 'LICENSE' || manifest.license.sha256 !== createHash('sha256').update(fs.readFileSync(license)).digest('hex')) throw new Error('Grammar license digest mismatch');
  return { wasm: file, license, bytes };
}

export function availableGrammars(): string[] {
  const directory = assetDirectory();
  if (!directory) return [];
  try {
    return fs.readdirSync(directory)
      .filter(name => name.startsWith('tree-sitter-') && name.endsWith('.wasm'))
      .map(name => name.slice('tree-sitter-'.length, -'.wasm'.length))
      .filter(id => { try { return grammarPaths(id) !== null; } catch { return false; } });
  } catch { return []; }
}

/** Grammar ids whose WASM is not shipped; callers must fall back to text-only analysis. */
export function missingGrammars(ids: readonly string[]): string[] {
  const present = new Set(availableGrammars());
  return ids.filter(id => !present.has(id));
}
