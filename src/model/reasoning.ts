import type { ReasoningLevel } from '../agent/types.ts';

import { harnessProfile } from './harness-profile.ts';
export type { ReasoningLevel };

/**
 * `/reasoning` のレベルと、各プロバイダーへの変換。
 * 保存するのは希望レベル。モデル別の変換は送信時だけ行う。
 */
export const REASONING_LEVELS: readonly ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'max'];

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
export function reasoningProviderOptions(provider: string, level: unknown, model = ''): Record<string, unknown> | undefined {
  const requested = parseReasoningLevel(level);
  if (!requested) return undefined;
  const slug = model.split('/').at(-1)?.toLowerCase() ?? '';
  const thinking = { type: requested === 'off' ? 'disabled' : 'enabled' };
  if (/^deepseek-v4(?:[.:-]|$)/.test(slug)) {
    const effort = requested === 'medium' ? 'high' : requested === 'minimal' ? 'low' : requested;
    return { [provider]: { thinking, ...(requested !== 'off' && { reasoningEffort: effort }) } };
  }
  if (/^glm-(?:5(?:[.:-]|$)|4\.[567](?:[:-]|$))/.test(slug)) return { [provider]: { thinking } };
  if (/^deepseek-(?:chat|reasoner|r1)(?:[:-]|$)/.test(slug)) return undefined;
  const parsed = requested === 'max' ? 'high' : requested === 'minimal' ? 'low' : requested;
  const eff = responsesReasoningEffort(requested, model);
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
export function responsesReasoningEffort(level: unknown, model = ''): string | undefined {
  const parsed = parseReasoningLevel(level);
  if (!parsed || parsed === 'off') return undefined;
  const slug = model.split('/').at(-1) ?? '';
  if (/^gpt-(?:4|3\.5)/.test(slug)) return undefined;
  if (parsed === 'max') {
    if (harnessProfile(model)) return 'max';
    if (/^gpt-5\.[234](?:-|$)/.test(slug)) return 'xhigh';
    return 'high';
  }
  if (parsed === 'minimal' && !/^gpt-5(?:-(?:mini|nano))?$/.test(slug)) return 'low';
  return parsed;
}
