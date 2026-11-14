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
  diagnostics?: string[];
}

export const DEFAULT_CONFIG: LiteConfig = {
  memory: {
    enabled: false,
    command: 'kiokuko',
    args: ['mcp', '--profile', 'chatgpt-memory'],
  },
};

export function configDir(): string {
  if (process.env['DKH_HOME']) return process.env['DKH_HOME'];
  const configBase = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(configBase, 'dkh');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
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
      memory: {
        enabled: parsed.memory?.enabled === true,
        command: parsed.memory?.command ?? DEFAULT_CONFIG.memory.command,
        args: parsed.memory?.args ?? DEFAULT_CONFIG.memory.args,
      },
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, subagents: null, diagnostics: [`設定を読めません。子の起動は無効: ${String(e)}`] };
  }
}

export function saveConfig(config: LiteConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
}
