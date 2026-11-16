import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { configDir } from '../cli/config.ts';
import { fields, inspectPackage, object, pluginId } from './package.ts';
import type { PackageSnapshot } from './package.ts';
import type { SessionDefinition } from '../lisp/config.ts';
import { builtinMicroagents } from '../lisp/builtin-agents.ts';
import type { PluginDescriptor } from './api.ts';
import { SubagentRegistry } from './registry.ts';

interface Installed { digest: string; enabled: boolean }
interface Catalog { version: 1; plugins: Record<string, Installed>; disabledBuiltins: string[] }
const EMPTY = (): Catalog => ({ version: 1, plugins: Object.create(null) as Record<string, Installed>, disabledBuiltins: [] });
export interface PluginLease { descriptor: PluginDescriptor; module: Record<string, unknown>; release(): void }
export class PluginLoadInterrupted extends Error {}

async function importWithSignal(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!signal) return import(url) as Promise<Record<string, unknown>>;
  let abort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new PluginLoadInterrupted('Plugin import interrupted; module effects and cleanup remain unknown'));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([import(url) as Promise<Record<string, unknown>>, interrupted]); }
  finally { signal.removeEventListener('abort', abort); }
}

export class PluginManager {
  readonly home: string;
  readonly builtinDir: string;
  constructor(home = configDir(), builtinDir = fileURLToPath(new URL('../../plugins/', import.meta.url))) {
    this.home = path.resolve(home);
    this.builtinDir = builtinDir;
  }
  private sessionEntries: SessionDefinition[] | undefined;
  registerSessionDefinitions(entries: SessionDefinition[], sourceDigest: string): void {
    if (this.sessionEntries) throw new Error('Session definitions already registered; no implicit reload');
    const registry = new SubagentRegistry();
    for (const entry of entries) {
      if (entry.descriptor.digest !== sourceDigest || !entry.descriptor.id.startsWith('micro-')) throw new Error('Invalid session definition');
      registry.register(entry.descriptor);
    }
    this.sessionEntries = structuredClone(entries);
  }
  private base(): string { return path.join(this.home, 'plugins'); }
  private packagePath(id: string, digest: string): string { return path.join(this.base(), 'packages', id, digest); }
  private catalog(): Catalog {
    const file = path.join(this.base(), 'catalog.json');
    if (!fs.existsSync(file)) return EMPTY();
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid plugin catalog');
    const raw = object(JSON.parse(fs.readFileSync(file, 'utf8')));
    fields(raw, ['version', 'plugins', 'disabledBuiltins']);
    if (raw.version !== 1 || !Array.isArray(raw.disabledBuiltins) || raw.disabledBuiltins.length > 1000) throw new Error('Invalid plugin catalog version');
    const result = EMPTY();
    for (const [id, value] of Object.entries(object(raw.plugins))) {
      pluginId(id);
      if (id.startsWith('modkh-')) throw new Error('Reserved plugin ID');
      const row = object(value);
      fields(row, ['digest', 'enabled']);
      if (typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) || typeof row.enabled !== 'boolean') throw new Error('Invalid plugin catalog entry');
      result.plugins[id] = { digest: row.digest, enabled: row.enabled };
    }
    result.disabledBuiltins = raw.disabledBuiltins.map(pluginId);
    return result;
  }
  /** Single writer for registration and lease admission; fail closed after a crashed writer. */
  private transaction<T>(action: () => T): T {
    fs.mkdirSync(this.base(), { recursive: true, mode: 0o700 });
    const lock = path.join(this.base(), 'catalog.lock');
    const fd = fs.openSync(lock, 'wx', 0o600);
    try { return action(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  private save(catalog: Catalog): void {
    const temp = path.join(this.base(), `catalog-${randomUUID()}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    fs.renameSync(temp, path.join(this.base(), 'catalog.json'));
  }
  discover(): { registry: SubagentRegistry; diagnostics: string[] } {
    const registry = new SubagentRegistry();
    const diagnostics: string[] = [];
    if (this.sessionEntries) {
      for (const entry of this.sessionEntries) registry.register(structuredClone(entry.descriptor));
      return { registry, diagnostics };
    }
    let catalog: Catalog;
    try { catalog = this.catalog(); }
    catch (e) { return { registry, diagnostics: [`Plugin settings unavailable: ${String(e)}`] }; }
    try {
      for (const id of fs.readdirSync(this.builtinDir).sort()) {
        try {
          const snapshot = inspectPackage(path.join(this.builtinDir, id));
          if (!snapshot.manifest.id.startsWith('modkh-') || snapshot.manifest.id !== id) throw new Error('Invalid built-in ID');
          registry.register({ ...snapshot.manifest, digest: snapshot.digest, enabled: !catalog.disabledBuiltins.includes(id), builtin: true });
        } catch (e) { diagnostics.push(`${id}: ${String(e)}`); }
      }
    } catch (e) { diagnostics.push(`Built-in plugins unavailable: ${String(e)}`); }
    try {
      for (const { descriptor } of builtinMicroagents()) {
        registry.register({ ...descriptor, enabled: !catalog.disabledBuiltins.includes(descriptor.id) });
      }
    } catch (e) { diagnostics.push(`Built-in microagents unavailable: ${String(e)}`); }
    for (const [id, row] of Object.entries(catalog.plugins)) {
      try {
        const snapshot = inspectPackage(this.packagePath(id, row.digest));
        if (snapshot.digest !== row.digest || snapshot.manifest.id !== id) throw new Error('Plugin digest mismatch; not loaded');
        registry.register({ ...snapshot.manifest, digest: row.digest, enabled: row.enabled, builtin: false });
      } catch (e) { diagnostics.push(`${id}: ${String(e)}`); }
    }
    return { registry, diagnostics };
  }
  preview(directory: string): PackageSnapshot {
    const snapshot = inspectPackage(path.resolve(directory));
    if (snapshot.manifest.id.startsWith('modkh-')) throw new Error('modkh- IDs are reserved');
    return snapshot;
  }
  /** Called only after the human approves the displayed exact package digest. */
  install(directory: string, approvedDigest: string): PluginDescriptor {
    const snapshot = this.preview(directory);
    if (snapshot.digest !== approvedDigest) throw new Error('Plugin changed after trust confirmation');
    return this.transaction(() => {
      const catalog = this.catalog();
      const id = snapshot.manifest.id;
      if (Object.hasOwn(catalog.plugins, id)) throw new Error(`Duplicate plugin: ${id}. Remove its registration before replacing it.`);
      const destination = this.packagePath(id, snapshot.digest);
      if (!fs.existsSync(destination)) {
        const staging = `${destination}.staging-${randomUUID()}`;
        fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
        for (const [relative, bytes] of snapshot.files) {
          const file = path.join(staging, relative);
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600, flush: true });
        }
        if (inspectPackage(staging).digest !== snapshot.digest) throw new Error('Staged plugin digest mismatch');
        fs.renameSync(staging, destination);
        // Interrupted staging directories are retained for inspection, never loaded.
      }
      if (inspectPackage(destination).digest !== snapshot.digest) throw new Error('Installed plugin digest mismatch');
      catalog.plugins[id] = { digest: snapshot.digest, enabled: true };
      this.save(catalog);
      return { ...snapshot.manifest, digest: snapshot.digest, enabled: true, builtin: false };
    });
  }
  setEnabled(id: string, enabled: boolean): void {
    pluginId(id);
    this.transaction(() => {
      const catalog = this.catalog();
      if (id.startsWith('modkh-')) {
        if (!this.discover().registry.get(id)) throw new Error(`Unknown plugin: ${id}`);
        catalog.disabledBuiltins = catalog.disabledBuiltins.filter(value => value !== id);
        if (!enabled) catalog.disabledBuiltins.push(id);
      } else {
        const row = catalog.plugins[id];
        if (!row) throw new Error(`Unknown plugin: ${id}`);
        // Enabling a corrupted package is not a new trust decision.
        if (enabled && inspectPackage(this.packagePath(id, row.digest)).digest !== row.digest) throw new Error('Plugin digest mismatch');
        row.enabled = enabled;
      }
      this.save(catalog);
    });
  }
  remove(id: string): void {
    pluginId(id);
    this.transaction(() => {
      if (id.startsWith('modkh-')) throw new Error('Built-in plugins can be disabled, not removed');
      const catalog = this.catalog();
      if (!catalog.plugins[id]) throw new Error(`Unknown plugin: ${id}`);
      const leases = path.join(this.base(), 'leases', id);
      if (fs.existsSync(leases) && fs.readdirSync(leases).length) throw new Error('Plugin is in use or has an unreconciled lease; stop/reconcile it before removing');
      delete catalog.plugins[id];
      this.save(catalog);
      // Retain immutable packages for audit. Removal unregisters; it never prunes history.
    });
  }
  async acquire(id: string, digest: string, signal?: AbortSignal): Promise<PluginLease> {
    signal?.throwIfAborted();
    pluginId(id);
    if (this.sessionEntries) {
      const entry = this.sessionEntries.find(e => e.descriptor.id === id);
      if (!entry?.descriptor.enabled || entry.descriptor.digest !== digest) throw new Error('Session agent unavailable or digest mismatch');
      return { descriptor: structuredClone(entry.descriptor), module: { define: () => structuredClone(entry.definition) }, release() {} };
    }
    const admitted = this.transaction(() => {
      const descriptor = this.discover().registry.get(id);
      if (!descriptor?.enabled) throw new Error(`Plugin unavailable or disabled: ${id}`);
      if (descriptor.digest !== digest) throw new Error('Plugin changed before dispatch');
      const microagent = descriptor.builtin && !descriptor.entry
        ? builtinMicroagents().find(entry => entry.descriptor.id === id)
        : undefined;
      const directory = descriptor.builtin ? path.join(this.builtinDir, id) : this.packagePath(id, digest);
      const leases = path.join(this.base(), 'leases', id);
      fs.mkdirSync(leases, { recursive: true, mode: 0o700 });
      const lease = path.join(leases, `${randomUUID()}.json`);
      fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, digest }), { flag: 'wx', mode: 0o600, flush: true });
      return { descriptor: { ...descriptor }, directory, lease, microagent };
    });
    let released = false;
    const release = () => { if (!released) { fs.unlinkSync(admitted.lease); released = true; } };
    try {
      if (admitted.microagent) {
        const definition = admitted.microagent.definition;
        return { descriptor: admitted.descriptor, module: { define: () => structuredClone(definition) }, release };
      }
      if (inspectPackage(admitted.directory).digest !== digest) throw new Error('Plugin changed before import');
      const module = await importWithSignal(`${pathToFileURL(path.join(admitted.directory, admitted.descriptor.entry)).href}?digest=${digest}`, signal);
      return { descriptor: admitted.descriptor, module, release };
    } catch (e) {
      // A cancelled dynamic import cannot be unloaded; retain its lease for inspection.
      if (!(e instanceof PluginLoadInterrupted)) release();
      throw e;
    }
  }
}
