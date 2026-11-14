import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.ts';

/**
 * Provider API keys entered at /connect. Kept in the DKH config directory with mode 0600 and
 * never written to a session log or echoed back by a command. Environment variables still win,
 * so an exported key is not silently overridden by a stale saved one.
 */
export type SavedKeys = Record<string, string>;

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_KEY_LENGTH = 4096;

export function keysPath(): string {
  return path.join(configDir(), 'keys.json');
}

/** Values are opaque; only format problems are rejected. Unknown providers are not accepted. */
function normalizeProvider(provider: string): string {
  const name = provider.trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(name)) throw new Error(`プロバイダー名が不正です: ${provider}`);
  return name;
}

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) throw new Error('APIキーが空です');
  if (trimmed.length > MAX_KEY_LENGTH) throw new Error('APIキーが長すぎます');
  if (/[\r\n\0]/.test(trimmed)) throw new Error('APIキーに改行や制御文字は使えません');
  return trimmed;
}

/** A malformed or unreadable file is treated as empty rather than granting a partial identity. */
export function loadSavedKeys(): SavedKeys {
  try {
    const parsed = JSON.parse(fs.readFileSync(keysPath(), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const keys: SavedKeys = {};
    for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!PROVIDER_PATTERN.test(provider) || typeof value !== 'string') continue;
      const key = value.trim();
      if (key.length === 0 || key.length > MAX_KEY_LENGTH) continue;
      keys[provider] = key;
    }
    return keys;
  } catch { return {}; }
}

function writeKeys(keys: SavedKeys): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = keysPath();
  const temporary = `${target}.${process.pid}.tmp`;
  // Create with 0600 from the start so the secret is never briefly world-readable.
  fs.writeFileSync(temporary, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

export function saveKey(provider: string, key: string): { provider: string; path: string } {
  const name = normalizeProvider(provider), value = normalizeKey(key);
  const keys = loadSavedKeys();
  keys[name] = value;
  writeKeys(keys);
  return { provider: name, path: keysPath() };
}

export function removeKey(provider: string): boolean {
  const name = normalizeProvider(provider);
  const keys = loadSavedKeys();
  if (!(name in keys)) return false;
  delete keys[name];
  writeKeys(keys);
  return true;
}

/** Names only; callers must never print the secret itself. */
export function savedKeyProviders(): string[] {
  return Object.keys(loadSavedKeys()).sort();
}

/** Environment first, then the saved key. An empty environment value is ignored. */
export function resolveApiKey(provider: string, env: NodeJS.ProcessEnv = process.env, envName?: string | null): string | undefined {
  const fromEnv = envName ? env[envName]?.trim() : undefined;
  if (fromEnv) return fromEnv;
  return loadSavedKeys()[normalizeProvider(provider)];
}
