import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
}

function authDir(): string {
  if (process.env['MODKH_HOME']) {
    return process.env['MODKH_HOME'];
  }
  const configBase = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(configBase, 'modkh');
}

function authFile(): string {
  return path.join(authDir(), 'chatgpt-auth.json');
}

/** ログイン情報はハーネス専用の保存先に分けて置く(他モデルのキーと混在させない)。 */
export function loadChatGptTokens(): ChatGptTokens | null {
  try {
    const raw = fs.readFileSync(authFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ChatGptTokens>;
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      accountId: parsed.accountId,
    };
  } catch {
    return null;
  }
}

export function saveChatGptTokens(tokens: ChatGptTokens): void {
  fs.mkdirSync(authDir(), { recursive: true });
  const file = authFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function clearChatGptTokens(): void {
  try {
    fs.rmSync(authFile());
  } catch {
    // 無ければ削除済みとして扱う
  }
}

export function chatGptAuthPath(): string {
  return authFile();
}
