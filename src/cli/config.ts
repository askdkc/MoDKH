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
}

export const DEFAULT_CONFIG: LiteConfig = {
  memory: {
    enabled: false,
    command: 'kiokuko',
    args: ['mcp', '--profile', 'chatgpt-memory'],
  },
};

function configDir(): string {
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
    return {
      memory: {
        enabled: parsed.memory?.enabled === true,
        command: parsed.memory?.command ?? DEFAULT_CONFIG.memory.command,
        args: parsed.memory?.args ?? DEFAULT_CONFIG.memory.args,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: LiteConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
}
