import type { ReasoningLevel } from '../agent/types.ts';

export type { ReasoningLevel };

/**
 * `/reasoning` のレベルと、各プロバイダーへの変換。
 * 対応していないレベル・プロバイダーは「送らない」を返す仕様(既定の初期値に任せる)。
 */
export const REASONING_LEVELS: readonly ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

export function parseReasoningLevel(value: unknown): ReasoningLevel | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if ((REASONING_LEVELS as readonly string[]).includes(normalized)) return normalized as ReasoningLevel;
  return null;
}

/** Anthropic の思考バジェット。最小1024推奨を守る。 */
const ANTHROPIC_BUDGET: Partial<Record<ReasoningLevel, number>> = { low: 2048, medium: 8192, high: 16384 };
const GOOGLE_BUDGET: Partial<Record<ReasoningLevel, number>> = { off: 0, low: 2048, medium: 8192, high: 24576 };

/**
 * プロバイダー名 → providerOptions。off は openai 系では送らない(省略 = 初期値)、
 * google では thinkingBudget:0 で無効化を明示する。chatgpt/deepseek/fixed は対象外。
 * unknown レベルは必ず undefined(誤ったパラメーターをそのまま送らない)。
 */
export function reasoningProviderOptions(provider: string, level: unknown): Record<string, unknown> | undefined {
  if (level === null || typeof level !== 'string') return undefined;
  const parsed = parseReasoningLevel(level);
  if (!parsed) return undefined;
  const eff = parsed === 'off' ? undefined : parsed === 'minimal' ? 'minimal' : parsed;
  switch (provider) {
    case 'openai':
      return eff === undefined ? undefined : { openai: { reasoningEffort: eff } };
    case 'anthropic': {
      const budget = ANTHROPIC_BUDGET[parsed];
      if (!budget) return undefined;
      return { anthropic: { thinking: { type: 'enabled', budgetTokens: budget } } };
    }
    case 'google': {
      const budget = GOOGLE_BUDGET[parsed];
      if (budget === undefined && parsed !== 'off') return undefined;
      return { google: { thinkingConfig: { thinkingBudget: budget ?? 0 } } };
    }
    // ChatGPT(Responses直送・CLI側で付与)と fixed/deepseek はパス。
    case 'chatgpt':
    case 'deepseek':
    case 'fixed':
      return undefined;
    default: {
      // OpenAI互換系(ollama / openrouter / compatible など)は
      // providerOptions[プロバイダー名] → reasoning_effort として送受される。
      return eff === undefined ? undefined : { [provider]: { reasoningEffort: eff } };
    }
  }
}

/** Responses(Codex) API の reasoning effort。off と未知のレベルはキー自体を送らない。 */
export function responsesReasoningEffort(level: unknown): string | undefined {
  const parsed = parseReasoningLevel(level);
  if (!parsed || parsed === 'off') return undefined;
  return parsed;
}
