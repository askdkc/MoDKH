import fs from 'node:fs';
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

export interface GrammarPaths { wasm: string; license: string }

export function grammarPaths(id: string): GrammarPaths | null {
  const directory = assetDirectory();
  if (!directory) return null;
  const file = path.join(directory, `tree-sitter-${id}.wasm`);
  if (!fs.existsSync(file)) return null;
  return { wasm: file, license: path.join(directory, 'LICENSE') };
}

export function availableGrammars(): string[] {
  const directory = assetDirectory();
  if (!directory) return [];
  try {
    return fs.readdirSync(directory)
      .filter(name => name.startsWith('tree-sitter-') && name.endsWith('.wasm'))
      .map(name => name.slice('tree-sitter-'.length, -'.wasm'.length));
  } catch { return []; }
}

/** Grammar ids whose WASM is not shipped; callers must fall back to text-only analysis. */
export function missingGrammars(ids: readonly string[]): string[] {
  const present = new Set(availableGrammars());
  return ids.filter(id => !present.has(id));
}
