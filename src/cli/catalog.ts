/**
 * Picker metadata shared by `/connect` and `/models`.
 *
 * There is deliberately no bundled model list here. AI providers add and retire models far more
 * often than this project releases, so a baked-in list silently offers IDs that no longer exist.
 * Model candidates come from `model-catalog.ts`, which asks the provider each time the picker
 * opens. This module only holds stable facts: display order, labels and the search-row marker.
 */

/** Sentinel value for the pinned search row; never a real model reference. */
export const SEARCH_ROW_VALUE = '\u0000search';

/**
 * MODKH 自身が提供する擬似モデル。プロバイダーが公開する一覧ではないため、ここだけは固定で持つ
 * (オフライン検証用の fixed と、任意URLの compatible は取得元が存在しない)。
 */
export const LOCAL_MODEL_REFS: readonly string[] = ['fixed/scripted'];

/**
 * Providers offered by `/connect`, in display order. `keyOnly` entries store a credential
 * without connecting a model (web search). A model list is never attached to these rows.
 */
export interface ConnectProvider {
  readonly value: string;
  readonly label: string;
  /** Shown as the row detail; the credential or endpoint, never a model list. */
  readonly detail: string;
  /** Environment variable holding the API key; null when the endpoint needs none. */
  readonly key: string | null;
  readonly keyOnly?: true;
}

/** Rows are data only; providers and endpoints are validated by `model/providers.ts`. */
export const CONNECT_PROVIDERS: readonly ConnectProvider[] = [
  { value: 'openai', label: 'OpenAI', detail: 'ChatGPT OAuth (chatgpt) / OPENAI_API_KEY', key: 'OPENAI_API_KEY' },
  { value: 'opencode', label: 'OpenCode Zen', detail: 'Console · OPENCODE_API_KEY', key: 'OPENCODE_API_KEY' },
  { value: 'opencode-go', label: 'OpenCode Go', detail: 'Console · 同じ OPENCODE_API_KEY', key: 'OPENCODE_API_KEY' },
  { value: 'ollama', label: 'Ollama Local', detail: 'ローカル · OLLAMA_BASE_URL', key: null },
  { value: 'ollama-cloud', label: 'Ollama Cloud', detail: 'ollama.com · OLLAMA_API_KEY', key: 'OLLAMA_API_KEY' },
  { value: 'openrouter', label: 'OpenRouter', detail: 'OPENROUTER_API_KEY', key: 'OPENROUTER_API_KEY' },
  { value: 'infron', label: 'Infron', detail: 'INFRON_API_KEY', key: 'INFRON_API_KEY' },
  { value: 'hermes', label: 'Hermes Agent', detail: 'API server · HERMES_API_KEY', key: 'HERMES_API_KEY' },
  // Web検索のキー登録専用。モデル接続の一覧には含めない。
  { value: 'brave-search', label: 'Brave Search', detail: 'web_search 用のキー · BRAVE_SEARCH_API_KEY', key: 'BRAVE_SEARCH_API_KEY', keyOnly: true },
];

/** `/connect` に出す行(検索キー専用の登録は除く)。 */
export function modelProviders(): ConnectProvider[] {
  return CONNECT_PROVIDERS.filter(provider => provider.keyOnly !== true);
}

function unique(refs: readonly string[]): string[] {
  return [...new Set(refs)];
}

/**
 * 与えられたIDを `<provider>/<model>` の形に整える。取得した一覧も、利用者が直接入力したIDも
 * 同じ経路を通す。既に接頭辞が付いた値は二重に付けない。
 */
export function toRefs(provider: string, ids: readonly string[], current?: string | null): string[] {
  const prefix = `${provider}/`;
  const refs = ids
    .filter(id => id.length > 0)
    .map(id => (id.startsWith(prefix) ? id : `${prefix}${id}`));
  return unique([...refs, ...(current ? [current] : [])]);
}
