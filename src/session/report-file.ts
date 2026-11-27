import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { assertRealInRoot, resolveInRoot } from '../tools/guard.ts';
import type { ApprovalGate } from '../agent/types.ts';
import type { ReportDraft } from './store.ts';

const MAX_REPORT_BYTES = 8 * 1024 * 1024;
type ReportEdit = NonNullable<ReportDraft['edits']>[number];

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Allow a dead owner's lease to expire, while a live writer keeps refreshing it. */
export function lockReport(file: string, lockfilePath?: string): Promise<() => Promise<void>> {
  return lockfile.lock(file, { realpath: false, lockfilePath, stale: 3000, update: 1000,
    retries: { retries: 12, minTimeout: 400, maxTimeout: 400 } });
}

export function reportFile(root: string, name: string): string {
  const file = resolveInRoot(root, name);
  const relative = path.relative(root, file);
  if (!/\.(?:md|txt)$/iu.test(relative) || /[\x00-\x1f\x7f]/u.test(name)
    || relative.split(path.sep).some(part => part.startsWith('.')) || name.split(path.sep).includes('..')) {
    throw new Error('保存先には作業ディレクトリ内の Markdown またはテキストファイルを指定してください');
  }
  // Pin every existing path component. A renamed symlink must never redirect an approved write.
  let parent = fs.realpathSync(root);
  for (const part of relative.split(path.sep)) {
    parent = path.join(parent, part);
    if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('レポートの保存先がシンボリックリンクです');
  }
  assertRealInRoot(root, file);
  return parent;
}

export function readReport(file: string): string | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) throw new Error('既存のレポートを安全に読み取れません');
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('既存のレポートは UTF-8 ではありません');
  return text;
}

export function reportMatches(root: string, report: { path: string; digest: string }): boolean {
  const content = readReport(reportFile(root, report.path));
  return content !== null && digest(content) === report.digest;
}

export function prepareReport(name: string, before: string | null, body: string): ReportDraft {
  const section = body.trimEnd() + '\n';
  // Keep an existing draft byte-for-byte, including any material outside the model's context.
  const addition = before?.trimEnd().endsWith(section.trimEnd()) ? ''
    : before ? (before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n') + section : section;
  return { path: name, before: before === null ? null : digest(before), addition, after: digest((before ?? '') + addition) };
}

function reportLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

/** Show only complete numbered lines. An omitted line can never become an edit target. */
export function reportExcerpt(text: string, budget: number) {
  const lines = reportLines(text).map((line, index) => `${index + 1}\t${line.trimEnd()}\n`);
  const visible = new Set<number>();
  const sizes = lines.map(line => Buffer.byteLength(line));
  const frontBudget = sizes.reduce((sum, size) => sum + size, 0) <= budget ? budget : Math.floor(budget / 2);
  let used = 0, left = 0, right = lines.length;
  while (left < right && used + sizes[left] <= frontBudget) {
    used += sizes[left];
    visible.add(++left);
  }
  while (right > left && used + sizes[right - 1] <= budget) {
    used += sizes[right - 1];
    visible.add(right--);
  }
  return { text: lines.slice(0, left).join('') + (left < right ? '[…lines omitted…]\n' : '') + lines.slice(right).join(''), visible };
}

function revisedContent(before: string, edits: ReportEdit[]): string {
  const lines = reportLines(before);
  let end = lines.length;
  const result: string[] = [];
  for (const edit of [...edits].reverse()) {
    if (!Number.isSafeInteger(edit.first) || !Number.isSafeInteger(edit.last) || typeof edit.text !== 'string'
      || edit.first < 1 || edit.first > edit.last || edit.last > end) throw new Error('編集対象の行範囲が重複しているか範囲外です');
    result.unshift(lines.slice(edit.last, end).join(''));
    if (edit.text) {
      const ending = lines[edit.last - 1].match(/\r?\n$/u)?.[0] ?? '';
      result.unshift(edit.text.replace(/\r?\n$/u, '').replace(/\r?\n/gu, ending || '\n') + ending);
    }
    end = edit.first - 1;
  }
  return lines.slice(0, end).join('') + result.join('');
}

/** Decode editorial changes against the snapshot the model saw. Free-form process notes are never a patch. */
export function reviseReport(name: string, before: string, response: string, visible: Set<number>): ReportDraft {
  const json = response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu, '$1');
  const proposal = JSON.parse(json);
  if (proposal?.unchanged === true && Object.keys(proposal).length === 1) {
    return { path: name, before: digest(before), after: digest(before), addition: '' };
  }
  if (typeof proposal?.append === 'string' && proposal.append.trim() && Object.keys(proposal).length === 1) return prepareReport(name, before, proposal.append);
  if (!Array.isArray(proposal?.edits) || !proposal.edits.length || Object.keys(proposal).length !== 1) throw new Error('本文の編集には行範囲と置換文が必要です');
  const edits: ReportEdit[] = proposal.edits;
  for (const edit of edits) {
    if (!edit || !visible.has(edit.first) || !visible.has(edit.last) || edit.last - edit.first + 1 > visible.size) throw new Error('表示していない行は変更できません');
    for (let line = edit.first; line <= edit.last; line++) if (!visible.has(line)) throw new Error('省略された行は変更できません');
  }
  edits.sort((a, b) => a.first - b.first);
  const after = revisedContent(before, edits);
  if (!after.trim()) throw new Error('既存のレポート全体を空にはできません');
  return { path: name, before: digest(before), after: digest(after), addition: '', edits };
}

