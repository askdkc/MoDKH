/** Child slots only; the parent always retains its own model slot. */
export const DEFAULT_SUBAGENT_LIMIT = 2;
// Scheduling defaults, not estimates of provider capacity. Unknown endpoints stay conservative.
const cloudProviders = new Set(['openai', 'chatgpt', 'anthropic', 'google', 'deepseek', 'openrouter', 'opencode',
  'opencode-go', 'infron', 'groq', 'xai', 'ollama-cloud']);
export function providerSubagentLimit(modelId: string | null): number {
  const slash = modelId?.indexOf('/') ?? -1;
  return modelId && slash > 0 && modelId.slice(slash + 1).trim() && cloudProviders.has(modelId.slice(0, slash))
    ? 12 : DEFAULT_SUBAGENT_LIMIT;
}
export function parseSubagentLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}
