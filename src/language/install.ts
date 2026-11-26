import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { executeBounded, privateEnvironment } from '../lisp/runtime.ts';
import { CL_LSP_REPOSITORY } from './commonlisp-bundled.ts';
import { installCommonLisp, reusableCommonLisp } from './commonlisp-install.ts';
import { installPhpantom } from './native.ts';
import { hostPlatform } from './platform.ts';
import { probeTypescript, recommendedTypescript } from './typescript-capability.ts';
import { LspServer } from './lsp/client.ts';
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
  failures?: Record<string, { reason: string; at: string; retryable?: boolean; recipe?: string }>;
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
      if (Date.now() > deadline) throw new Error('他のMODKHプロセスが導入中のため待機時間を超えました');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const heartbeat = setInterval(() => { try { const now = new Date(); fs.utimesSync(lock, now, now); } catch { /* action reports its own failure */ } }, 30000);
  try { return await action(); }
  finally { clearInterval(heartbeat); fs.rmSync(lock, { recursive: true, force: true }); }
}

async function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = path.join(languageHome(), 'runtime-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = privateEnvironment(home);
  // Only the operator's opt-in npm transport settings, not ambient settings or credentials.
  const proxy = command === 'npm' ? process.env.MODKH_LANGUAGE_NPM_PROXY : undefined;
  if (proxy !== undefined) {
    const url = URL.parse(proxy);
    if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('MODKH_LANGUAGE_NPM_PROXY には認証情報を含まない HTTP(S) プロキシの origin を指定してください');
    }
    env.npm_config_https_proxy = url.origin;
  }
  const caFile = command === 'npm' ? process.env.MODKH_LANGUAGE_NPM_CA_FILE : undefined;
  if (caFile !== undefined) {
    if (!path.isAbsolute(caFile) || !fs.statSync(caFile, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('MODKH_LANGUAGE_NPM_CA_FILE には信頼する CA 証明書（PEM）の絶対パスを指定してください');
    }
    env.NODE_EXTRA_CA_CERTS = caFile;
  }
  const result = await executeBounded(command, [...args], { cwd: home, env,
    inputDigest: createHash('sha256').update(JSON.stringify([command,args])).digest('hex'), signal, timeoutMs: MAKE_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
  if (result.state !== 'exited') throw new Error(`Installer ${result.state}: ${result.stderr.slice(-1000)}`);
  return { code: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
}

export function verifyTsserver(prefix: string): void {
  const api = path.join(prefix, 'node_modules', 'typescript', 'lib', 'tsserver.js');
  if (!fs.existsSync(api) || !fs.statSync(api).isFile()) throw new Error('TypeScript dependency lacks required typescript/lib/tsserver.js API');
}

async function initializeProbe(language: LanguageDefinition, command: string, args: string[], root: string, signal?: AbortSignal): Promise<void> {
  const server = new LspServer({ id: language.id, command, args, root, requestTimeoutMs: 10000,
    env: privateEnvironment(root) as Record<string,string>, inheritEnv: false });
  try { await server.start(signal); }
  finally { await server.dispose(); }
}

/** Install into a private prefix with a private npm cache; never touch the project or the user cache. */
async function installNpm(language: LanguageDefinition, signal?: AbortSignal): Promise<void> {
  const recipe = language.install;
  if (recipe?.kind !== 'npm') throw new Error('npm 導入レシピがありません');
  const target = serverRoot(language);
  await withLock(target, async () => {
    if (readState().servers[language.id] && resolveServer(language, {}).status === 'ready') return;
    const staging = `${target}.staging-${process.pid}-${Date.now()}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    try {
      const space = fs.statfsSync(staging);
      if (space.bavail * space.bsize < 512 * 1024 * 1024) throw new Error('Insufficient disk space for server install (512 MiB reserve)');
      const cache = path.join(languageHome(), 'npm-cache');
      fs.mkdirSync(cache, { recursive: true });
      const result = await run('npm', [
        'install', '--prefix', staging, '--cache', cache, '--no-audit', '--no-fund', '--ignore-scripts', '--registry', 'https://registry.npmjs.org',
        ...recipe.packages,
      ], signal);
      if (result.code !== 0) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new Error(`npm 導入に失敗: ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
      }
      let typescript: { version: string; apiSha256: string; selection: string; recommendationSha256?: string } | undefined;
      if (['typescript', 'javascript', 'tsx'].includes(language.id)) {
        let selection = 'typescript@latest';
        let recommendationSha256: string | undefined;
        // Missing JS tsserver is the compatibility trigger, not a numeric version gate.
        try { verifyTsserver(staging); }
        catch {
          if (signal?.aborted) throw new Error('TypeScript installation aborted');
          const readme = fs.readFileSync(path.join(staging, 'node_modules/typescript-language-server/README.md'), 'utf8');
          const recommended = recommendedTypescript(readme);
          if (!recommended) throw new Error('Missing tsserver API and no unambiguous official compatibility recommendation');
          selection = recommended;
          recommendationSha256 = createHash('sha256').update(readme).digest('hex');
          const fallback = await run('npm', ['install', '--prefix', staging, '--cache', cache, '--no-audit', '--no-fund', '--ignore-scripts', '--registry', 'https://registry.npmjs.org', recommended], signal);
          if (fallback.code !== 0) throw new Error(`TypeScript compatibility install failed: ${fallback.stderr.slice(-400)}`);
          verifyTsserver(staging);
        }
        typescript = { ...await probeTypescript(staging, signal), selection, recommendationSha256 };
      }
      // Only publish a prefix that actually contains the expected entry point.
      if (!isExecutable(path.join(staging, 'node_modules', '.bin', recipe.entry))) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new Error(`導入後に ${recipe.entry} が見つかりません`);
      }
      await initializeProbe(language, path.join(staging, 'node_modules', '.bin', recipe.entry), [...(language.lsp?.args ?? [])], staging, signal);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      const binary = path.join(target, 'node_modules', '.bin', recipe.entry);
      const manifest = path.join(target, 'node_modules', recipe.packages[0].replace(/@[^@/]+$/, ''), 'package.json');
      const lockfile = path.join(target, 'package-lock.json');
      fs.writeFileSync(path.join(target, 'install-receipt.json'), JSON.stringify({
        typescript, platform: hostPlatform(), packages: recipe.packages, packageName: recipe.packages[0].replace(/@[^@/]+$/, ''), binary: recipe.entry,
        lockfileSha256: fs.existsSync(lockfile) ? digestOf(lockfile) : null,
        binarySha256: digestOf(binary), initialized: true, finishedAt: new Date().toISOString(),
      }, null, 2));
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
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
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
 * Find a server without installing: explicit setting, then MODKH-managed prefix, then host PATH.
 * Installation is a separate step so a plain read never blocks on a network download.
 */
export function resolveServer(language: LanguageDefinition, options: { disabled?: boolean; server?: { command: string; args?: string[] } }): Resolution {
  if (options.disabled) return { status: 'disabled', detail: `${language.id} は設定で無効` };
  if (options.server) return { status: 'ready', command: options.server.command, args: [...(options.server.args ?? language.lsp?.args ?? [])] };
  const state = readState();
  const managed = state.servers[language.id];
  if (managed && isExecutable(managed.command) && (language.id !== 'commonlisp' || reusableCommonLisp(managed.command, managed.digest))) return { status: 'ready', command: managed.command, args: managed.args, installed: true };
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
  if (!hostPlatform()) return { status: 'unavailable', detail: `Unsupported OS/CPU: ${process.platform}/${process.arch}` };
  const existing = resolveServer(language, options);
  if (existing.status === 'ready') return { status: 'ready' };
  if (existing.status === 'disabled') return { status: 'unavailable', detail: existing.detail };
  if (language.install?.kind === 'host' && !['php', 'commonlisp'].includes(language.id)) {
    return { status: 'unavailable', detail: `${language.install.requirement ?? 'サーバーがありません'}（自動取得は行いません）` };
  }
  if (!options.autoInstall) return { status: 'unavailable', detail: '自動導入は無効です' };
  const remembered = readState().failures?.[language.id];
  if (remembered && (language.id !== 'commonlisp' || remembered.recipe === CL_LSP_REPOSITORY) && (remembered.retryable === false || Date.now() - Date.parse(remembered.at) < 60000)) return { status: 'unavailable', detail: `前回の導入失敗: ${remembered.reason}` };
  try {
    if (language.id === 'php' || language.id === 'commonlisp') {
      const target = serverRoot(language);
      await withLock(target, async () => {
        if (resolveServer(language, {}).status === 'ready') return;
        const prior = readState().failures?.[language.id];
        if (prior && (language.id !== 'commonlisp' || prior.recipe === CL_LSP_REPOSITORY) && (prior.retryable === false || Date.now() - Date.parse(prior.at) < 60000)) throw new Error(`Previous install failed: ${prior.reason}`);
        const result = await (language.id === 'php' ? installPhpantom : installCommonLisp)(target, options.signal);
        const state = readState();
        state.servers[language.id] = { command: result.command, args: [], version: result.version, digest: result.digest, installedAt: new Date().toISOString() };
        delete state.failures?.[language.id]; writeState(state);
      });
    } else await installNpm(language, options.signal);
    return { status: 'ready' };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Remembering the failure is best effort: an unwritable home must not escape as a crash.
    try {
      const state = readState();
      state.failures = { ...(state.failures ?? {}), [language.id]: { ...(language.id === 'commonlisp' ? { recipe: CL_LSP_REPOSITORY } : {}), reason: reason.slice(0, 500), at: new Date().toISOString(), retryable: !/ENOSPC|Insufficient disk|unknown/.test(reason) } };
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
