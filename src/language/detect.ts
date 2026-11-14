import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../cli/config.ts';
import { LANGUAGES, languageById, languageForPath, type LanguageDefinition, type LanguageId } from './catalog.ts';

export interface Detection {
  language: LanguageDefinition;
  /** Absolute, real project root chosen from manifest proximity. */
  root: string;
  /** Manifest that justified the root, if any. */
  manifest?: string;
}

const MAX_SCAN_ENTRIES = 400;

/** Walk up from the file until a manifest for that language appears; stop at the workspace root. */
function findRoot(file: string, workspaceRoot: string, language: LanguageDefinition): { root: string; manifest?: string } {
  let current = path.dirname(file);
  const stop = path.resolve(workspaceRoot);
  for (let depth = 0; depth < 24; depth++) {
    for (const name of language.manifests) {
      if (name.includes('*')) {
        try {
          const match = fs.readdirSync(current).find(entry => entry.endsWith(name.slice(name.indexOf('*') + 1)));
          if (match) return { root: current, manifest: match };
        } catch { /* unreadable directory: keep walking up */ }
      } else if (fs.existsSync(path.join(current, name))) {
        return { root: current, manifest: name };
      }
    }
    const parent = path.dirname(current);
    if (parent === current || path.relative(stop, parent).startsWith('..')) break;
    current = parent;
  }
  return { root: stop };
}

/** Detection is limited to the named file plus a bounded manifest scan; no project code is executed. */
export function detectLanguage(file: string, workspaceRoot: string): Detection | undefined {
  const language = languageForPath(file);
  if (!language) return undefined;
  const { root, manifest } = findRoot(file, workspaceRoot, language);
  return { language, root, ...(manifest ? { manifest } : {}) };
}

/** Languages suggested by manifests in the workspace root, used by `dkh language status`. */
export function detectedLanguages(workspaceRoot: string): LanguageDefinition[] {
  let entries: string[] = [];
  try { entries = fs.readdirSync(workspaceRoot).slice(0, MAX_SCAN_ENTRIES); } catch { return []; }
  const found = new Set<LanguageId>();
  for (const language of LANGUAGES) {
    if (language.manifests.length === 0) continue;
    for (const name of language.manifests) {
      const hit = name.includes('*')
        ? entries.some(entry => entry.endsWith(name.slice(name.indexOf('*') + 1)))
        : entries.includes(name);
      if (hit) { found.add(language.id); break; }
    }
  }
  return [...found].map(id => languageById(id)!).filter(Boolean);
}

export interface LanguageSettings {
  autoInstall: boolean;
  disabled: LanguageId[];
  /** Milliseconds allowed for an install before it is reported as preparing. */
  installTimeoutMs: number;
  /** Milliseconds allowed for a server to answer a single request. */
  requestTimeoutMs: number;
  /** Languages the user explicitly configured a server path for. */
  servers: Partial<Record<LanguageId, { command: string; args?: string[] }>>;
}

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  autoInstall: true,
  disabled: [],
  installTimeoutMs: 180_000,
  requestTimeoutMs: 20_000,
  servers: {},
};

export function languageHome(): string {
  return path.join(configDir(), 'language');
}

/** Parse an untrusted settings object; unknown keys and invalid values fall back to defaults. */
export function parseLanguageSettings(raw: unknown): LanguageSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_LANGUAGE_SETTINGS;
  const value = raw as Record<string, unknown>;
  const disabled = Array.isArray(value['disabled'])
    ? value['disabled'].filter((id): id is LanguageId => typeof id === 'string' && languageById(id) !== undefined)
    : [];
  const servers: LanguageSettings['servers'] = {};
  if (value['servers'] && typeof value['servers'] === 'object' && !Array.isArray(value['servers'])) {
    for (const [id, entry] of Object.entries(value['servers'] as Record<string, unknown>)) {
      if (languageById(id) === undefined || !entry || typeof entry !== 'object') continue;
      const command = (entry as Record<string, unknown>)['command'];
      const args = (entry as Record<string, unknown>)['args'];
      if (typeof command !== 'string' || command.length === 0 || command.length > 4096) continue;
      const list = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string').slice(0, 32) : [];
      servers[id as LanguageId] = { command, args: list };
    }
  }
  const positive = (input: unknown, fallback: number) => typeof input === 'number' && Number.isSafeInteger(input) && input > 0 && input <= 3_600_000 ? input : fallback;
  return {
    autoInstall: value['autoInstall'] !== false,
    disabled,
    installTimeoutMs: positive(value['installTimeoutMs'], DEFAULT_LANGUAGE_SETTINGS.installTimeoutMs),
    requestTimeoutMs: positive(value['requestTimeoutMs'], DEFAULT_LANGUAGE_SETTINGS.requestTimeoutMs),
    servers,
  };
}
