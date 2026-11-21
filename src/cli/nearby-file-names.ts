import fs from 'node:fs';
import path from 'node:path';

/** Inspect names only; never open or substitute a candidate. */
export function nearbyFileNames(missing: string): string {
  const stem = path.parse(missing).name.toLowerCase();
  const ext = path.extname(missing).toLowerCase();
  const names: { name: string; score: number }[] = [];
  try {
    const dir = fs.opendirSync(path.dirname(missing));
    try {
      for (let i = 0; i < 4096; i++) {
        const entry = dir.readSync();
        if (!entry) break;
        if (!entry.isFile() || entry.name.startsWith('.') || /[\p{Cc}\p{Cf}]/u.test(entry.name)) continue;
        const other = path.parse(entry.name).name.toLowerCase();
        let prefix = 0;
        while (prefix < stem.length && stem[prefix] === other[prefix]) prefix++;
        const sameExt = !!ext && path.extname(entry.name).toLowerCase() === ext;
        if (prefix >= 2 || sameExt) names.push({ name: entry.name, score: prefix * 2 + Number(sameExt) });
      }
    } finally { dir.closeSync(); }
  } catch { return ''; }
  names.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return names.length ? `。候補: ${names.slice(0, 5).map(item => JSON.stringify(item.name)).join(', ')}` : '';
}
