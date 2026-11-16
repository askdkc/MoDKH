import fs from 'node:fs';
import path from 'node:path';
import { detectLanguage, type Detection, type LanguageSettings } from '../detect.ts';
import { languageById, type LanguageDefinition } from '../catalog.ts';
import { ensureInstalled, resolveServer } from '../install.ts';
import { ServerPool, aggregate, realRoot, type Aggregate, type PoolKeyParts, type RunningServer } from './pool.ts';
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

interface ServerTarget extends PoolKeyParts {
  fallbackRoot?: string;
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
  /** Running language servers, for display. Callers must not infer readiness from this list. */
  runningServers(): RunningServer[] { return this.pool.running(); }
  /** The ready server for a file, if its server target was analyzed before. */
  poolFor(file: string, selector?: 'tailwind'): import('./client.ts').LspServer | undefined {
    const detection = this.detect(file);
    if (!detection) return undefined;
    const language = selector ? languageById(selector)! : detection.language;
    if (this.settings.disabled.includes(language.id)) return undefined;
    const target = this.serverTarget(language, detection);
    return this.pool.find(this.preferredRoot(target), target.language.id, target.configDigest);
  }
  detect(file: string) { return detectLanguage(file, this.root); }

  private serverTarget(language: LanguageDefinition, detection: Detection): ServerTarget {
    const { servers, disabled } = this.settings;
    const configDigest = JSON.stringify(servers[language.id] ?? null);
    const projectRoot = realRoot(detection.root);
    if (language.id !== 'typescript' && language.id !== 'tsx') {
      return { root: projectRoot, language, configDigest };
    }
    // tsserver discovers individual tsconfig projects inside the LSP workspace.
    const shareTypeScript = language.id === 'tsx' && !disabled.includes('typescript')
      && configDigest === JSON.stringify(servers.typescript ?? null);
    return {
      root: this.root,
      language: shareTypeScript ? languageById('typescript')! : language,
      configDigest,
      ...(projectRoot !== this.root ? { fallbackRoot: projectRoot } : {}),
    };
  }

  private preferredRoot(target: ServerTarget): string {
    // Keep using an established project-local server for analysis and navigation alike.
    const { fallbackRoot, root, language, configDigest } = target;
    return fallbackRoot && this.pool.find(fallbackRoot, language.id, configDigest) ? fallbackRoot : root;
  }

  /** Analyze a file after a read or a successful write. Never throws. */
  async analyze(file: string, text: string, signal?: AbortSignal, selector?: 'tailwind'): Promise<AnalyzeResult> {
    try { return await this.analyzeGuarded(file, text, signal, selector); }
    catch (e) { return { status: 'unavailable', detail: `解析できない: ${e instanceof Error ? e.message : String(e)}` }; }
  }

  private async analyzeGuarded(file: string, text: string, signal?: AbortSignal, selector?: 'tailwind'): Promise<AnalyzeResult> {
    if (this.disposed) return { status: 'unavailable', detail: '言語サービスは終了済みです' };
    if (Buffer.byteLength(text) > MAX_ANALYZED_FILE_BYTES) {
      return { status: 'unavailable', detail: '2 MiBを超えるファイルは解析しない（本文の操作は可能）' };
    }
    const detection = this.detect(file);
    if (!detection) return { status: 'unavailable', detail: '対応言語ではない' };
    const language = selector ? languageById(selector)! : detection.language;
    if (this.settings.disabled.includes(language.id)) {
      return { status: 'unavailable', language: language.id, detail: `${language.id} は設定で無効` };
    }
    const target = this.serverTarget(language, detection);
    const key = `${target.root}::${language.id}::${file}::${text}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const work = this.analyzeOnce(target, language.id, file, text, signal).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async analyzeOnce(target: ServerTarget, languageId: LanguageDefinition['id'], file: string, text: string, signal?: AbortSignal): Promise<AnalyzeResult> {
    const { language } = target;
    const configured = this.settings.servers[language.id];
    let resolved = resolveServer(language, configured ? { server: configured } : {});
    // Older installations may have the same server installed under the TSX recipe.
    if (resolved.status === 'missing' && language.id === 'typescript' && !configured && !this.settings.servers.tsx) {
      resolved = resolveServer(languageById('tsx')!, {});
    }
    let launch = resolved.status === 'ready' && resolved.command
      ? { command: resolved.command, args: resolved.args ?? [] }
      : undefined;
    let installed = false;
    if (!launch) {
      if (!this.settings.autoInstall) {
        return { status: 'unavailable', language: languageId, detail: resolved.detail ?? 'サーバー未導入（自動導入は無効）' };
      }
      this.progress?.(`${language.id} の言語サーバーを準備しています（初回のみ）…`);
      const outcome = await ensureInstalled(language, {
        autoInstall: this.settings.autoInstall,
        ...(configured ? { server: configured } : {}),
        ...(signal ? { signal } : {}),
      });
      if (outcome.status !== 'ready') {
        return { status: 'unavailable', language: languageId, detail: outcome.detail ?? 'サーバーを準備できません' };
      }
      installed = true;
      const after = resolveServer(language, {});
      if (after.status !== 'ready' || !after.command) {
        return { status: 'unavailable', language: languageId, detail: '導入後にサーバーを解決できない' };
      }
      launch = { command: after.command, args: after.args ?? [] };
    }
    const root = this.preferredRoot(target);
    let started = await this.pool.acquire({ ...target, root }, launch, signal);
    if (started.status === 'unavailable' && target.fallbackRoot && root === target.root && !signal?.aborted && !this.disposed) {
      started = await this.pool.acquire({ ...target, root: target.fallbackRoot }, launch, signal);
    }
    if (started.status !== 'ready') {
      return { status: 'unavailable', language: languageId, installed, detail: started.detail ?? 'サーバーを起動できません' };
    }
    let sync;
    try {
      sync = await started.server.synchronize(file, text);
    } catch (e) {
      return { status: 'partial', language: languageId, installed, detail: `診断を取得できません: ${(e as Error).message}` };
    }
    const combined = aggregate([{ id: language.id, status: sync.status, diagnostics: sync.diagnostics }]);
    return {
      status: sync.status === 'observed' ? 'ok' : 'partial',
      language: languageId,
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
