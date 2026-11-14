import path from 'node:path';
import fs from 'node:fs';
import { LspServer, type ServerDiagnostic } from './client.ts';
import type { LanguageDefinition } from '../catalog.ts';

export interface PoolKeyParts {
  root: string;
  language: LanguageDefinition;
  /** Digest of the effective server settings, so a changed configuration starts a new server. */
  configDigest: string;
}

export function poolKey(parts: PoolKeyParts): string {
  return serverKey(parts.root, parts.language.id, parts.configDigest);
}

export function serverKey(root: string, id: string, configDigest: string): string {
  return `${root}::${id}::${configDigest}`;
}

export interface StartedServer {
  server: LspServer;
  reused: boolean;
  /** true when the configured language is not running and cannot start right now. */
  status: 'ready' | 'starting' | 'unavailable';
  detail?: string;
}

interface Entry {
  server: LspServer;
  key: string;
  root: string;
  id: string;
  /** Incremented on each acquisition; idle entries are released after a grace period. */
  lastUsed: number;
}

export interface PoolOptions {
  /** Maximum number of concurrently running servers. */
  maxRunning?: number;
  /** Milliseconds a server may stay idle before it is stopped. */
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Servers are keyed by (real root, language, config digest). A child Stop affects only the
 * caller's request through its own timeout/signal; the shared server keeps running for others.
 */
export class ServerPool {
  private readonly entries = new Map<string, Entry>();
  private readonly options: Required<PoolOptions>;
  /** Stops started by capacity eviction; they are awaited by settled()/disposeAll(). */
  private readonly pending = new Set<Promise<void>>();
  private disposing = false;

  constructor(options: PoolOptions = {}) {
    this.options = {
      maxRunning: options.maxRunning ?? 3,
      idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
    };
  }

  get size(): number { return this.entries.size; }

  async acquire(parts: PoolKeyParts, launch: { command: string; args: string[] }, signal?: AbortSignal): Promise<StartedServer> {
    const key = poolKey(parts);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      if (existing.server.running) return { server: existing.server, reused: true, status: 'ready' };
      this.entries.delete(key);
    }
    if (this.entries.size >= this.options.maxRunning) this.releaseOldestIdle();
    if (this.entries.size >= this.options.maxRunning) {
      // Never start a fourth server: an explicit unavailable result is better than thrashing.
      return { server: new LspServer({ id: parts.language.id, command: launch.command, args: launch.args, root: parts.root, requestTimeoutMs: this.options.requestTimeoutMs }), reused: false, status: 'unavailable', detail: `同時起動数が上限(${this.options.maxRunning})です` };
    }
    const server = new LspServer({
      id: parts.language.id,
      command: launch.command,
      args: launch.args,
      root: parts.root,
      requestTimeoutMs: this.options.requestTimeoutMs,
    });
    this.entries.set(key, { server, key, root: parts.root, id: parts.language.id, lastUsed: Date.now() });
    try {
      await server.start(signal);
      return { server, reused: false, status: 'ready' };
    } catch (e) {
      this.entries.delete(key);
      await server.dispose();
      return { server, reused: false, status: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  find(root: string, id: string, configDigest: string): LspServer | undefined {
    const entry = this.entries.get(serverKey(realRoot(root), id, configDigest));
    return entry?.server.running ? entry.server : undefined;
  }

  private releaseOldestIdle(): void {
    let oldest: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
    }
    if (!oldest) return;
    this.entries.delete(oldest.key);
    // Stopping is awaited later: an untracked dispose lets protocol writes outlive the caller.
    this.pending.add(oldest.server.dispose().catch(() => undefined));
  }

  /** Resolves once every detached stop has completed; used before a caller reports closure. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) {
      const current = [...this.pending];
      await Promise.all(current);
      for (const entry of current) this.pending.delete(entry);
    }
  }

  /** Stop servers that nobody used recently; called opportunistically between requests. */
  async releaseIdle(now = Date.now()): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.lastUsed < this.options.idleTimeoutMs) continue;
      this.entries.delete(key);
      await entry.server.dispose();
    }
  }

  async disposeAll(): Promise<void> {
    if (this.disposing) { await this.settled(); return; }
    this.disposing = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(entry => entry.server.dispose()));
    await this.settled();
  }
}

export function realRoot(root: string): string {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

/** Aggregate per-server outcomes without hiding partial failure. */
export interface Aggregate {
  diagnostics: ServerDiagnostic[];
  servers: { id: string; status: 'observed' | 'waiting' | 'unsupported' | 'error'; detail?: string; count: number }[];
}

export function aggregate(results: { id: string; status: Aggregate['servers'][number]['status']; detail?: string; diagnostics?: ServerDiagnostic[] }[]): Aggregate {
  return {
    diagnostics: results.flatMap(result => result.diagnostics ?? []),
    servers: results.map(result => ({ id: result.id, status: result.status, ...(result.detail ? { detail: result.detail } : {}), count: result.diagnostics?.length ?? 0 })),
  };
}
