import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Refresh the per-file SHA-256 entries of one bundled collection's manifest.
 * Usage: node scripts/update-bundled-skill-hashes.mjs <bundle>
 * The manifest's other fields (repository, revision, license, descriptions) stay as authored.
 */
const bundle = process.argv[2];
if (!bundle) {
  console.error('usage: node scripts/update-bundled-skill-hashes.mjs <bundle>');
  process.exit(2);
}
const root = path.join(process.cwd(), 'skills', bundle);
const manifestFile = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
for (const skill of manifest.skills) {
  const files = { 'SKILL.md': hash(path.join(root, skill.directory, 'SKILL.md')) };
  const references = path.join(root, skill.directory, 'references');
  if (fs.existsSync(references)) {
    for (const entry of fs.readdirSync(references).sort()) {
      if (!entry.endsWith('.md')) continue;
      files[`references/${entry}`] = hash(path.join(references, entry));
    }
  }
  skill.files = files;
}
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`更新: ${bundle} manifest.json (${manifest.skills.map(s => `${s.name}: ${Object.keys(s.files).length} files`).join(', ')})`);

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
