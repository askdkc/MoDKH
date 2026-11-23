import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir } from '../../cli/config.ts';

export function chatGptAuthPath(): string {
  return path.join(configDir(), 'chatgpt-auth.json');
}

// The synchronous model picker reads only the sign-in marker. Credentials live in the DevKit store.
export function hasChatGptConnection(): boolean {
  try { return JSON.parse(fs.readFileSync(chatGptAuthPath(), 'utf8')).provider === 'siwc'; }
  catch { return false; }
}

export function markChatGptConnected(): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const file = chatGptAuthPath();
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, '{"provider":"siwc"}\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
