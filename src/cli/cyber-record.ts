import { oneLine, type Check } from './cyber-report.ts';

/** A verdict collected during the run, kept for the record file. */
export interface RecordedCheck {
  stage: string;
  check: Check;
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

function stageTitle(stage: string): string {
  return stage;
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
    lines.push(`- ${stageTitle(entry.stage)} / ${entry.check.name}: ${entry.check.status}`
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
