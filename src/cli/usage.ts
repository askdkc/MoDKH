/** Token accounting for the status footer. Values are reported by the provider, never estimated. */
import { textWidth } from './editor.ts';
import type { TokenUsage } from '../agent/types.ts';

export interface UsageTotals extends TokenUsage {
  responses: number;
}

export const EMPTY_USAGE: UsageTotals = { responses: 0 };

/** A reported zero is meaningful; missing or invalid data stays unknown. */
function count(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sumReported(total: number | undefined, value: number | undefined): number | undefined {
  return value === undefined ? total : (total ?? 0) + value;
}

export function addUsage(total: UsageTotals, reported: TokenUsage): UsageTotals {
  const input = count(reported.input);
  const output = count(reported.output);
  const cacheRead = count(reported.cacheRead);
  const cacheWrite = count(reported.cacheWrite);
  const uncachedInput = count(reported.uncachedInput) ?? (
    input !== undefined && cacheRead !== undefined && cacheWrite !== undefined
      ? count(input - cacheRead - cacheWrite) : undefined
  );
  if ([input, output, cacheRead, cacheWrite, uncachedInput].every(value => value === undefined)) return total;
  return {
    input: sumReported(total.input, input),
    uncachedInput: sumReported(total.uncachedInput, uncachedInput),
    output: sumReported(total.output, output),
    cacheRead: sumReported(total.cacheRead, cacheRead),
    cacheWrite: sumReported(total.cacheWrite, cacheWrite),
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
  if (!usage.input || usage.cacheRead === undefined) return undefined;
  return Math.min(100, Math.round((usage.cacheRead / usage.input) * 100));
}

/** One footer line, most useful numbers first. `width` is the usable cell width; narrower terminals
 * drop trailing fields instead of wrapping, so the composer never moves. */
export function usageFooter(usage: UsageTotals, width: number): string {
  if (usage.responses === 0) return '';
  const rate = cacheHitRate(usage);
  const fields = [
    `計 ${compactTokens((usage.input ?? 0) + (usage.output ?? 0))} tok`,
    ...(rate === undefined ? [] : [`cache ${rate}%`]),
    `入 ${compactTokens(usage.input ?? 0)}`,
    `出 ${compactTokens(usage.output ?? 0)}`,
  ];
  // Drop trailing fields rather than wrapping: the footer must never move the composer.
  const lines = fields.map((_, index) => fields.slice(0, index + 1).join(' · '));
  for (const line of [...lines].reverse()) if (line.length <= width) return line;
  return fields[fields.length - 1];
}

/** 右下ステータス用のコンパクトな使用量表示。maxWidth を超えるときは後ろの項目から落とす。
 * 幅は textWidth(表示幅)で測る(全角の「計」なども2セルとして数える)。 */
export function usageBadgeLine(usage: UsageTotals, maxWidth?: number): string {
  if (usage.responses === 0) return '';
  const rate = cacheHitRate(usage);
  const fields = [
    `計 ${compactTokens((usage.input ?? 0) + (usage.output ?? 0))} tok`,
    ...(rate === undefined ? [] : [`cache ${rate}%`]),
    `in ${compactTokens(usage.input ?? 0)}`,
    `out ${compactTokens(usage.output ?? 0)}`,
  ];
  const lines = fields.map((_, index) => fields.slice(0, index + 1).join(' · '));
  if (maxWidth === undefined) return lines[lines.length - 1];
  for (const line of [...lines].reverse()) if (textWidth(line) <= maxWidth) return line;
  return '';
}

const breakdownNumber = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function usageBreakdown(usage: UsageTotals): string {
  return usage.responses === 0 ? 'トークン使用量はまだ報告されていません' : usageBreakdownLines(usage).join('\n');
}

export function usageBreakdownLines(usage: UsageTotals, minWidth = 0): string[] {
  const total = usage.input === undefined && usage.output === undefined
    ? undefined : (usage.input ?? 0) + (usage.output ?? 0);
  const rows: [string, number | undefined][] = [
    ['トークン消費量', total],
    ['未キャッシュ入力', usage.uncachedInput],
    ['キャッシュ読み取り', usage.cacheRead],
    ['キャッシュ書き込み', usage.cacheWrite],
    ['出力', usage.output],
  ];
  const labels = Math.max(...rows.map(([label]) => textWidth(label)));
  const values = rows.map(([, value]) => value === undefined ? '—' : breakdownNumber.format(value));
  const width = Math.max(minWidth - labels - 2, ...values.map(textWidth));
  return rows.map(([label], i) => label + ' '.repeat(labels - textWidth(label) + 2 + width - textWidth(values[i])) + values[i]);
}
