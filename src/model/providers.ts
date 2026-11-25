import { randomUUID } from 'node:crypto';
import { APP_VERSION } from '../version.ts';

/**
 * 接続先の定義。モデルIDの一覧はここに固定値で持たず、`modelsPath` から実行時に取得する。
 * AIプロバイダーは追加・廃止が頻繁なため、固定リストは古くなると誤ったモデルを選ばせる。
 */
export interface ProviderDefinition {
  /** APIキーの環境変数名。キー不要なら null。 */
  env: string | null;
  /** OpenAI互換(または各社)APIのベースURL。 */
  baseURL?: string;
  /** baseURL を差し替える環境変数名。 */
  baseURLVar?: string;
  /** Assistant-history reasoning input field; only activated for loopback endpoints. */
  localReasoningField?: 'reasoning' | 'reasoning_content';
  /** モデル一覧のパス(baseURL からの相対)。一覧APIが無い場合は省略。 */
  modelsPath?: string;
  /**
   * 一覧取得の応答からモデルIDを取り出すキー。応答形は `data`/`models` の配列を自動判定する。
   * 指定がない場合は id → slug → model → model_id → name の順に探す。
   */
  idField?: string;
  /** モデルIDから取り除く接頭辞(Google の `models/` など)。 */
  idStripPrefix?: string;
  /** 一覧取得に必要な固定ヘッダ。 */
  headers?: () => Record<string, string>;
  /** キーを共有する代表プロバイダー名。 */
  keyProvider?: string;
}

/**
 * OpenCode Go は同じリクエストに会話ごとの安定したセッションIDを要求する。
 * 無いと 400 MissingSessionID が返る(実測)。プロセス単位で1つ割り当てる。
 */
const OPENCODE_SESSION = randomUUID();

/** OpenCode はクライアント識別のための user-agent とセッションIDを求める。 */
function opencodeHeaders(): Record<string, string> {
  return {
    'user-agent': `modkh/${APP_VERSION}`,
    'x-opencode-session': OPENCODE_SESSION,
  };
}

export const PROVIDERS: Readonly<Record<string, ProviderDefinition>> = {
  openai: { env: 'OPENAI_API_KEY', modelsPath: '/models' },
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    baseURL: 'https://api.anthropic.com/v1',
    modelsPath: '/models',
    headers: () => ({ 'anthropic-version': '2023-06-01' }),
  },
  google: {
    env: 'GOOGLE_GENERATIVE_AI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    modelsPath: '/models',
    idStripPrefix: 'models/',
    headers: () => ({}),
  },
  deepseek: { env: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', modelsPath: '/models' },
  openrouter: { env: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1', modelsPath: '/models' },
  // Zen と Go は別のモデル集合だが、同じ OPENCODE_API_KEY で両方を使える。
  opencode: {
    env: 'OPENCODE_API_KEY',
    baseURL: 'https://opencode.ai/zen/v1',
    baseURLVar: 'OPENCODE_BASE_URL',
    modelsPath: '/models',
    headers: opencodeHeaders,
  },
  'opencode-go': {
    env: 'OPENCODE_API_KEY',
    baseURL: 'https://opencode.ai/zen/go/v1',
    baseURLVar: 'OPENCODE_GO_BASE_URL',
    modelsPath: '/models',
    headers: opencodeHeaders,
    keyProvider: 'opencode',
  },
  infron: { env: 'INFRON_API_KEY', baseURL: 'https://llm.onerouter.pro/v1', baseURLVar: 'INFRON_BASE_URL', modelsPath: '/models' },
  // Hermes の /v1/models はエージェント自身を1件返す OpenAI 互換の最小面。
  // 詳細な provider/model 一覧は /api/model/options だが、応答形式が未検証のため使わない。
  hermes: { env: 'HERMES_API_KEY', baseURL: 'http://127.0.0.1:8642/v1', baseURLVar: 'HERMES_BASE_URL', modelsPath: '/models' },
  groq: { env: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1', modelsPath: '/models' },
  xai: { env: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1', modelsPath: '/models' },
  ollama: { env: null, baseURL: 'http://127.0.0.1:11434/v1', baseURLVar: 'OLLAMA_BASE_URL', modelsPath: '/models', localReasoningField: 'reasoning' },
  'llama-server': { env: null, baseURL: 'http://127.0.0.1:8080/v1', baseURLVar: 'LLAMA_SERVER_BASE_URL', modelsPath: '/models', localReasoningField: 'reasoning_content' },
  'ollama-cloud': { env: 'OLLAMA_API_KEY', baseURL: 'https://ollama.com/v1', baseURLVar: 'OLLAMA_CLOUD_BASE_URL', modelsPath: '/models' },
  lmstudio: { env: null, baseURL: 'http://127.0.0.1:1234/v1', baseURLVar: 'LMSTUDIO_BASE_URL', modelsPath: '/models' },
  compatible: { env: null },
};

export function providerDefinition(provider: string): ProviderDefinition | undefined {
  return Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined;
}

export function knownProviders(): string[] {
  return Object.keys(PROVIDERS);
}

/** モデル一覧を取得できるプロバイダーか。取得先が未定義なら候補を出さない。 */
export function supportsLiveModels(provider: string): boolean {
  return provider !== 'compatible' && providerDefinition(provider)?.modelsPath !== undefined;
}

/** キーを保存・解決する際の代表プロバイダー名。 */
export function keyProviderName(provider: string): string {
  return providerDefinition(provider)?.keyProvider ?? provider;
}
