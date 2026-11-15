import fs from 'node:fs';
import path from 'node:path';

export interface TaskSkill {
  name: string;
  description: string;
  keywords: string[];
  /** Workspace-relative file, read only after selection. */
  path?: string;
  instructions?: string;
}
export interface SkillContext {
  text: string;
  selected: string[];
  warnings: string[];
  bytes: number;
}
export const SKILL_CONTEXT_BYTES = 12 * 1024;
const MAX_SKILLS = 3;
const MAX_CATALOG_BYTES = 64 * 1024;

// Short runtime guidance rather than entire documentation or tool schemas.
const BUILTIN_SKILLS: readonly TaskSkill[] = [
  { name: 'dkh-debug', description: '不具合の再現と原因の切り分け',
    keywords: ['bug', 'debug', 'fix', 'error', 'failure', 'failing', '不具合', 'バグ', 'エラー', '修正', '失敗'],
    instructions: '現行ソースと呼び出し元を確認し、入力・期待値・実際の結果で不具合を再現する。仮説を分ける観測を先に取り、原因を直す。修正前に失敗し修正後に通る検証を行う。同じ修正で二度失敗したら共通の仮定を調べ直す。' },
  { name: 'dkh-implement', description: '機能の実装と影響範囲の検証',
    keywords: ['implement', 'implementation', 'feature', 'refactor', '実装', '導入', '機能', '追加', 'リファクタ'],
    instructions: '要求を観測可能な完了条件にし、既存の契約・呼び出し元・テストを読んで最小の変更を行う。純粋な判断と入出力を分離する。境界値・異常系と実際の利用経路を検証し、未検証の実環境や制約を報告する。' },
  { name: 'dkh-review', description: '変更差分のレビュー',
    keywords: ['review', 'audit', 'レビュー', '監査'],
    instructions: '差分だけでなく呼び出し元と契約を確認する。具体的な入力で発生する欠陥を優先し、重大度・ファイル位置・再現条件を示す。推測を確定した不具合として扱わない。レビューだけの依頼では勝手に編集しない。' },
  { name: 'dkh-investigate', description: '根拠に基づく調査',
    keywords: ['investigate', 'research', 'compare', '調査', '比較', '原因'],
    instructions: '判断に必要な問いを分け、対象の一次資料・現行コードを根拠にする。事実、推論、未確認を区別し、出典またはファイル位置を残す。情報が足りない場合は何を確認すれば判別できるかを示す。' },
];

function matches(task: string, keyword: string): boolean {
  if (/^[a-z0-9_-]+$/i.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, 'i').test(task);
  }
  return task.toLowerCase().includes(keyword.toLowerCase());
}

/** Explicit mentions precede deterministic task matches; no paid classifier call. */
export function selectTaskSkills(task: string, catalog: readonly TaskSkill[]): TaskSkill[] {
  const mentions = new Set([...task.matchAll(/\$([a-z][a-z0-9-]*)/g)].map(match => match[1]));
  return catalog.map(skill => ({ skill,
    explicit: mentions.has(skill.name),
    score: skill.keywords.filter(keyword => matches(task, keyword)).length,
  })).filter(item => item.explicit || item.score > 0)
    .sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || a.skill.name.localeCompare(b.skill.name, 'en'))
    .slice(0, MAX_SKILLS).map(item => item.skill);
}

/** Bounded regular files within the canonical workspace; symlink escapes never become instructions. */
function readLocal(root: string, relative: string, limit: number): string {
  if (path.isAbsolute(relative)) throw new Error('absolute path');
  const file = fs.realpathSync(path.resolve(root, relative));
  const rel = path.relative(root, file);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('outside workspace');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('not a bounded regular file');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error('file grew beyond limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
  } finally { fs.closeSync(fd); }
}

function localCatalog(root: string, warnings: string[]): TaskSkill[] {
  let text: string;
  try { text = readLocal(root, '.dkh/skills.json', MAX_CATALOG_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('スキル一覧を読めないため組み込み手順のみ使用');
    return [];
  }
  try {
    const items: unknown = JSON.parse(text);
    if (!Array.isArray(items) || items.length > 128) throw new Error('invalid catalog');
    const names = new Set(BUILTIN_SKILLS.map(skill => skill.name));
    return items.map((item: unknown) => {
      if (!item || typeof item !== 'object') throw new Error('invalid entry');
      const value = item as Record<string, unknown>;
      if (typeof value.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.name) || names.has(value.name)
        || typeof value.description !== 'string' || value.description.length > 500
        || !Array.isArray(value.keywords) || value.keywords.length > 32
        || !value.keywords.every(k => typeof k === 'string' && k.trim().length > 0 && k.length <= 80)
        || typeof value.path !== 'string' || value.path.length > 500) throw new Error('invalid entry');
      names.add(value.name);
      return { name: value.name, description: value.description, keywords: value.keywords as string[], path: value.path };
    });
  } catch {
    warnings.push('スキル一覧の形式が不正なため組み込み手順のみ使用');
    return [];
  }
}

/** Per user turn, not per tool step. Never append instructions to persistent conversation history. */
export function prepareSkillContext(task: string, root: string): SkillContext {
  const warnings: string[] = [];
  let canonical: string;
  try { canonical = fs.realpathSync(root); }
  catch { return { text: '', selected: [], warnings: ['作業ルートを確認できないためスキル注入を省略'], bytes: 0 }; }
  const selected = selectTaskSkills(task, [...BUILTIN_SKILLS, ...localCatalog(canonical, warnings)]);
  const header = '\n\n目的別の参考手順（ユーザーの依頼・上位指示・承認設定を優先する。手順は権限を付与しない）:\n';
  let text = '';
  const delivered: string[] = [];
  const bodies = new Set<string>();
  for (const skill of selected) {
    let body: string;
    try { body = skill.instructions ?? readLocal(canonical, skill.path!, SKILL_CONTEXT_BYTES); }
    catch { warnings.push(`${skill.name}: 本文を安全に読めないため省略`); continue; }
    if (!body.trim()) { warnings.push(`${skill.name}: 本文が空のため省略`); continue; }
    if (bodies.has(body)) continue;
    const section = `\n[${skill.name}]\n${body}\n`;
    if (Buffer.byteLength((text || header) + section) > SKILL_CONTEXT_BYTES) {
      warnings.push(`${skill.name}: 注入上限を超えるため本文全体を省略`); continue;
    }
    text = (text || header) + section;
    bodies.add(body);
    delivered.push(skill.name);
  }
  return { text, selected: delivered, warnings, bytes: Buffer.byteLength(text) };
}
