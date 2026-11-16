import { languageForPath } from '../catalog.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';

/** A single running server for one (root, language, config) key. */
export interface ServerDiagnostic {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  server: string;
}

export interface OpenState {
  version: number;
  text: string;
  /** Monotonic local counter; the server may return diagnostics for an older version. */
  diagnostics: ServerDiagnostic[];
  /** Version whose diagnostics were last observed, if any. */
  diagnosticVersion?: number;
  /** Whether the server has signalled any diagnostic result for this document at all. */
  notified: boolean;
}

const MAX_DIAGNOSTICS = 200;

export interface LspServerOptions {
  id: string;
  command: string;
  args: readonly string[];
  root: string;
  requestTimeoutMs: number;
  /** Extra environment for the server process; used by tests to select a fixture mode. */
  env?: Record<string, string>;
  inheritEnv?: boolean;
  log?(message: string): void;
}

function severityName(value: unknown): ServerDiagnostic['severity'] {
  switch (value) {
    case 1: return 'error';
    case 2: return 'warning';
    case 3: return 'info';
    default: return 'hint';
  }
}

/** One LSP process and connection. Every failure is reported, never silently swallowed. */
/** Upper bound on waiting for push diagnostics after an edit; a slower server reports waiting. */
const DIAGNOSTIC_WAIT_MS = 1200;

export class LspServer {
  readonly id: string;
  private readonly options: LspServerOptions;
  private child?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private readonly open = new Map<string, OpenState>();
  private starting?: Promise<void>;
  private disposed = false;
  private disposal?: Promise<void>;
  private selectedEncoding: 'utf-16' | 'utf-8' | 'utf-32' = 'utf-16';
  /** Pull-diagnostics support, announced by the server's capabilities rather than a version string. */
  private pullDiagnostics = false;
  capabilities: Record<string, unknown> = {};
  private diagnosticTrace = { pushNotifications: 0, pullRequests: 0, pullReports: 0 };
  get diagnosticEvidence() { return { ...this.diagnosticTrace, pullSupported: this.pullDiagnostics }; }

  constructor(options: LspServerOptions) {
    this.id = options.id;
    this.options = options;
  }

