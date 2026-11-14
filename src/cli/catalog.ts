/**
 * Model catalogs shown by the picker and `/models`.
 *
 * The Ollama Cloud list is a snapshot of `GET https://ollama.com/v1/models` taken while building
 * this release, so the picker works offline and without a key. It is a convenience list, not an
 * entitlement: a model may require a plan the account does not have, and the service may add or
 * retire models at any time. `/connect <provider>/<model>` always accepts an ID from outside this
 * list, and `dkh models refresh` can rewrite the snapshot from the live endpoint.
 */
export interface CatalogEntry {
  /** Full `<provider>/<model>` reference used everywhere else. */
  readonly ref: string;
  /** Short description for the picker; never a capability guarantee. */
  readonly note?: string;
}

/** Snapshot of the Ollama Cloud catalogue with a short note for well-known families. */
export const OLLAMA_CLOUD_CATALOG: readonly CatalogEntry[] = [
  { ref: 'ollama-cloud/gemma4:31b' },
  { ref: 'ollama-cloud/gpt-oss:120b', note: '大規模' },
  { ref: 'ollama-cloud/gpt-oss:20b', note: '軽量' },
  { ref: 'ollama-cloud/deepseek-v4.1-flash', note: '高速・低コスト' },
  { ref: 'ollama-cloud/deepseek-v4.1-flash:1017', note: '高速・版固定' },
  { ref: 'ollama-cloud/deepseek-v4-pro:0813', note: '高精度' },
  { ref: 'ollama-cloud/glm-5.3', note: '汎用' },
  { ref: 'ollama-cloud/glm-5.3-flash', note: '高速' },
  { ref: 'ollama-cloud/glm-5.2' },
  { ref: 'ollama-cloud/kimi-k3.1-pro', note: '長文・高精度' },
  { ref: 'ollama-cloud/kimi-k3' },
  { ref: 'ollama-cloud/kimi-k2.7-code', note: 'コード' },
  { ref: 'ollama-cloud/kimi-k2.6' },
  { ref: 'ollama-cloud/minimax-m3' },
  { ref: 'ollama-cloud/minimax-m3.1-flash', note: '高速' },
  { ref: 'ollama-cloud/mimo-v2.6-pro' },
  { ref: 'ollama-cloud/mimo-v2.6-flash', note: '高速' },
  { ref: 'ollama-cloud/mistral-large-4' },
  { ref: 'ollama-cloud/nemotron-3-ultra', note: '大規模' },
  { ref: 'ollama-cloud/nemotron-3-super' },
  { ref: 'ollama-cloud/inkling-2-small', note: '軽量' },
  { ref: 'ollama-cloud/clef:27b' },
  { ref: 'ollama-cloud/muse-spark-open' },
  { ref: 'ollama-cloud/beam' },
];

/** Sentinel value for the pinned search row; never a real model reference. */
export const SEARCH_ROW_VALUE = '\u0000search'

/** The endpoint and the date of the snapshot above; shown by `dkh models status`. */
export const OLLAMA_CLOUD_SOURCE = {
  url: 'https://ollama.com/v1/models',
  capturedAt: '2026-11-14',
} as const;

/**
 * Recommended defaults per provider, marked in the picker rather than reordered: existing
 * references and their positions are relied on by other callers, so the list order is stable.
 */
export const PROVIDER_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  'ollama-cloud': ['ollama-cloud/deepseek-v4.1-flash', 'ollama-cloud/glm-5.3-flash', 'ollama-cloud/glm-5.3'],
};

/** Extra suggestions for providers without a published catalogue. */
export const OTHER_SUGGESTIONS: readonly string[] = [
  'chatgpt/gpt-5.2', 'chatgpt/gpt-5.1-codex',
  'opencode/gpt-6-sol', 'opencode/gpt-5.4',
  'infron/openai/gpt-5.2', 'hermes/hermes-agent',
  'openai/gpt-5.2', 'openai/gpt-4.1',
  'anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-5',
  'google/gemini-2.5-pro', 'google/gemini-2.5-flash',
  'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner',
  'openrouter/openai/gpt-5.2', 'groq/llama-3.3-70b-versatile',
  'xai/grok-3', 'ollama/llama3.2', 'lmstudio/local-model', 'fixed/scripted',
];

function unique(refs: readonly string[]): string[] {
  return [...new Set(refs)];
}

/** Every known reference, catalogued providers first. */
export function allSuggestions(): string[] {
  return unique([...OLLAMA_CLOUD_CATALOG.map(entry => entry.ref), ...OTHER_SUGGESTIONS]);
}

/** The catalogue in display order; recommendations are marked, never moved. */
export function suggestionsFor(provider: string, current?: string | null): string[] {
  const catalog = provider === 'ollama-cloud'
    ? OLLAMA_CLOUD_CATALOG.map(entry => entry.ref)
    : OTHER_SUGGESTIONS.filter(ref => ref.startsWith(`${provider}/`));
  return unique([...catalog, ...(current ? [current] : [])]);
}

/** Marks a recommended entry for the picker without changing its position. */
export function isRecommended(ref: string): boolean {
  const provider = ref.split('/')[0] ?? '';
  return (PROVIDER_DEFAULTS[provider] ?? []).includes(ref);
}

/** Notes are advisory labels for the picker, keyed by full reference. */
export function noteFor(ref: string): string | undefined {
  return OLLAMA_CLOUD_CATALOG.find(entry => entry.ref === ref)?.note;
}
