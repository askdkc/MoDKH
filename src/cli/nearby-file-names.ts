import fs from 'node:fs';
import path from 'node:path';

/** Inspect names only; never open or substitute a candidate. */
export function nearbyFileNames(missing: string): string {
  return nearbyFiles(missing).hint;
}

export function nearbyFiles(missing: string, directories = false): { hint: string; replacement?: string } {
  let complete = false;
  const close: string[] = [];
  const stem = path.parse(missing).name.toLowerCase();
  const ext = path.extname(missing).toLowerCase();
  const names: { name: string; score: number }[] = [];
  try {
    const dir = fs.opendirSync(path.dirname(missing));
    try {
      for (let i = 0; i < 4096; i++) {
        const entry = dir.readSync();
        if (!entry) { complete = true; break; }
        if (!(directories ? entry.isDirectory() : entry.isFile()) || entry.name.startsWith('.') || /[\p{Cc}\p{Cf}]/u.test(entry.name)) continue;
        const other = path.parse(entry.name).name.toLowerCase();
        let prefix = 0;
        while (prefix < stem.length && stem[prefix] === other[prefix]) prefix++;
        const sameExt = !!ext && path.extname(entry.name).toLowerCase() === ext;
        if (sameExt && prefix >= 3 && prefix * 3 >= 2 * Math.max(stem.length, other.length)) close.push(entry.name);
        if (prefix >= 2 || sameExt) names.push({ name: entry.name, score: prefix * 2 + Number(sameExt) });
      }
    } finally { dir.closeSync(); }
  } catch { return { hint: '' }; }
  names.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const hint = names.length ? `。候補: ${names.slice(0, 5).map(item => JSON.stringify(item.name)).join(', ')}` : '';
  return { hint, replacement: complete && close.length === 1 ? close[0] : undefined };
}
