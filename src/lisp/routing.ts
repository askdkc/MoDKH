import type { PluginDescriptor } from '../plugins/api.ts';
import type { DelegationRequest } from '../subagents/types.ts';
const EXT: Record<string, string> = { php: 'php', lisp: 'common-lisp', cl: 'common-lisp', asd: 'common-lisp', js: 'js', mjs: 'js', ts: 'ts', mts: 'ts', svelte: 'svelte', html: 'html', css: 'css', tla: 'tla', lean: 'lean' };
/** Conservative opt-in rules, never described as LLM judgment. Ambiguity delegates nothing. */
export function routeIntent(task: string, available: PluginDescriptor[]): DelegationRequest | undefined {
  if (/\b(if|unless|not|don't|without|maybe|or)\b|しない|するな|不要|なら|場合|もし|または|https?:|\.\.|[\\]/i.test(task)) return;
  const files = [...task.matchAll(/(?:^|\s|`)([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.[a-z]+)(?=$|\s|`|[、。])/g)].map(m => m[1]);
  if (files.length !== 1) return;
  const language = EXT[files[0].split('.').at(-1)!];
  if (!language) return;
  const rules: [string, RegExp][] = [['outline', /\b(outline|structure)\b|構造/], ['definition', /\bdefinition\b|定義/], ['references', /\breferences\b|参照/], ['diagnostics', /\bdiagnostics\b|診断/], ['hover', /\bhover\b|ホバー/], ['edit', /\b(edit|fix|change)\b|修正|編集/], ['verify', /\bverify\b|検証/]];
  const kinds = rules.filter(([, re]) => re.test(task));
  if (kinds.length !== 1) return;
  const matches = available.filter(d => d.language === language && d.taskKind === kinds[0][0]);
  if (matches.length !== 1) return;
  return { pluginId: matches[0].id, task, ...(kinds[0][0] === 'edit' ? { targetPaths: files } : {}) };
}
export function routeRole(language: string, taskKind: string, task: string, available: PluginDescriptor[]): DelegationRequest | undefined {
  const matches = available.filter(d => d.language === language && d.taskKind === taskKind);
  return matches.length === 1 && taskKind !== 'edit' ? { pluginId: matches[0].id, task } : undefined;
}
