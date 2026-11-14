/** Token accounting for the status footer. Values are reported by the provider, never estimated. */
export interface UsageTotals {
  /** Input tokens, including cached prefixes. */
  input: number;
  output: number;
  /** Input tokens served from the provider's prompt cache. */
  cacheRead: number;
  /** Input tokens written to the provider's prompt cache. */
  cacheWrite: number;
  /** Responses counted into the totals; lets the footer stay quiet until real data exists. */
  responses: number;
}

export const EMPTY_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 };

export interface ReportedUsage {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
}

/** Invalid, negative or non-finite provider values are ignored rather than shown as data. */
function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function addUsage(total: UsageTotals, reported: ReportedUsage): UsageTotals {
  const input = count(reported.input), output = count(reported.output);
  const cacheRead = count(reported.cacheRead), cacheWrite = count(reported.cacheWrite);
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return total;
  return {
    input: total.input + input,
    output: total.output + output,
    cacheRead: total.cacheRead + cacheRead,
    cacheWrite: total.cacheWrite + cacheWrite,
    responses: total.responses + 1,
  };
}

/** 142,296,676 -> 142M. Keeps the footer short while staying recognizable. */
export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 100_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

/** Share of input tokens served from cache. Undefined when the provider reports no input. */
export function cacheHitRate(usage: UsageTotals): number | undefined {
  if (usage.input <= 0) return undefined;
  return Math.min(100, Math.round((usage.cacheRead / usage.input) * 100));
}

/**
 * One footer line, most useful numbers first. `width` is the usable cell width; narrower terminals
 * drop trailing fields instead of wrapping, so the composer never moves.
 */
export function usageFooter(usage: UsageTotals, width: number): string {
  if (usage.responses === 0) return '';
  const rate = cacheHitRate(usage);
  const fields = [
    `計 ${compactTokens(usage.input + usage.output)} tok`,
    ...(rate === undefined ? [] : [`cache ${rate}%`]),
    `入 ${compactTokens(usage.input)}`,
    `出 ${compactTokens(usage.output)}`,
  ];
  // Drop trailing fields rather than wrapping: the footer must never move the composer.
  const lines = fields.map((_, index) => fields.slice(0, index + 1).join(' · '));
  for (const line of [...lines].reverse()) if (line.length <= width) return line;
  return fields[fields.length - 1];
}
