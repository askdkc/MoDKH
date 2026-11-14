import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { PluginManifest } from './api.ts';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
export function fields(value: Record<string, unknown>, names: string[]): void {
  for (const name of Object.keys(value)) if (!names.includes(name)) throw new Error(`Unknown field: ${name}`);
}
export function pluginId(value: unknown): string {
  const id = text(value, 'plugin ID', 64);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid plugin ID');
  return id;
}
export function parseManifest(value: unknown): PluginManifest {
  const m = object(value);
  fields(m, ['apiVersion', 'id', 'version', 'title', 'description', 'kind', 'entry']);
  if (m.apiVersion !== 1) throw new Error('Unsupported plugin API version');
  if (m.kind !== 'local' && m.kind !== 'external') throw new Error('Invalid plugin kind');
  const entry = text(m.entry, 'entry', 512);
  if (!/^\.\//.test(entry) || entry.includes('\\') || entry.split('/').includes('..') || !/\.(?:mjs|js)$/.test(entry)) throw new Error('Entry must be a relative ESM file inside the package');
  return { apiVersion: 1, id: pluginId(m.id), version: text(m.version, 'version', 128), title: text(m.title, 'title', 256), description: text(m.description, 'description'), kind: m.kind, entry };
}

export interface PackageSnapshot { manifest: PluginManifest; digest: string; files: Map<string, Buffer> }
/** Bounded, deterministic package capture. No executable code is imported here. */
export function inspectPackage(directory: string): PackageSnapshot {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error('Plugin root must be a real directory');
  const files = new Map<string, Buffer>();
  let bytes = 0;
  let entries = 0;
  function visit(relative: string, depth: number): void {
    if (depth > 32) throw new Error('Plugin directory depth exceeds 32');
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      if (++entries > 1000) throw new Error('Plugin exceeds 1000 entries');
      const rel = relative ? `${relative}/${name}` : name;
      const full = path.join(directory, rel);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('Plugin symlinks are not allowed');
      if (stat.isDirectory()) { visit(rel, depth + 1); continue; }
      if (!stat.isFile()) throw new Error('Plugin contains a non-regular file');
      bytes += stat.size;
      if (bytes > 10 * 1024 * 1024 || (rel === 'plugin.json' && stat.size > 65536)) throw new Error('Plugin size limit exceeded');
      const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const current = fs.fstatSync(fd);
        if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size) throw new Error('Plugin changed during capture');
        // Never read an unbounded growing file after the initial size check.
        const data = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < data.length) {
          const count = fs.readSync(fd, data, offset, data.length - offset, offset);
          if (!count) throw new Error('Plugin changed during capture');
          offset += count;
        }
        const end = fs.fstatSync(fd);
        if (end.size !== stat.size || end.mtimeMs !== current.mtimeMs || end.ctimeMs !== current.ctimeMs) throw new Error('Plugin changed during capture');
        files.set(rel, data);
      } finally { fs.closeSync(fd); }
    }
  }
  visit('', 0);
  const manifestBytes = files.get('plugin.json');
  if (!manifestBytes) throw new Error('Missing plugin.json');
  const manifest = parseManifest(JSON.parse(manifestBytes.toString('utf8')));
  if (!files.has(manifest.entry.slice(2))) throw new Error('Missing plugin entry');
  const hash = createHash('sha256');
  for (const [name, data] of files) hash.update(JSON.stringify([name, data.length])).update(data);
  return { manifest, digest: hash.digest('hex'), files };
}