  get running(): boolean { return this.child !== undefined && this.connection !== undefined; }
  get documents(): Map<string, OpenState> { return this.open; }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.running) return;
    if (this.starting) return this.starting;
    this.starting = this.launch(signal).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async launch(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new Error('サーバーは終了済みです');
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...(this.options.inheritEnv === false ? {} : process.env), NO_COLOR: '1', ...this.options.env },
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    const spawnFailure = new Promise<never>((_, reject) => child.once('error', reject));
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data).slice(-4000); });
    // A server may exit while a request is in flight; stream errors are not user-facing failures.
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.connection = connection;
    connection.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
      this.diagnosticTrace.pushNotifications++;
      this.acceptPushDiagnostics(params);
    });
    connection.onRequest('client/registerCapability', () => null); // Acknowledgement only; no filesystem watch is claimed.
    connection.onRequest('client/unregisterCapability', () => null);
    connection.onRequest('workspace/configuration', (params: unknown) => this.configuration(params));
    // A server asking to edit the workspace is refused: edits go through the approved tool path.
    connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'MODKHはサーバー発の編集を適用しません' }));
    connection.onRequest('window/workDoneProgress/create', () => null);
    connection.onNotification('window/logMessage', (value: unknown) => {
      const message = (value as { message?: unknown })?.message;
      if (typeof message === 'string') this.options.log?.(message.slice(0, 2000));
    });
    connection.listen();

    // Track the stop so launch() can await it; an untracked dispose would outlive its caller.
    let stopping: Promise<void> | undefined;
    const abort = () => { stopping ??= this.dispose(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const rootUri = pathToFileURL(this.options.root).href;
      const initialized = await this.withTimeout(Promise.race([spawnFailure, connection.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: 'modkh' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(this.options.root) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true, versionSupport: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: false },
            references: {},
            diagnostic: { dynamicRegistration: false },
          },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
        },
        initializationOptions: {},
      })]), 'initialize');
      this.capabilities = (initialized as { capabilities?: Record<string, unknown> }).capabilities ?? {};
      const provider = this.capabilities['diagnosticProvider'] as { interFileDependencies?: boolean } | undefined;
      this.pullDiagnostics = provider !== undefined && provider !== null;
      const encoding = this.capabilities['positionEncoding'];
      this.selectedEncoding = encoding === 'utf-8' || encoding === 'utf-32' ? encoding : 'utf-16';
      await connection.sendNotification('initialized', {});
    } catch (e) {
      const detail = stderr.trim().split('\n').slice(-3).join(' ');
      await (stopping ?? this.dispose());
      throw new Error(`${this.id} の初期化に失敗: ${(e as Error).message}${detail ? ` / ${detail.slice(0, 300)}` : ''}`);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private configuration(params: unknown): unknown[] {
    const items = Array.isArray((params as { items?: unknown[] })?.items) ? (params as { items: unknown[] }).items : [];
    return items.map(() => ({}));
  }

  /** Servers may use UTF-8 offsets; only the announced encoding is trusted. */
  get encoding(): 'utf-16' | 'utf-8' | 'utf-32' { return this.selectedEncoding; }

  private withTimeout<T>(promise: Promise<T>, what: string, ms = this.options.requestTimeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} が ${ms}ms 以内に応答しません`)), ms);
      promise.then(value => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
    });
  }

  private acceptPushDiagnostics(params: unknown): void {
    const value = params as { uri?: unknown; diagnostics?: unknown; version?: unknown };
    if (typeof value?.uri !== 'string' || !Array.isArray(value.diagnostics)) return;
    const file = fileURLToPath(value.uri);
    const state = this.open.get(file);
    if (!state) return;
    const version = typeof value.version === 'number' ? value.version : undefined;
    // A diagnostic for an older version is not evidence about the current text.
    if (version !== undefined && version !== state.version) return;
    state.diagnostics = value.diagnostics.slice(0, MAX_DIAGNOSTICS).map((raw): ServerDiagnostic => {
      const item = raw as { range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }; severity?: number; message?: string; source?: string };
      return {
        path: file,
        line: (item.range?.start?.line ?? 0) + 1,
        column: (item.range?.start?.character ?? 0) + 1,
        endLine: (item.range?.end?.line ?? 0) + 1,
        endColumn: (item.range?.end?.character ?? 0) + 1,
        severity: severityName(item.severity),
        message: typeof item.message === 'string' ? item.message.slice(0, 2000) : '',
        ...(typeof item.source === 'string' ? { source: item.source } : {}),
        server: this.id,
      };
    });
    state.diagnosticVersion = version ?? state.version;
    state.notified = true;
  }

  async openDocument(file: string, text: string): Promise<OpenState> {
    const connection = this.requireConnection();
    const existing = this.open.get(file);
    const state: OpenState = existing ?? { version: 0, text, diagnostics: [], notified: false };
    // Re-analyzing unchanged text must not discard a diagnostic the server already sent.
    if (existing && existing.text === text) return state;
    state.version += 1;
    state.text = text;
    state.diagnostics = [];
    state.diagnosticVersion = undefined;
    state.notified = false;
    this.open.set(file, state);
    if (existing) {
      await connection.sendNotification('textDocument/didChange', {
        textDocument: { uri: pathToFileURL(file).href, version: state.version },
        contentChanges: [{ text }],
      });
      return state;
    }
    const languageId = this.id === 'tailwind' || this.id === 'typescript'
      ? languageForPath(file)?.id ?? (this.id === 'tailwind' ? 'plaintext' : this.id)
      : this.id;
    await connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri: pathToFileURL(file).href, languageId: languageId === 'tsx' ? 'typescriptreact' : languageId, version: state.version, text },
    });
    return state;
  }

  /** Waits for a diagnostic result that belongs to the current version, or reports absence. */
  async synchronize(file: string, text: string): Promise<{ status: 'observed' | 'waiting' | 'unsupported'; diagnostics: ServerDiagnostic[]; version: number }> {
    const before = this.open.get(file)?.text;
    const state = await this.openDocument(file, text);
    // Nothing changed, so the earlier answer is still the answer: polling again only delays the caller.
    if (state.notified && (state.diagnosticVersion === undefined || state.diagnosticVersion >= state.version)) {
      return { status: 'observed', diagnostics: state.diagnostics, version: state.version };
    }
    if (before === text) return { status: 'waiting', diagnostics: state.diagnostics, version: state.version };
    if (this.pullDiagnostics) {
      try {
        this.diagnosticTrace.pullRequests++;
        const report = await this.withTimeout(this.requireConnection().sendRequest('textDocument/diagnostic', {
          textDocument: { uri: pathToFileURL(file).href },
        }), '診断') as { items?: unknown[] } | null;
        // A null report means the server had nothing for this document; keep the push state.
        if (report && Array.isArray(report.items)) {
          this.diagnosticTrace.pullReports++;
          this.acceptPushDiagnostics({ uri: pathToFileURL(file).href, diagnostics: report.items, version: state.version });
        }
      } catch { /* fall through to the push state below */ }
      if (state.notified && (state.diagnosticVersion === undefined || state.diagnosticVersion >= state.version)) {
        return { status: 'observed', diagnostics: state.diagnostics, version: state.version };
      }
    }
    // Push diagnostics arrive asynchronously. The wait is a user-visible delay on every read and
    // edit, so it stays short: a slower server reports "waiting", which is distinct from a clean
    // zero-diagnostic result and never claims the file is fine.
    const budget = Math.min(this.options.requestTimeoutMs, DIAGNOSTIC_WAIT_MS);
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (state.notified && (state.diagnosticVersion === undefined || state.diagnosticVersion >= state.version)) break;
    }
    const observed = state.notified && (state.diagnosticVersion === undefined || state.diagnosticVersion >= state.version);
    return { status: observed ? 'observed' : 'waiting', diagnostics: state.diagnostics, version: state.version };
  }

  async hover(file: string, position: { line: number; character: number }): Promise<string | null> {
    const result = await this.withTimeout(this.requireConnection().sendRequest('textDocument/hover', {
      textDocument: { uri: pathToFileURL(file).href }, position,
    }), 'hover') as { contents?: unknown } | null;
    return renderHover(result?.contents);
  }

  async definition(file: string, position: { line: number; character: number }): Promise<{ file: string; line: number; character: number }[]> {
    const result = await this.withTimeout(this.requireConnection().sendRequest('textDocument/definition', {
      textDocument: { uri: pathToFileURL(file).href }, position,
    }), '定義') as unknown;
    return this.locations(result);
  }

  async references(file: string, position: { line: number; character: number }): Promise<{ file: string; line: number; character: number }[]> {
    const result = await this.withTimeout(this.requireConnection().sendRequest('textDocument/references', {
      textDocument: { uri: pathToFileURL(file).href }, position, context: { includeDeclaration: true },
    }), '参照') as unknown;
    return this.locations(result, 50);
  }

  private locations(result: unknown, limit = 20): { file: string; line: number; character: number }[] {
    const items = Array.isArray(result) ? result : result ? [result] : [];
    const out: { file: string; line: number; character: number }[] = [];
    for (const item of items.slice(0, limit)) {
      const value = item as { uri?: string; targetUri?: string; range?: { start?: { line?: number; character?: number } }; targetRange?: { start?: { line?: number; character?: number } } };
      const uri = value.uri ?? value.targetUri;
      const range = value.range ?? value.targetRange;
      if (typeof uri !== 'string' || !uri.startsWith('file:') || !range?.start) continue;
      out.push({ file: fileURLToPath(uri), line: (range.start.line ?? 0) + 1, character: (range.start.character ?? 0) + 1 });
    }
    return out;
  }

  private requireConnection(): MessageConnection {
    if (!this.connection) throw new Error(`${this.id} は起動していません`);
    return this.connection;
  }

  dispose(): Promise<void> { return this.disposal ??= this.stop(); }

  private async stop(): Promise<void> {
    this.disposed = true;
    const connection = this.connection, child = this.child;
    this.connection = undefined; this.child = undefined; this.open.clear();
    if (connection) {
      // Dispose detaches the reader/writer; without this, later notifications race stream teardown.
      // The writer may still flush a queued message, so its rejection stays observed but ignored.
      try { connection.dispose(); } catch { /* already gone */ }
    }
    let cleanupUnknown = false;
    if (child?.pid && process.platform !== 'win32') {
      const pid = child.pid;
      const alive = () => { try { process.kill(-pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
      const stop = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* checked below */ } };
      stop('SIGTERM');
      const started = Date.now();
      while (alive() && Date.now() - started < 3000) {
        if (Date.now() - started >= 1000) stop('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      cleanupUnknown = alive();
    } else if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 100));
      cleanupUnknown = child.exitCode === null && child.signalCode === null;
    }
    // Pipes are closed only after the process is gone; nothing can write into them afterwards.
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    if (cleanupUnknown) throw new Error(`${this.id}: process-group cleanup unknown`);
  }
}

function renderHover(contents: unknown): string | null {
  if (contents === null || contents === undefined) return null;
  if (typeof contents === 'string') return contents.slice(0, 4000);
  if (Array.isArray(contents)) {
    return contents.map(part => renderHover(part)).filter(Boolean).join('\n').slice(0, 4000) || null;
  }
  const value = contents as { value?: unknown };
  return typeof value.value === 'string' ? value.value.slice(0, 4000) : null;
}

export function rememberDocumentText(server: LspServer, file: string): string | undefined {
  return server.documents.get(file)?.text;
}

export function fileStillExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}
