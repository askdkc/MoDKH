import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { LanguageDefinition } from './catalog.ts';
import { languageHome } from './detect.ts';

export interface InstalledServer {
  command: string;
  args: string[];
  /** Digest of the installed manifest, used to notice a changed install. */
  digest: string;
  version: string;
  installedAt: string;
}

interface StateFile {
  version: 1;
  servers: Record<string, InstalledServer>;
  /** Recorded reasons for languages that failed and must not be retried within the same turn. */
  failures?: Record<string, { reason: string; at: string }>;
}

const LOCK_STALE_MS = 10 * 60_000;
const MAKE_TIMEOUT_MS = 240_000;

function statePath(): string { return path.join(languageHome(), 'state.json'); }

function readState(): StateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8')) as StateFile;
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && parsed.servers && typeof parsed.servers === 'object') return parsed;
  } catch { /* missing or corrupt: start clean, never trust half-written JSON */ }
  return { version: 1, servers: {} };
}

/** Write through a temporary file so a crash cannot leave a truncated manifest. */
function writeState(state: StateFile): void {
  fs.mkdirSync(languageHome(), { recursive: true });
  const target = statePath();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flush: true });
  fs.renameSync(temporary, target);
}

function digestOf(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function versionOf(packageJson: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJson, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch { return 'unknown'; }
}

function serverRoot(language: LanguageDefinition): string {
  return path.join(languageHome(), 'servers', language.id);
}

/** Cross-process exclusion for one install target; a stale lock is reclaimed after a fixed age. */
async function withLock<T>(target: string, action: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = `${target}.lock`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('他のDKHプロセスが導入中のため待機時間を超えました');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  try { return await action(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, MAKE_TIMEOUT_MS);
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-16_384); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-16_384); });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Install into a private prefix with a private npm cache; never touch the project or the user cache. */
async function installNpm(language: LanguageDefinition, signal?: AbortSignal): Promise<void> {
  const recipe = language.install;
  if (recipe?.kind !== 'npm') throw new Error('npm 導入レシピがありません');
  const target = serverRoot(language);
  await withLock(target, async () => {
    const staging = `${target}.staging-${process.pid}-${Date.now()}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const cache = path.join(languageHome(), 'npm-cache');
    fs.mkdirSync(cache, { recursive: true });
    const result = await run('npm', [
      'install', '--prefix', staging, '--cache', cache, '--no-audit', '--no-fund', '--ignore-scripts',
      ...recipe.packages,
    ], signal);
    if (result.code !== 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`npm 導入に失敗: ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
    }
    // Only publish a prefix that actually contains the expected entry point.
    if (!isExecutable(path.join(staging, 'node_modules', '.bin', recipe.entry))) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`導入後に ${recipe.entry} が見つかりません`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    const binary = path.join(target, 'node_modules', '.bin', recipe.entry);
    const manifest = path.join(target, 'node_modules', recipe.entry.replace(/^.*\.bin\//, ''), 'package.json');
    const state = readState();
    state.servers[language.id] = {
      command: binary,
      args: [...(language.lsp?.args ?? [])],
      digest: fs.existsSync(manifest) ? digestOf(manifest) : digestOf(binary),
      version: fs.existsSync(manifest) ? versionOf(manifest) : 'unknown',
      installedAt: new Date().toISOString(),
    };
    delete state.failures?.[language.id];
    writeState(state);
  });
}

export interface Resolution {
  status: 'ready' | 'missing' | 'unsupported' | 'disabled' | 'error';
  command?: string;
  args?: string[];
  detail?: string;
  installed?: boolean;
}

/**
 * Find a server without installing: explicit setting, then DKH-managed prefix, then host PATH.
 * Installation is a separate step so a plain read never blocks on a network download.
 */
export function resolveServer(language: LanguageDefinition, options: { disabled?: boolean; server?: { command: string; args?: string[] } }): Resolution {
  if (options.disabled) return { status: 'disabled', detail: `${language.id} は設定で無効` };
  if (options.server) return { status: 'ready', command: options.server.command, args: [...(options.server.args ?? language.lsp?.args ?? [])] };
  const state = readState();
  const managed = state.servers[language.id];
  if (managed && isExecutable(managed.command)) return { status: 'ready', command: managed.command, args: managed.args, installed: true };
  const recipe = language.install;
  if (recipe?.kind === 'host') {
    for (const candidate of recipe.candidates) {
      if (candidate.includes('/') ? isExecutable(candidate) : isOnPath(candidate)) {
        return { status: 'ready', command: candidate, args: [...(language.lsp?.args ?? [])], installed: true };
      }
    }
    return { status: 'missing', detail: recipe.requirement ?? 'サーバーが見つかりません' };
  }
  return { status: 'missing' };
}

function isOnPath(binary: string): boolean {
  const pathValue = process.env['PATH'] ?? '';
  return pathValue.split(path.delimiter).some(directory => directory.length > 0 && isExecutable(path.join(directory, binary)));
}

export interface InstallOutcome { status: 'ready' | 'unavailable' | 'error'; detail?: string }

/** Idempotent: a verified install is reused, and a failed install is reported without retrying. */
export async function ensureInstalled(language: LanguageDefinition, options: { autoInstall: boolean; disabled?: boolean; server?: { command: string; args?: string[] }; signal?: AbortSignal }): Promise<InstallOutcome> {
  const existing = resolveServer(language, options);
  if (existing.status === 'ready') return { status: 'ready' };
  if (existing.status === 'disabled') return { status: 'unavailable', detail: existing.detail };
  if (language.install?.kind === 'host') {
    return { status: 'unavailable', detail: `${language.install.requirement ?? 'サーバーがありません'}（自動取得は行いません）` };
  }
  if (!options.autoInstall) return { status: 'unavailable', detail: '自動導入は無効です' };
  const remembered = readState().failures?.[language.id];
  if (remembered) return { status: 'unavailable', detail: `前回の導入失敗: ${remembered.reason}` };
  try {
    await installNpm(language, options.signal);
    return { status: 'ready' };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Remembering the failure is best effort: an unwritable home must not escape as a crash.
    try {
      const state = readState();
      state.failures = { ...(state.failures ?? {}), [language.id]: { reason: reason.slice(0, 500), at: new Date().toISOString() } };
      writeState(state);
    } catch { /* the caller still receives the original reason below */ }
    return { status: 'error', detail: reason };
  }
}

/** Explicit retry clears the remembered failure and re-resolves the recipe. */
export function clearFailure(id: string): void {
  const state = readState();
  if (!state.failures?.[id]) return;
  delete state.failures[id];
  writeState(state);
}

export function statusReport(): { id: string; version?: string; command?: string; installedAt?: string }[] {
  const state = readState();
  return Object.entries(state.servers).map(([id, server]) => ({ id, version: server.version, command: server.command, installedAt: server.installedAt }));
}
