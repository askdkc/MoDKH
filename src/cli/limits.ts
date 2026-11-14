/**
 * Per-turn tool round-trip limit.
 *
 * This is a safety valve against a model that loops forever, not a work budget. Long tasks
 * legitimately need hundreds of round trips, so the default sits well above ordinary work and
 * the configured value can be raised up to hard ceiling that still bounds a runaway loop.
 */
import { DEFAULT_MAX_TURNS } from '../agent/loop.ts';

export { DEFAULT_MAX_TURNS };

/** Highest accepted value. Beyond this a single unattended turn could run for hours. */
export const MAX_TURNS_CEILING = 10_000;

/** Positive integers only; strings of digits are accepted because config files are hand-edited. */
export function parseMaxTurns(value: unknown): number | null {
  const numeric = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim())
    : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > MAX_TURNS_CEILING) return null;
  return numeric;
}
