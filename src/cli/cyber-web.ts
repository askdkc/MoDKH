import fs from 'node:fs';
import { oneLine, type Check } from './cyber-report.ts';
import { runTool } from './cyber-run.ts';
import { toolUrl, type ScanTarget } from './cyber-target.ts';

export interface WebStageOptions {
  target: ScanTarget;
  signal: AbortSignal;
  store: {
    write(name: string, contents: string): string;
    file(name: string): string;
    subdirectory(name: string): string;
  };
  report(check: Check): void;
}

/** Lines a Nikto text report adds as findings, without its headers and trailer. */
function niktoFindings(report: string): string[] {
  return report.split('\n')
    .map(line => line.trim())
    .filter(line => /^\+ /.test(line))
    .filter(line => !/^\+\s*(Target IP|Target Hostname|Target Port|Start Time|End Time|Server):/i.test(line))
    .filter(line => !/\d+ items? checked/i.test(line))
    .map(line => oneLine(line.replace(/^\+ /, ''), 200));
}

/**
 * Nikto is limited to configuration and default-file checks (Tuning 2). The
 * Skill forbids real user cookies and data, so only the bare URL is passed and
 * no session is reused. A run that hits the time limit is reported unfinished.
 */
async function nikto(options: WebStageOptions): Promise<Check> {
  const name = 'Nikto';
  const file = options.store.file('nikto.txt');
  const run = await runTool('nikto',
    ['-h', toolUrl(options.target), '-Tuning', '2', '-Pause', '1', '-maxtime', '5m', '-Format', 'txt', '-output', file],
    options.signal, { timeoutMs: 420_000, maxBytes: 512 * 1024 });
  if (!run.started) return { name, status: '未実行', lines: ['nikto が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name, status: '中断', lines: ['Web 設定の検査を中止しました。'] };
  if (run.timedOut) {
    return { name, status: '一部未確認', lines: ['制限時間に達しました。得られた結果は未完了として扱います。'] };
  }
  if (run.code !== 0 && run.code !== 1) {
    return { name, status: '失敗', lines: [`終了コード ${run.code} で完走しませんでした。`, oneLine(run.stderr)] };
  }
  // Nikto writes -output itself; if it did not, the stdout we captured is the report.
  const report = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : run.stdout;
  if (!fs.existsSync(file)) options.store.write('nikto.txt', report);
  const findings = niktoFindings(report);
  if (!findings.length) {
    return { name, status: '検出なし', lines: ['設定不備・デフォルトファイルの指摘はありませんでした（Tuning 2 の範囲）。'] };
  }
  return {
    name, status: '検出あり', count: findings.length,
    lines: [...findings.slice(0, 40),
      ...(findings.length > 40 ? [`ほか ${findings.length - 40} 件（保存したレポートを参照）`] : [])],
  };
}

/** sqlmap prints these when it confirms an injection point. */
function injectionEvidence(stdout: string): string[] {
  return stdout.split('\n')
    .filter(line => /Injection point|Parameter:|Type: |Title: |Payload: /.test(line))
    .map(line => oneLine(line.trim(), 220))
    .slice(0, 12);
}

async function sqlmap(options: WebStageOptions): Promise<Check> {
  const name = 'sqlmap（稼働先）';
  const output = options.store.subdirectory('sqlmap');
  const run = await runTool('sqlmap',
    ['-u', toolUrl(options.target), '--batch', '--smart', '--level', '1', '--risk', '1',
      '--output-dir', output, '--flush-session'],
    options.signal, { timeoutMs: 600_000, maxBytes: 512 * 1024 });
  if (!run.started) return { name, status: '未実行', lines: ['sqlmap が見つかりません（PATH を確認してください）。'] };
  if (run.aborted) return { name, status: '中断', lines: ['SQL インジェクションの検査を中止しました。'] };
  if (run.timedOut) {
    return { name, status: '一部未確認', lines: ['制限時間に達しました。取得済みの結果は未完了として扱います。'] };
  }
  if (run.truncated) return { name, status: '失敗', lines: ['出力が上限を超えたため、結果を採用しません。'] };
  if (/identified the following injection point/i.test(run.stdout)) {
    const evidence = injectionEvidence(run.stdout);
    return { name, status: '検出あり', count: 1,
      lines: evidence.length ? evidence : ['sqlmap が注入可能な箇所を報告しました。'] };
  }
  if (/all tested parameters do not appear to be injectable/i.test(run.stdout)) {
    return { name, status: '検出なし', lines: ['クエリ付き URL を検査し、sqlmap は注入可能なパラメータを確認できませんでした。'] };
  }
  if (run.code !== 0) {
    return { name, status: '失敗', lines: [`終了コード ${run.code} で完走しませんでした。`, oneLine(run.stderr)] };
  }
  return {
    name, status: '情報',
    lines: ['sqlmap は判定を返しませんでした。稼働先の応答を確認してください。', oneLine(run.stdout, 200)],
  };
}

/** Stage 3: web configuration and SQL handling on the running site. */
export async function runWebStage(options: WebStageOptions, withSqlmap: boolean): Promise<void> {
  if (!options.signal.aborted) options.report(await nikto(options));
  if (options.signal.aborted) {
    options.report({ name: 'sqlmap', status: '中断', lines: ['以降の検査は開始していません。'] });
    return;
  }
  if (!withSqlmap) {
    options.report({
      name: 'sqlmap', status: '未実行',
      lines: [
        options.target.hasQuery
          ? '--no-sqlmap が指定されたため起動していません。'
          : 'URL にクエリがないため、調べるパラメータがありません。',
        '注入点を調べるには、パラメータ付きの URL を指定してください。',
      ],
    });
    return;
  }
  options.report(await sqlmap(options));
}
