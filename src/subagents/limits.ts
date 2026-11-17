/** Child slots only; the parent always retains its own model slot. */
export const DEFAULT_SUBAGENT_LIMIT = 2;
export const MAX_SUBAGENT_LIMIT = 16;
export function parseSubagentLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SUBAGENT_LIMIT ? value : null;
}
