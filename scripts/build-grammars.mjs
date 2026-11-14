/**
 * Copy the reviewed grammar WASM files from devDependencies into dist/language/grammars so the
 * published package can parse without any runtime download. Only an explicit allowlist ships.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'node_modules', 'tree-sitter-wasms', 'out');
const TARGET = path.join(ROOT, 'dist', 'language', 'grammars');

// Svelte and Common Lisp have no reviewed WASM in this grammar set; they degrade to text-only.
const GRAMMARS = [
  'typescript', 'tsx', 'javascript', 'html', 'css',
  'python', 'rust', 'c', 'cpp', 'ruby', 'swift', 'php',
];

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('文法パッケージがありません: npm install を実行してください');
    process.exit(1);
  }
  fs.mkdirSync(TARGET, { recursive: true });
  const manifest = [];
  let missing = 0;
  for (const id of GRAMMARS) {
    const from = path.join(SOURCE, `tree-sitter-${id}.wasm`);
    if (!fs.existsSync(from)) { missing++; console.error(`未収録の文法: ${id}`); continue; }
    const to = path.join(TARGET, `tree-sitter-${id}.wasm`);
    fs.copyFileSync(from, to);
    manifest.push({ id, bytes: fs.statSync(to).size });
  }
  fs.writeFileSync(path.join(TARGET, 'manifest.json'), `${JSON.stringify({ source: 'tree-sitter-wasms@0.1.13', grammars: manifest }, null, 2)}\n`);
  const license = path.join(ROOT, 'node_modules', 'tree-sitter-wasms', 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(TARGET, 'LICENSE'));
  const total = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`文法を同梱しました: ${manifest.length}件 / ${(total / 1024 / 1024).toFixed(1)} MiB${missing ? ` / 未収録 ${missing}` : ''}`);
}

main();
