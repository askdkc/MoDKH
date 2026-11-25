import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Model } from '../agent/types.ts';
import { AiSdkModel } from './ai-sdk.ts';
import { fetchModel } from './record-fetch.ts';
import { knownProviders, providerDefinition, type ProviderDefinition } from './providers.ts';

export interface ModelSpec {
  provider: string;
  model: string;
  /** compatible プロバイダーやプリセット上書き用の OpenAI互換 URL。 */
  baseUrl?: string;
  apiKey?: string;
  /** 無通信タイムアウト(ms)。未指定は AiSdkModel に任せる。 */
  timeoutMs?: number;
}

export class MissingKeyError extends Error {}

function localReasoningField(preset: ProviderDefinition, url: string, model: string): ProviderDefinition['localReasoningField'] {
  const endpoint = URL.parse(url);
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || /(?:[:_-]cloud|@cloud)$/i.test(model)) return;
  return preset.localReasoningField;
}

/** Ollama maps assistant reasoning (not reasoning_content) to api.Message.Thinking. */
function ollamaReasoningBody(args: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(args.messages)) return args;
  return { ...args, messages: args.messages.map((value: Record<string, unknown>) => {
    if (value.role !== 'assistant' || typeof value.reasoning_content !== 'string') return value;
    const { reasoning_content, ...rest } = value;
    return { ...rest, reasoning: reasoning_content };
  }) };
}

const localModelFetch: typeof fetch = (input, init) => fetchModel(input, { ...init, redirect: 'error' });

/** --model <provider>/<model> の解釈。モデルID自体に / を含む(openrouter 等)ため最初の / で分ける。 */
export function parseModelRef(ref: string): ModelSpec {
  const at = ref.indexOf('/');
  if (at <= 0 || at === ref.length - 1) {
    throw new Error(`--model は <provider>/<model> 形式で指定する: ${ref}`);
  }
  return { provider: ref.slice(0, at), model: ref.slice(at + 1) };
}

export { knownProviders };

/**
 * プロバイダーが要求するAPIキーの環境変数名。キー不要なら null、未知のプロバイダーは undefined。
 * 起動時の復元で「保存済みキーがあるか」を環境変数と突き合わせるために使う。
 */
export function providerKeyEnv(provider: string): string | null | undefined {
  const preset = providerDefinition(provider);
  return preset === undefined ? undefined : preset.env;
}

export function modelBaseUrl(provider: string, override?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  switch (provider) {
    case 'chatgpt': return override;
    case 'openai': return override ?? env.OPENAI_BASE_URL;
    case 'anthropic': return env.ANTHROPIC_BASE_URL;
    default: {
      const preset: ProviderDefinition | undefined = providerDefinition(provider);
      if (preset === undefined) return undefined;
      return override ?? (preset.baseURLVar ? env[preset.baseURLVar] ?? preset.baseURL : preset.baseURL);
    }
  }
}

/**
 * 接続先を組み立てる。キーが無ければ明示的に失敗する。
 * 認証失敗や通信エラーで別の接続先へ切り替えることはしない(PLAN.md の方針)。
 */
export function resolveModel(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): Model {
  const preset = providerDefinition(spec.provider);
  if (preset === undefined) {
    throw new Error(
      `未知のプロバイダー: ${spec.provider}(対応: ${knownProviders().join(', ')})。別の接続先へは自動で切り替えない。`,
    );
  }
  const baseUrl = modelBaseUrl(spec.provider, spec.baseUrl, env);
  if (spec.provider === 'compatible' && !baseUrl) {
    throw new Error('compatible プロバイダーには --base-url で互換APIのURLが必要');
  }
  const key = spec.apiKey ?? (preset.env ? env[preset.env] : undefined);

  const id = `${spec.provider}/${spec.model}`;
  const sdkOptions = { id, provider: spec.provider, ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) };
  if (preset.env && !key) {
    throw new MissingKeyError(
      `環境変数 ${preset.env} が設定されていない(--model ${id} には必要。` +
        `別の接続先へは自動で切り替えない)`,
    );
  }
  switch (spec.provider) {
    case 'openai':
      return new AiSdkModel({ ...sdkOptions, languageModel: createOpenAI({ apiKey: key!, baseURL: baseUrl, fetch: fetchModel })(spec.model) });
    case 'anthropic':
      return new AiSdkModel({ ...sdkOptions, languageModel: createAnthropic({ apiKey: key!, baseURL: baseUrl, fetch: fetchModel })(spec.model) });
    case 'google':
      return new AiSdkModel({
        ...sdkOptions,
        languageModel: createGoogleGenerativeAI({ apiKey: key!, fetch: fetchModel })(spec.model),
      });
    case 'deepseek':
      return new AiSdkModel({ ...sdkOptions, languageModel: createDeepSeek({ apiKey: key!, fetch: fetchModel })(spec.model) });
    default: {
      const reasoningField = localReasoningField(preset, baseUrl!, spec.model);
      // OpenAI互換プリセット（Ollama Local / Cloud はURLと認証情報を分離）。
      // OpenCode は user-agent と会話セッションIDを要求するため、定義側のヘッダを渡す。
      return new AiSdkModel({
        ...sdkOptions,
        ...(reasoningField ? { replayChatReasoning: true } : {}),
        languageModel: createOpenAICompatible({
          name: spec.provider,
          baseURL: baseUrl!,
          apiKey: key,
          // Compatible streaming APIs may omit prompt-token counts unless requested.
          includeUsage: spec.provider !== 'hermes',
          ...(preset.headers ? { headers: preset.headers() } : {}),
          fetch: reasoningField ? localModelFetch : fetchModel,
          ...(reasoningField === 'reasoning' ? { transformRequestBody: ollamaReasoningBody } : {}),
        })(spec.model),
      });
    }
  }
}
