import { oneLine, type Check } from './cyber-report.ts';

/** A verdict collected during the run, kept for the summary and the record file. */
export interface RecordedCheck {
  stage: string;
  check: Check;
}

export interface SummaryInput {
  checks: readonly RecordedCheck[];
  directory: string;
  aborted: boolean;
}

const UNFINISHED = ['未実行', '失敗', '一部未確認', '中断'] as const;

/**
 * The last thing a reader sees must be the findings themselves, not a file
 * path. This groups what was found by severity of consequence, then lists what
 * could not be judged, so "nothing found" and "not checked" never blur.
 */
export function writeSummary(input: SummaryInput): string[] {
  const found = input.checks.filter(entry => entry.check.status === '検出あり');
  const unfinished = input.checks.filter(entry =>
    (UNFINISHED as readonly string[]).includes(entry.check.status));
  const clean = input.checks.filter(entry =>
    entry.check.status === '検出なし' || entry.check.status === '対象なし');
  const lines: string[] = ['', '■ 発見した内容', ''];

  if (!found.length) {
    lines.push('検出ありの項目はありませんでした。');
    if (clean.length) {
      lines.push(`${clean.map(entry => entry.check.name).join(', ')} は実行して該当なしでした。`);
    }
  } else {
    lines.push(`${found.length} 項目で検出がありました。`);
    lines.push('');
    let index = 1;
    for (const entry of found) {
      const count = entry.check.count ? `（${entry.check.count}件）` : '';
      lines.push(`${index}. [${entry.check.name}]${count} — ${entry.stage}`);
      index++;
      // The check's own lines carry the evidence: CVE, path, version, file.
      for (const line of entry.check.lines.slice(0, 8)) lines.push(`   - ${oneLine(line, 220)}`);
      if (entry.check.lines.length > 8) lines.push(`   - …ほか ${entry.check.lines.length - 8} 行`);
    }
    lines.push('');
    lines.push('疑わしい検出は、実際の設定・パッケージ・コードで裏づけを取ってください。');
    lines.push('秘密情報が見つかった場合は、公開する前に先に失効・再発行してください。');
  }

  if (unfinished.length) {
    lines.push('');
    lines.push('■ 判定できなかった項目');
    lines.push('');
    for (const entry of unfinished) {
      lines.push(`- [${entry.check.name}] ${entry.check.status}: ${oneLine(entry.check.lines[0] ?? '', 160)}`);
    }
    lines.push('');
    lines.push('「未実行」「一部未確認」は、脆弱性がないという意味ではありません。');
  }

  lines.push('');
  lines.push('■ 保存したもの');
  lines.push('');
  lines.push(`- ディレクトリ: ${input.directory}`);
  lines.push('- record.md: 対象・日時・検出内容・再検査手順');
  if (input.aborted) lines.push('- 状態: 中断（以降の検査は開始していません）');
  return lines;
}

export interface RecordInput {
  target: string;
  port: string;
  host: string;
  source: string;
  startedAt: string;
  directory: string;
  checks: readonly RecordedCheck[];
  aborted: boolean;
}

/**
 * The Skill's step 4: one record of the target, the origin, the time, what was
 * found and how a recheck is run. The query and any secret value stay out: the
 * URL is used exactly as the prompt and the report already redacted it.
 */
export function writeRecord(input: RecordInput): string {
  const found = input.checks.filter(entry => entry.check.status === '検出あり');
  const lines: string[] = [
    '# /cyber 記録',
    '',
    `対象: ${input.target}`,
    `接続先: ${input.host}:${input.port}/tcp（このホストだけ。リダイレクトは追跡しない）`,
    `ソース: ${input.source}`,
    `実行開始: ${input.startedAt}`,
    `保存先: ${input.directory}`,
    `状態: ${input.aborted ? '中断（以降の検査は開始していません）' : '完了'}`,
    '',
    '## 検出・指摘',
    '',
  ];
  if (!found.length) lines.push('検出ありの項目はありませんでした。未実行・失敗・一部未確認の項目は下の一覧で確認してください。');
  for (const entry of found) {
    lines.push(`- [${entry.check.name}] ${entry.check.status}${entry.check.count ? `（${entry.check.count}件）` : ''}`);
    for (const line of entry.check.lines.slice(0, 20)) lines.push(`  - ${oneLine(line, 400)}`);
  }
  lines.push('', '## 全項目', '');
  for (const entry of input.checks) {
    lines.push(`- ${entry.stage} / ${entry.check.name}: ${entry.check.status}`
      + (entry.check.count ? `（${entry.check.count}件）` : ''));
  }
  lines.push('', '## 再検査', '');
  lines.push('1. 検出を実際の設定・パッケージ・コードで裏づけ、修正する。');
  lines.push('2. 同じ接続元・同じ対象で、同じオプションの `/cyber` を再実行する。');
  lines.push('3. 閉じたいポートが到達不能になり、必要なサービスは使えることを確認する。');
  lines.push('4. 対象、接続元、日時、デプロイ版、検出・修正内容、再検査結果をこの記録に追記する。');
  lines.push('');
  lines.push('スキャン結果は公開しない。キーが見つかった場合は先に失効・再発行する。');
  return `${lines.join('\n')}\n`;
}
