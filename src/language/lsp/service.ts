import fs from 'node:fs';
import path from 'node:path';
import { detectLanguage, type LanguageSettings } from '../detect.ts';
import type { LanguageDefinition } from '../catalog.ts';
import { ensureInstalled, resolveServer } from '../install.ts';
import { ServerPool, aggregate, realRoot, type Aggregate } from './pool.ts';
import type { ServerDiagnostic } from './client.ts';

export interface LanguageServiceOptions {
  root: string;
  settings: LanguageSettings;
  /** Called for status text; never used to influence correctness. */
  progress?: (message: string) => void;
  pool?: ServerPool;
}

export interface AnalyzeResult {
  status: 'ok' | 'partial' | 'unavailable';
  detail?: string;
  diagnostics?: ServerDiagnostic[];
  servers?: Aggregate['servers'];
  language?: string;
  installed?: boolean;
}

const MAX_ANALYZED_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Owns language detection, installation and semantic analysis for one workspace. Analysis never
 * changes the outcome of an edit: callers keep their own success result and append this report.
 */
export class LanguageService {
  readonly root: string;
  private readonly settings: LanguageSettings;
  private readonly progress?: (message: string) => void;
  private readonly pool: ServerPool;
  /** In-flight work per file prevents duplicate installs/starts in one turn. */
  private readonly inflight = new Map<string, Promise<AnalyzeResult>>();
  private disposed = false;

  constructor(options: LanguageServiceOptions) {
    this.root = realRoot(options.root);
    this.settings = options.settings;
    this.progress = options.progress;
    this.pool = options.pool ?? new ServerPool({ requestTimeoutMs: options.settings.requestTimeoutMs });
  }

  get poolSize(): number { return this.pool.size; }
  /** The already-running server for a file, if its language/root was analyzed before. */
  poolFor(file: string): import('./client.ts').LspServer | undefined {
    const detection = this.detect(file);
    if (!detection) return undefined;
    const configured = this.settings.servers[detection.language.id];
    return this.pool.find(realRoot(detection.root), detection.language.id, JSON.stringify(configured ?? null));
  }
  detect(file: string) { return detectLanguage(file, this.root); }

  /** Analyze a file after a read or a successful write. Never throws. */
  async analyze(file: string, text: string, signal?: AbortSignal): Promise<AnalyzeResult> {
    try { return await this.analyzeGuarded(file, text, signal); }
    catch (e) { return { status: 'unavailable', detail: `解析できない: ${e instanceof Error ? e.message : String(e)}` }; }
  }

  private async analyzeGuarded(file: string, text: string, signal?: AbortSignal): Promise<AnalyzeResult> {
    if (this.disposed) return { status: 'unavailable', detail: '言語サービスは終了済みです' };
    if (Buffer.byteLength(text) > MAX_ANALYZED_FILE_BYTES) {
      return { status: 'unavailable', detail: '2 MiBを超えるファイルは解析しない（本文の操作は可能）' };
    }
    const detection = this.detect(file);
    if (!detection) return { status: 'unavailable', detail: '対応言語ではない' };
    const language = detection.language;
    if (this.settings.disabled.includes(language.id)) {
      return { status: 'unavailable', language: language.id, detail: `${language.id} は設定で無効` };
    }
    const key = `${realRoot(detection.root)}::${language.id}::${file}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.analyzeOnce(language, detection.root, file, text, signal).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async analyzeOnce(language: LanguageDefinition, root: string, file: string, text: string, signal?: AbortSignal): Promise<AnalyzeResult> {
    const configured = this.settings.servers[language.id];
    const resolved = resolveServer(language, { disabled: false, ...(configured ? { server: configured } : {}) });
    let launch = resolved.status === 'ready' && resolved.command
      ? { command: resolved.command, args: resolved.args ?? [] }
      : undefined;
    let installed = false;
    if (!launch) {
      if (!this.settings.autoInstall) {
        return { status: 'unavailable', language: language.id, detail: resolved.detail ?? 'サーバー未導入（自動導入は無効）' };
      }
      this.progress?.(`${language.id} の言語サーバーを準備しています（初回のみ）…`);
      const outcome = await ensureInstalled(language, {
        autoInstall: this.settings.autoInstall,
        ...(configured ? { server: configured } : {}),
        ...(signal ? { signal } : {}),
      });
      if (outcome.status !== 'ready') {
        return { status: 'unavailable', language: language.id, detail: outcome.detail ?? 'サーバーを準備できません' };
      }
      installed = true;
      const after = resolveServer(language, {});
      if (after.status !== 'ready' || !after.command) {
        return { status: 'unavailable', language: language.id, detail: '導入後にサーバーを解決できない' };
      }
      launch = { command: after.command, args: after.args ?? [] };
    }
    const started = await this.pool.acquire(
      { root: realRoot(root), language, configDigest: JSON.stringify(configured ?? null) },
      launch,
      signal,
    );
    if (started.status !== 'ready') {
      return { status: 'unavailable', language: language.id, installed, detail: started.detail ?? 'サーバーを起動できません' };
    }
    let sync;
    try {
      sync = await started.server.synchronize(file, text);
    } catch (e) {
      return { status: 'partial', language: language.id, installed, detail: `診断を取得できません: ${(e as Error).message}` };
    }
    const combined = aggregate([{ id: language.id, status: sync.status, diagnostics: sync.diagnostics }]);
    return {
      status: sync.status === 'observed' ? 'ok' : 'partial',
      language: language.id,
      installed,
      diagnostics: combined.diagnostics,
      servers: combined.servers,
      ...(sync.status === 'observed' ? {} : { detail: '診断はまだ通知されていません（診断0件とは区別する）' }),
    };
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.pool.disposeAll();
  }
}

export function formatDiagnostics(result: AnalyzeResult): string {
  if (result.status === 'unavailable') return `解析: 未実施 — ${result.detail ?? '理由不明'}`;
  const servers = (result.servers ?? [])
    .map(server => `${server.id}:${server.status}${server.detail ? `(${server.detail})` : ''}`)
    .join(' ');
  const items = result.diagnostics ?? [];
  const head = `解析: ${result.status}${result.language ? ` ${result.language}` : ''}${servers ? ` [${servers}]` : ''}`;
  if (items.length === 0) return `${head}${result.status === 'ok' ? '。診断0件' : ''}`;
  const lines = items.slice(0, 20).map(d => `  ${d.path}:${d.line}:${d.column} ${d.severity}: ${d.message.slice(0, 300)}`);
  return `${head}。${items.length}件\n${lines.join('\n')}`;
}

/** Kept for callers that need the resolved workspace root without constructing a service. */
export function workspaceRoot(root: string): string { return realRoot(root); }

export function exists(file: string): boolean { return fs.existsSync(file) && fs.statSync(file).isFile(); }

export function resolveWithin(root: string, file: string): string { return path.resolve(root, file); }
