/**
 * 圧縮(compaction)の設定値。値の検証だけを持ち、判断は呼び出し元が行う。
 */
import { DEFAULT_COMPACTION_AUTO_BYTES, DEFAULT_COMPACTION_KEEP_TURNS, type CompactionSettings } from '../agent/compaction.ts';

export { DEFAULT_COMPACTION_KEEP_TURNS };

/** 直近ターン数。1〜50の整数のみ受け付ける。 */
export const KEEP_TURNS_MIN = 1;
export const KEEP_TURNS_MAX = 50;

export function parseKeepTurns(value: unknown): number | null {
  const numeric = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim())
    : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < KEEP_TURNS_MIN || numeric > KEEP_TURNS_MAX) return null;
  return numeric;
}

/** 自動圧縮のしきい値(推定UTF-8バイト)。0は自動圧縮を無効化する明示値。 */
export const AUTO_BYTES_MIN = 32 * 1024;
export const AUTO_BYTES_MAX = 8 * 1024 * 1024;

export function parseAutoBytes(value: unknown): number | null {
  const numeric = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim())
    : typeof value === 'number' ? value : Number.NaN;
  if (numeric === 0) return 0;
  if (!Number.isSafeInteger(numeric) || numeric < AUTO_BYTES_MIN || numeric > AUTO_BYTES_MAX) return null;
  return numeric;
}

/**
 * 設定から圧縮の実効値を決める。不正値は既定値へ戻し、その事実を warnings で返す。
 * 黙って別の値を適用しない。
 */
export function parseCompactionSettings(
  keepTurnsValue: unknown,
  autoBytesValue: unknown,
): { settings: CompactionSettings; warnings: string[] } {
  const warnings: string[] = [];
  let keepTurns = DEFAULT_COMPACTION_KEEP_TURNS;
  if (keepTurnsValue !== undefined) {
    const parsed = parseKeepTurns(keepTurnsValue);
    if (parsed === null) {
      warnings.push(`設定の compactionKeepTurns が不正なため ${DEFAULT_COMPACTION_KEEP_TURNS} を使用します。${KEEP_TURNS_MIN}〜${KEEP_TURNS_MAX} の整数`);
    } else keepTurns = parsed;
  }
  let autoBytes = DEFAULT_COMPACTION_AUTO_BYTES;
  if (autoBytesValue !== undefined) {
    const parsed = parseAutoBytes(autoBytesValue);
    if (parsed === null) {
      autoBytes = 0;
      warnings.push(`設定の compactionAutoBytes が不正なため自動圧縮は行いません。0(無効)か ${AUTO_BYTES_MIN}〜${AUTO_BYTES_MAX} の整数`);
    } else autoBytes = parsed;
  }
  return { settings: { keepTurns, autoBytes }, warnings };
}
