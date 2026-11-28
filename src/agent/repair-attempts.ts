import path from 'node:path';
import { createHash } from 'node:crypto';
import { evidenceExcerpt } from './saved-results.ts';
import type { ToolCall, ToolResult } from './types.ts';

function editTarget(call: ToolCall): string | undefined {
  if ((call.name === 'edit_file' || call.name === 'create_file') && typeof call.args.path === 'string') {
    return path.normalize(call.args.path);
  }
}

interface Check {
  key: string;
  evidence: string;
  label: string;
}

function checkedOutcome(call: ToolCall, result: ToolResult): Check | undefined {
  if (result.status !== 'ok' && result.status !== 'error') return;
  if (call.name === 'run_command') {
    const exit = /^\[exit code: (\d+)\]/u.exec(result.output);
    if (!exit) return;
    const key = JSON.stringify([call.name, call.args.command, call.args.cwd ?? '.', call.args.shell]);
    // Keep changing diagnostics (including failure counts) distinct. Ignore runner timings.
    const stable = result.output.replace(/(duration_ms:\s*)[\d.]+|\b[\d.]+\s*(?:ms|milliseconds)\b/gu, '<time>');
    const evidence = exit[1] === '0' ? '' : createHash('sha256').update(stable).digest('hex');
    return { key, evidence, label: '同じコマンドで同じ失敗が続いています。' };
  }
  if (result.status !== 'ok') return;
  const browser = call.name === 'browse';
  const action = browser ? call.args.action : call.name;
  const key = JSON.stringify([action, browser ? call.args.tab : call.args.path, call.args.ref, call.args.full]);
  if ((browser && action === 'screenshot' || call.name === 'view_image') && result.image) {
    // Pixels can change with animation. A fourth edit after reviewing the same view is the signal.
    return { key, evidence: 'visual', label: '同じ画像や画面を確認したあと、さらに編集しようとしています。' };
  }
  if (browser && action === 'snapshot') {
    return { key, evidence: createHash('sha256').update(result.output).digest('hex'), label: '同じ画面を確認しても内容が変わっていません。' };
  }
}

/** Only fresh tool executions enter this tracker. Several checks of one revision count once. */
export class RepairAttempts {
  private edits = new Set<string>();
  private targets = new Set<string>();
  private revision = 0;
  private checks = new Map<string, { revision: number; evidence: string; count: number; label: string }>();

  observe(call: ToolCall, result: ToolResult): void {
    const target = editTarget(call);
    if (target && result.status === 'ok') {
      this.edits.add(target);
      return;
    }
    if (!this.edits.size && !this.targets.size) return;
    const check = checkedOutcome(call, result);
    if (!check) return;
    if (this.edits.size) {
      if (this.edits.size !== this.targets.size || [...this.edits].some(file => !this.targets.has(file))) {
        this.checks.clear();
      }
      this.targets = this.edits;
      this.edits = new Set();
      this.revision++;
    }
    const previous = this.checks.get(check.key);
    if (!check.evidence) {
      this.checks.delete(check.key);
      return;
    }
    const count = previous?.evidence === check.evidence
      ? previous.count + Number(previous.revision !== this.revision) : 1;
    this.checks.set(check.key, { revision: this.revision, evidence: check.evidence, count, label: check.label });
  }

  questionBefore(call: ToolCall): string | undefined {
    const target = editTarget(call);
    if (!target || !this.targets.has(target)) return;
    for (const check of this.checks.values()) {
      if (check.count >= 3 && check.revision === this.revision) {
        const file = evidenceExcerpt(target, 200);
        return `「${file}」の修正と確認を3回繰り返しました。${check.label} 次の編集を保留しました。修正を続けますか？ 続ける場合は期待する結果や方針を教えてください。`;
      }
    }
  }
}
