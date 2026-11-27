import { modelBaseUrl } from '../model/factory.ts';
import { providerDefinition, supportsLiveModels } from '../model/providers.ts';
import { resolveApiKey } from './keys.ts';

/**
 * モデル一覧をプロバイダーから実行時に取得する。
 *
 * AIプロバイダーはモデルの追加・廃止が頻繁なので、固定値の一覧はすぐ実態とずれる。
 * 一覧は毎回取得し、キャッシュや同梱リストへのフォールバックは行わない
 * (古いIDを選ばせるより、取得失敗をそのまま見せるほうが安全)。
 */

/** 一覧取得の待ち時間。応答が遅いプロバイダーでも操作を止めすぎない。 */
const MODELS_TIMEOUT_MS = 10_000;

export interface ModelListConnection {
  baseUrl?: string;
  apiKey?: string;
}

export interface ModelListResult {
  /** 取得できたモデルID(接頭辞なし)。 */
  ids: string[];
  /** 表示に使う短い説明。取得できなかった場合は理由。 */
  note?: string;
}

/** 一覧APIの応答から配列部分を取り出す。OpenAI互換は data、Ollama 系は models を使う。 */
function rowsOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of ['data', 'models']) {
    const rows = record[key];
    if (Array.isArray(rows)) return rows;
  }
  return null;
}

/** モデルIDとして妥当か。プロバイダーごとに許される文字が違うため緩めに検証する。 */
function modelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (id.length === 0 || id.length > 256) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(id)) return null;
  return id;
}

/**
 * 1プロバイダーのモデル一覧を取得する。
 * 失敗しても例外にせず理由を返す。呼び出し側は「取得できなかった」と「空だった」を区別できる。
 */
export async function fetchProviderModels(
  provider: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  connection?: ModelListConnection,
): Promise<ModelListResult> {
  const definition = providerDefinition(provider);
  if (!definition) return { ids: [], note: '未知のプロバイダー' };
  if (!supportsLiveModels(provider) || !definition.modelsPath) {
    return { ids: [], note: '一覧APIが未定義。モデルIDを直接入力する' };
  }
  const base = (modelBaseUrl(provider, connection?.baseUrl, env) ?? definition.baseURL)?.replace(/\/$/, '');
  if (!base) return { ids: [], note: '接続先URLが未設定' };
  const key = connection ? connection.apiKey : resolveApiKey(provider, env, definition.env);
  if (definition.env && !key) {
    return { ids: [], note: `環境変数 ${definition.env} が未設定` };
  }
  const headers: Record<string, string> = { accept: 'application/json', ...(definition.headers?.() ?? {}) };
  if (provider === 'anthropic' && key) headers['x-api-key'] = key;
  else if (key) headers.authorization = `Bearer ${key}`;
  // Google の一覧APIはキーをクエリで受け取る。
  const url = provider === 'google'
    ? `${base}${definition.modelsPath}?key=${encodeURIComponent(key ?? '')}`
    : `${base}${definition.modelsPath}`;
  try {
    const response = await fetch(url, {
      headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]),
    });
    if (!response.ok) return { ids: [], note: `HTTP ${response.status}` };
    const rows = rowsOf(await response.json() as unknown);
    if (rows === null) return { ids: [], note: '応答形式が不正' };
    const ids: string[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const raw = definition.idField
        ? record[definition.idField]
        : record['id'] ?? record['slug'] ?? record['model'] ?? record['model_id'] ?? record['name'];
      const id = modelId(raw);
      if (id === null) continue;
      const stripped = definition.idStripPrefix && id.startsWith(definition.idStripPrefix)
        ? id.slice(definition.idStripPrefix.length) : id;
      if (stripped.length > 0) ids.push(stripped);
    }
    return { ids: [...new Set(ids)] };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'タイムアウト'
      : error instanceof Error && error.name === 'AbortError' ? '中止'
      : '通信エラー';
    return { ids: [], note: reason };
  }
}

/**
 * 取得をユーザーが中断・失敗しても操作を続けられるようにする。
 * 固定リストへは落とさない。取得できなければ空の一覧と理由を返す。
 */
export async function providerModelChoices(
  provider: string,
  write: (text: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  connection?: ModelListConnection,
): Promise<ModelListResult | null> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (!signal) process.on('SIGINT', cancel);
  const activeSignal = signal ?? controller.signal;
  write(`${provider}: モデル一覧を取得中…（Ctrl+Cで中止）\n`);
  try {
    const result = await fetchProviderModels(provider, activeSignal, env, connection);
    if (activeSignal.aborted) {
      write(`(${provider}: 取得を中止しました。モデルIDの直接入力も使えます)\n`);
      return null;
    }
    if (result.note) {
      write(`(${provider}: モデル一覧を取得できませんでした: ${result.note}。モデルIDの直接入力も使えます)\n`);
    } else if (result.ids.length === 0) {
      write(`(${provider}: 利用できるモデルが一覧にありませんでした。モデルIDの直接入力も使えます)\n`);
    } else {
      write(`${provider}: モデル一覧 ${result.ids.length}件\n`);
    }
    return result;
  } finally { process.removeListener('SIGINT', cancel); }
}
