import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Model } from '../agent/types.ts';
import { AiSdkModel } from './ai-sdk.ts';

export interface ModelSpec {
  provider: string;
  model: string;
  /** compatible プロバイダーやプリセット上書き用の OpenAI互換 URL。 */
  baseUrl?: string;
  apiKey?: string;
}

export class MissingKeyError extends Error {}

/** --model <provider>/<model> の解釈。モデルID自体に / を含む(openrouter 等)ため最初の / で分ける。 */
export function parseModelRef(ref: string): ModelSpec {
  const at = ref.indexOf('/');
  if (at <= 0 || at === ref.length - 1) {
    throw new Error(`--model は <provider>/<model> 形式で指定する: ${ref}`);
  }
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}

interface Preset {
  env: string | null;
  baseURL?: string;
  /** プリセットの baseURL を環境変数で差し替えられる場合、その変数名。 */
  baseURLVar?: string;
}

const PRESETS: Record<string, Preset> = {
  openai: { env: 'OPENAI_API_KEY' },
  anthropic: { env: 'ANTHROPIC_API_KEY' },
  google: { env: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  deepseek: { env: 'DEEPSEEK_API_KEY' },
  openrouter: { env: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1' },
  opencode: { env: 'OPENCODE_API_KEY', baseURL: 'https://opencode.ai/inference/openai/v1', baseURLVar: 'OPENCODE_BASE_URL' },
  infron: { env: 'INFRON_API_KEY', baseURL: 'https://llm.onerouter.pro/v1', baseURLVar: 'INFRON_BASE_URL' },
  hermes: { env: 'HERMES_API_KEY', baseURL: 'http://127.0.0.1:8642/v1', baseURLVar: 'HERMES_BASE_URL' },
  groq: { env: 'GROQ_API_KEY', baseURL: 'https://api.groq.com/openai/v1' },
  xai: { env: 'XAI_API_KEY', baseURL: 'https://api.x.ai/v1' },
  ollama: { env: null, baseURL: 'http://127.0.0.1:11434/v1', baseURLVar: 'OLLAMA_BASE_URL' },
  'ollama-cloud': { env: 'OLLAMA_API_KEY', baseURL: 'https://ollama.com/v1', baseURLVar: 'OLLAMA_CLOUD_BASE_URL' },
  lmstudio: { env: null, baseURL: 'http://127.0.0.1:1234/v1', baseURLVar: 'LMSTUDIO_BASE_URL' },
  compatible: { env: null },
};

export function knownProviders(): string[] {
  return Object.keys(PRESETS);
}

/**
 * 接続先を組み立てる。キーが無ければ明示的に失敗する。
 * 認証失敗や通信エラーで別の接続先へ切り替えることはしない(PLAN.md の方針)。
 */
export function resolveModel(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): Model {
  const preset = PRESETS[spec.provider];
  if (preset === undefined) {
    throw new Error(
      `未知のプロバイダー: ${spec.provider}(対応: ${knownProviders().join(', ')})。別の接続先へは自動で切り替えない。`,
    );
  }
  const presetBaseUrl = preset.baseURLVar ? (env[preset.baseURLVar] ?? preset.baseURL) : preset.baseURL;
  const baseUrl = spec.baseUrl ?? presetBaseUrl;
  if (spec.provider === 'compatible' && !baseUrl) {
    throw new Error('compatible プロバイダーには --base-url で互換APIのURLが必要');
  }
  const key = spec.apiKey ?? (preset.env ? env[preset.env] : undefined);

  const id = `${spec.provider}/${spec.model}`;
  if (preset.env && !key) {
    throw new MissingKeyError(
      `環境変数 ${preset.env} が設定されていない(--model ${id} には必要。` +
        `別の接続先へは自動で切り替えない)`,
    );
  }
  switch (spec.provider) {
    case 'openai':
      return new AiSdkModel({ id, languageModel: createOpenAI({ apiKey: key!, baseURL: baseUrl })(spec.model) });
    case 'anthropic':
      return new AiSdkModel({ id, languageModel: createAnthropic({ apiKey: key! })(spec.model) });
    case 'google':
      return new AiSdkModel({
        id,
        languageModel: createGoogleGenerativeAI({ apiKey: key! })(spec.model),
      });
    case 'deepseek':
      return new AiSdkModel({ id, languageModel: createDeepSeek({ apiKey: key! })(spec.model) });
    default:
      // OpenAI互換プリセット（Ollama Local / Cloud はURLと認証情報を分離）。
      return new AiSdkModel({
        id,
        languageModel: createOpenAICompatible({
          name: spec.provider,
          baseURL: baseUrl!,
          apiKey: key,
        })(spec.model),
      });
  }
}
