import fs from 'node:fs';
import path from 'node:path';
import { bundledSkills, readBundledSkill, DKH_SKILL_BINDING } from './bundled-skills.ts';

export interface TaskSkill {
  name: string;
  description: string;
  keywords: string[];
  /** Workspace-relative file, read only after selection. */
  path?: string;
  bundled?: boolean;
  instructions?: string;
}
export interface SkillContext {
  text: string;
  selected: string[];
  warnings: string[];
  bytes: number;
}
export const SKILL_CONTEXT_BYTES = 48 * 1024;
const LOCAL_SKILL_BYTES = 12 * 1024;
const MAX_SKILLS = 3;
const MAX_CATALOG_BYTES = 64 * 1024;

const ROUTES: Record<string, string[]> = {
  'kiokuko-investigate': ['investigate', 'research', 'explain', '調査', '原因', '説明'],
  'kiokuko-architecture': ['architecture', 'design', '設計', 'アーキテクチャ'],
  'kiokuko-review': ['review', 'audit', 'レビュー', '監査'],
  'kiokuko-benchmark': ['benchmark', 'performance', 'speed', 'ベンチマーク', '性能', '高速化'],
  'kiokuko-verification': ['verify', 'test', '検証', 'テスト'],
  'kiokuko-skill-authoring': ['skill', 'skills', 'スキル'],
  'kiokuko-technical-writing': ['readme', 'documentation', 'ドキュメント', '手順書'],
  'kiokuko-simple-work': ['minimal', 'simple', 'yagni', '最小', '簡単'],
  'kiokuko-ui-design-soul': ['ui', 'ux', 'frontend', '画面', 'レイアウト', 'フォーム'],
  'veteran-programmer-skill': ['install', 'deploy', 'migration', 'state', '配布', '導入', '状態', '移行'],
  'memory-reasoning': ['memory', '記憶'],
  'kiokuko-lisp': ['lisp', 'sbcl', 'common-lisp'],
};
const CODING = ['implement', 'implementation', 'feature', 'refactor', 'fix', 'debug', 'bug', 'coding', 'code', '実装', '機能', '修正', 'バグ', 'コード', 'リファクタ', '導入'];
const CODING_CORE = ['coding-ideal-routine-skill', 'one-shot-software-completion', 'kiokuko-single-purpose-functions'];
function builtinCatalog(): TaskSkill[] {
  return bundledSkills().map(skill => ({ name: skill.name, description: skill.description, keywords: ROUTES[skill.name] ?? [], bundled: true }));
}

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

function localCatalog(root: string, warnings: string[], builtin: readonly TaskSkill[]): TaskSkill[] {
  let text: string;
  try { text = readLocal(root, '.dkh/skills.json', MAX_CATALOG_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('スキル一覧を読めないため組み込み手順のみ使用');
    return [];
  }
  try {
    const items: unknown = JSON.parse(text);
    if (!Array.isArray(items) || items.length > 128) throw new Error('invalid catalog');
    const names = new Set(builtin.map(skill => skill.name));
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
  let builtin: TaskSkill[] = [];
  try { builtin = builtinCatalog(); }
  catch { warnings.push('同梱スキル一覧を読めないため注入を省略'); }
  const catalog = [...builtin, ...localCatalog(canonical, warnings, builtin)];
  const optional = selectTaskSkills(task, catalog);
  const names = new Set(optional.map(skill => skill.name));
  const coding = CODING.some(word => matches(task, word));
  if (coding) for (const name of CODING_CORE) names.add(name);
  if (matches(task, 'review') || matches(task, 'レビュー')) names.add('kiokuko-single-purpose-functions');
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(task) || matches(task, 'Japanese')) names.add('natural-japanese-output');
  if (names.size) names.add('kiokuko-soul');
  // Host entry and mandatory code guidance precede optional specialists; no top-three cutoff on core contracts.
  const order = ['kiokuko-soul', ...CODING_CORE, ...optional.map(skill => skill.name), 'natural-japanese-output'];
  const selected = [...new Set(order)].filter(name => names.has(name)).map(name => catalog.find(skill => skill.name === name)).filter((skill): skill is TaskSkill => !!skill);
  const header = '\n\n' + DKH_SKILL_BINDING;
  let text = '';
  const delivered: string[] = [];
  const bodies = new Set<string>();
  for (const skill of selected) {
    let body: string;
    try { body = skill.bundled ? readBundledSkill(skill.name) : skill.instructions ?? readLocal(canonical, skill.path!, LOCAL_SKILL_BYTES); }
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
