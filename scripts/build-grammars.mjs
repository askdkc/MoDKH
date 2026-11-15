/** Ship only the reviewed grammar allowlist, with integrity metadata for the exact bytes. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GRAMMARS = [
  'typescript', 'tsx', 'javascript', 'html', 'css',
  'python', 'rust', 'c', 'cpp', 'ruby', 'swift', 'php',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function buildGrammars(packageDirectory, target) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (metadata.name !== 'tree-sitter-wasms' || typeof metadata.version !== 'string') throw new Error('Invalid grammar package metadata');
  const license = fs.readFileSync(path.join(packageDirectory, 'LICENSE'));
  if (!license.length) throw new Error('Missing grammar package license');
  // Validate the entire input set before replacing any output. Missing files fail the build.
  const inputs = GRAMMARS.map(id => {
    const bytes = fs.readFileSync(path.join(packageDirectory, 'out', `tree-sitter-${id}.wasm`));
    if (!bytes.subarray(0, 8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) throw new Error(`Invalid WASM header: ${id}`);
    return { id, bytes };
  });
  fs.mkdirSync(target, { recursive: true });
  // An interrupted copy must not leave a success manifest advertising the old set.
  fs.rmSync(path.join(target, 'manifest.json'), { force: true });
  for (const { id, bytes } of inputs) fs.writeFileSync(path.join(target, `tree-sitter-${id}.wasm`), bytes);
  fs.writeFileSync(path.join(target, 'LICENSE'), license);
  const manifest = {
    schema: 1,
    source: `${metadata.name}@${metadata.version}`,
    packageMetadataSha256: digest(fs.readFileSync(path.join(packageDirectory, 'package.json'))),
    license: { file: 'LICENSE', sha256: digest(license) },
    provenance: 'Installed npm package and lockfile; grammar upstream revisions are not supplied by this package. Digests identify bytes, not independent upstream authentication.',
    unavailable: ['commonlisp', 'svelte'],
    grammars: inputs.map(({ id, bytes }) => ({ id, bytes: bytes.length, sha256: digest(bytes) })),
  };
  fs.writeFileSync(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildGrammars(path.join(ROOT, 'node_modules/tree-sitter-wasms'), path.join(ROOT, 'dist/language/grammars'));
    console.log(`文法を同梱しました: ${result.grammars.length}件 / ${(result.grammars.reduce((n,g)=>n+g.bytes,0)/1024/1024).toFixed(1)} MiB`);
  } catch (error) { console.error(`文法build失敗: ${error.message}`); process.exitCode = 1; }
}
