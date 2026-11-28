/**
 * One /cyber check result. The status is the verdict a reader needs first:
 * 検出あり (evidence found), 検出なし (ran, nothing found), 未実行 (did not run),
 * 失敗 (ran but could not produce a verdict), 中断 (stopped), 情報 (observation
 * without a security verdict, e.g. resolved addresses or an open port).
 */
export type CheckStatus = '検出あり' | '検出なし' | '未実行' | '失敗' | '中断' | '情報' | '対象なし' | '一部未確認';

export interface CheckResult {
  /** Tool or check name shown in brackets. */
  name: string;
  status: CheckStatus;
  /** Confirmed findings; shown only with 検出あり so the count never includes observations. */
  count?: number;
  lines: string[];
}

export function writeCheck(write: (text: string) => void, result: CheckResult): void {
  const count = result.status === '検出あり' && result.count ? `（${result.count}件）` : '';
  write(`[${result.name}] ${result.status}${count}\n`);
  for (const line of result.lines) write(`  ${line}\n`);
}

/** Keep tool-controlled text on one line and inside a readable width. */
export function oneLine(text: string, limit = 240): string {
  const flattened = text.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return flattened.length > limit ? `${flattened.slice(0, limit)}…` : flattened;
}
