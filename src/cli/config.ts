import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface MemoryConfig {
  enabled: boolean;
  command: string;
  args: string[];
}

export interface LiteConfig {
  memory: MemoryConfig;
  /** Validated per plugin by the subagent boundary; malformed entries fail closed. */
  subagents?: unknown;
  /** Validated by parseLanguageSettings; malformed values fall back to defaults. */
  language?: unknown;
  /** all | workspace | none. Validated by parsePermissionPolicy; malformed values fall back. */
  permissions?: unknown;
  /** Tool round-trip limit for one turn. Validated by parseMaxTurns; malformed values fall back. */
  maxTurns?: unknown;
  /** 前回接続したモデル(--base-url の情報は modelBaseUrl に残す)。起動時の復元に使う。 */
  model?: unknown;
  modelBaseUrl?: unknown;
  /** 前回の /reasoning レベル。起動時に復元する。 */
  reasoning?: unknown;
  /** モデル応答の無通信タイムアウト(ms)。1〜上限で検証し、不正値は使わない。 */
  timeoutMs?: unknown;
  diagnostics?: string[];
}

export const DEFAULT_CONFIG: LiteConfig = {
  memory: {
    enabled: false,
    command: 'kiokuko',
    args: ['mcp', '--profile', 'chatgpt-memory'],
  },
};

/** タイムアウトは 5秒〜30分の整数で受ける。それ以外は無効値として扱う。 */
export const TIMEOUT_MS_MIN = 5000;
export const TIMEOUT_MS_MAX = 1_800_000;

export function parseTimeoutMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < TIMEOUT_MS_MIN || value > TIMEOUT_MS_MAX) return null;
  return value;
}

export function configDir(): string {
  if (process.env['DKH_HOME']) return process.env['DKH_HOME'];
  const configBase = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(configBase, 'dkh');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

/** 既定値は毎回コピーして返す(呼び出し元が書き換えても共有しない)。 */
export function defaultConfig(): LiteConfig {
  return { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory } };
}

export function loadConfig(): LiteConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LiteConfig>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('設定はJSONオブジェクトで指定してください');
    return {
      subagents: parsed.subagents,
      language: parsed.language,
      permissions: parsed.permissions,
      maxTurns: parsed.maxTurns,
      model: parsed.model,
      modelBaseUrl: parsed.modelBaseUrl,
      reasoning: parsed.reasoning,
      timeoutMs: parsed.timeoutMs,
      memory: {
        enabled: parsed.memory?.enabled === true,
        command: parsed.memory?.command ?? DEFAULT_CONFIG.memory.command,
        args: parsed.memory?.args ?? DEFAULT_CONFIG.memory.args,
      },
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    return { ...defaultConfig(), subagents: null, diagnostics: [`設定を読めません。子の起動は無効: ${String(e)}`] };
  }
}

export function saveConfig(config: LiteConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
}

/**
 * 起動時に読んだ設定を壊さず1フィールドだけ更新する。書き込み前に実ファイルから
 * 読み直すので、並行する別セッションの保存を失わない。
 */
export function updateConfig(apply: (config: LiteConfig) => void): void {
  const current = loadConfig();
  apply(current);
  saveConfig(current);
}
