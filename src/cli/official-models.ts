import { currentChatGptTokens } from '../model/chatgpt/login.ts';
import { loadChatGptTokens } from '../model/chatgpt/tokens.ts';
import { resolveApiKey } from './keys.ts';

export type OfficialProvider = 'openai' | 'chatgpt';
// Codex catalogue protocol compatibility, not the MoDKH application version.
// https://github.com/openai/codex/releases/tag/rust-v0.169.0
const CODEX_CATALOG_VERSION = '0.169.0';

export function hasModelCredentials(provider: OfficialProvider): boolean {
  return provider === 'chatgpt' ? loadChatGptTokens() !== null
    : Boolean(resolveApiKey('openai', process.env, 'OPENAI_API_KEY'));
}

/** Fetch afresh for each picker; never substitute a baked-in list or persist account entitlements. */
export async function fetchOfficialModels(provider: OfficialProvider, signal: AbortSignal): Promise<string[]> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let endpoint: string;
  if (provider === 'chatgpt') {
    const tokens = await currentChatGptTokens(signal);
    headers.authorization = `Bearer ${tokens.accessToken}`;
    if (tokens.accountId) headers['ChatGPT-Account-Id'] = tokens.accountId;
    endpoint = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CATALOG_VERSION}`;
  } else {
    const key = resolveApiKey('openai', process.env, 'OPENAI_API_KEY');
    if (!key) throw new Error('OPENAI_API_KEY が未設定です。/connect openai で認証してください');
    headers.authorization = `Bearer ${key}`;
    endpoint = 'https://api.openai.com/v1/models';
  }
  const response = await fetch(endpoint, { headers, signal, redirect: 'error' });
  if (!response.ok) throw new Error(`公式モデル一覧の取得に失敗しました: HTTP ${response.status}`);
  const body: unknown = await response.json();
  const rows = body && typeof body === 'object'
    ? (body as Record<string, unknown>)[provider === 'chatgpt' ? 'models' : 'data'] : undefined;
  if (!Array.isArray(rows)) throw new Error('公式モデル一覧の応答形式が不正です');
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('公式モデル一覧のモデル形式が不正です');
    const id: unknown = row[provider === 'chatgpt' ? 'slug' : 'id'];
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)) {
      throw new Error('公式モデル一覧のモデルIDが不正です');
    }
    if (provider === 'chatgpt' && row.visibility !== 'list') continue;
    ids.push(`${provider}/${id}`);
  }
  return [...new Set(ids)];
}

/** Own cancellation and diagnostics, keeping failed retrieval distinct from an empty catalogue. */
export async function officialModelChoices(provider: OfficialProvider, write: (text: string) => void, signal?: AbortSignal): Promise<string[] | null> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (!signal) process.on('SIGINT', cancel);
  const activeSignal = signal ?? controller.signal;
  write(`${provider}: 公式モデル一覧を取得中…（Ctrl+Cで中止）\n`);
  try {
    const models = await fetchOfficialModels(provider, AbortSignal.any([activeSignal, AbortSignal.timeout(10_000)]));
    write(`${provider}: 公式モデル一覧 ${models.length}件\n`);
    return models;
  } catch (error) {
    const message = activeSignal.aborted ? '取得を中止しました'
      : error instanceof Error && error.name === 'TimeoutError' ? '取得がタイムアウトしました'
      : error instanceof Error && error.message.startsWith('公式モデル一覧') ? error.message
      : hasModelCredentials(provider) ? '公式モデル一覧を取得できませんでした。通信と認証を確認してください'
      : provider === 'openai' ? 'OPENAI_API_KEY が未設定です。/connect openai から接続してください'
      : 'ChatGPT認証が必要です。/connect chatgpt から接続してください';
    write(`(${provider}: ${message}。一覧を開き直すと再取得します。モデルIDの直接入力も使えます)\n`);
    return activeSignal.aborted ? null : [];
  } finally { process.removeListener('SIGINT', cancel); }
}