/** Compare the journaled pre/post images before publishing. A crash after rename is a readback. */
export async function publishReport(root: string, draft: ReportDraft, approval: ApprovalGate, signal: AbortSignal): Promise<boolean> {
  const file = reportFile(root, draft.path);
  const before = readReport(file);
  if (before !== null && digest(before) === draft.after) return true;
  if ((before === null ? null : digest(before)) !== draft.before) throw new Error('レポートが執筆中に変更されました。現在のファイルを保持しました');
  const content = (draft.edits ? revisedContent(before ?? '', draft.edits) : before ?? '') + draft.addition;
  if (Buffer.byteLength(content) > MAX_REPORT_BYTES) throw new Error('レポートが保存上限の8 MiBを超えました');
  if (digest(content) !== draft.after) throw new Error('保存予定のレポートとセッション記録が一致しません');
  const detail = draft.edits ? draft.edits.map(edit => `${edit.first}–${edit.last}行を置換\n${edit.text || '（削除）'}`).join('\n') : draft.addition;
  if (signal.aborted || !await approval.approve({ kind: 'edit', title: `レポートを保存 ${draft.path}`, detail, outsideWorkspace: false, signal }) || signal.aborted) return false;
  if (reportFile(root, draft.path) !== file) throw new Error('レポートの保存先が変わりました');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const unlock = await lockReport(file);
  const temporary = path.join(path.dirname(file), '.modkh-report-' + randomUUID());
  try {
    if (signal.aborted) return false;
    const current = readReport(reportFile(root, draft.path));
    if (current !== null && digest(current) === draft.after) return true;
    if (current !== before) throw new Error('レポートの保存先が変更されました');
    const mode = current === null ? 0o600 : fs.statSync(file).mode & 0o777;
    fs.writeFileSync(temporary, content, { flag: 'wx', mode, flush: true });
    if (current === null) fs.linkSync(temporary, file); // Do not replace a concurrent creation.
    else {
      fs.chmodSync(temporary, mode);
      if (readReport(reportFile(root, draft.path)) !== current) throw new Error('レポートの保存先が変更されました');
      fs.renameSync(temporary, file);
    }
    if (readReport(reportFile(root, draft.path)) !== content) throw new Error('レポートの読み戻しが一致しません');
    return true;
  } finally {
    try { fs.rmSync(temporary, { force: true }); } finally { await unlock(); }
  }
}
