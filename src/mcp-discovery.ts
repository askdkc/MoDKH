import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

type Server = { command: string; args: string[] };
const maxBytes = 4 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Only fixed, root-level filenames are passed here. Never import project code.
async function manifest(root: string, name: string): Promise<Record<string, unknown>> {
  try {
    const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) return {};
      const data = Buffer.alloc(stat.size + 1);
      let used = 0;
      while (used < data.length) {
        const { bytesRead } = await file.read(data, used, data.length - used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used !== stat.size) return {};
      const parsed: unknown = JSON.parse(data.toString('utf8', 0, used));
      return record(parsed) ? parsed : {};
    } finally {
      await file.close();
    }
  } catch {
    return {}; // Unreadable or malformed optional evidence.
  }
}

function dependency(section: unknown, name: string): boolean {
  return record(section) && typeof section[name] === 'string' && !!section[name].trim();
}

function stdio(value: unknown): Server | undefined {
  if (!record(value) || (value.type !== undefined && value.type !== 'stdio') || 'url' in value) return;
  const { command, args = [] } = value;
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')) return;
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) return;
  return { command, args };
}

export async function discoverMcp(root: string): Promise<Record<string, Server>> {
  const dir = await realpath(root);
  const servers = new Map<string, Server>();
  const config = await manifest(dir, '.mcp.json');
  if (record(config.mcpServers)) {
    for (const [name, raw] of Object.entries(config.mcpServers)) {
      const server = stdio(raw);
      if (server && name.trim() && !name.includes('\0') && !(name in Object.prototype) && name !== 'prototype') servers.set(name, server);
    }
  }
  if (!servers.has('svelte')) {
    const pkg = await manifest(dir, 'package.json');
    if ([pkg.dependencies, pkg.devDependencies].some(s => dependency(s, 'svelte') || dependency(s, '@sveltejs/kit')) ||
        await regularFile(dir, 'svelte.config.js') || await regularFile(dir, 'svelte.config.ts')) {
      servers.set('svelte', { command: 'npx', args: ['-y', '@sveltejs/mcp'] });
    }
  }
  if (!servers.has('laravel-boost') && await regularFile(dir, 'artisan')) {
    const composer = await manifest(dir, 'composer.json');
    if ([composer.require, composer['require-dev']].some(s => dependency(s, 'laravel/boost')) || await regularFile(dir, 'boost.json')) {
      servers.set('laravel-boost', { command: 'php', args: ['artisan', 'boost:mcp'] });
    }
  }
  return Object.fromEntries(servers);
}

async function regularFile(root: string, name: string): Promise<boolean> {
  return (await lstat(join(root, name)).catch(() => undefined))?.isFile() === true;
}
