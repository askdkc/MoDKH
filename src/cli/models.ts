import type { ChatTerminal, Choice } from './terminal.ts';
import { toRefs, SEARCH_ROW_VALUE, LOCAL_MODEL_REFS } from './catalog.ts';
import { hasModelCredentials, officialModelChoices } from './official-models.ts';
import { providerModelChoices } from './model-catalog.ts';
import { knownProviders, providerDefinition, supportsLiveModels } from '../model/providers.ts';
import { resolveApiKey } from './keys.ts';

/** 一覧APIを持つプロバイダーか。chatgpt は公式Codexの一覧を使うため別扱いにする。 */
export function listsModels(provider: string): boolean {
  return provider === 'chatgpt' || supportsLiveModels(provider);
}

/**
 * `/models` の候補。固定リストは持たず、指定または接続済みのプロバイダーから毎回取得する。
 * 取得できなければ空のまま「一覧外は直接指定」を案内する。
 */
async function liveSuggestions(provider: string, write: (text: string) => void, signal: AbortSignal): Promise<string[] | null> {
  if (provider === 'openai' || provider === 'chatgpt') {
    return await officialModelChoices(provider, write, signal);
  }
  const result = await providerModelChoices(provider, write, process.env, signal);
  return result === null ? null : toRefs(provider, result.ids);
}

function entries(refs: readonly string[], current: string | null): Choice[] {
  return refs.map(ref => ({ value: ref, label: ref, ...(ref === current ? { detail: '選択中' } : {}) }));
}

export async function selectModel(lines: ChatTerminal, query: string, current: string | null): Promise<string | null> {
  const requested = query.trim().split(/[\s/]/)[0];
  const currentProvider = current?.split('/')[0];
  const providers = requested && listsModels(requested) ? [requested]
    : [...knownProviders(), 'chatgpt'].filter(provider => {
      if (!listsModels(provider)) return false;
      if (provider === currentProvider) return true;
      if (provider === 'chatgpt') return hasModelCredentials(provider);
      const envName = providerDefinition(provider)?.env;
      return Boolean(envName && resolveApiKey(provider, process.env, envName));
    });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  let fetched: string[];
  try {
    const results = await Promise.all(providers.map(provider =>
      liveSuggestions(provider, text => lines.write(text), controller.signal)));
    if (controller.signal.aborted) return null;
    fetched = results.flatMap(refs => refs ?? []);
  } finally { process.removeListener('SIGINT', cancel); }
  // MODKH 自身の擬似モデル(fixed)は取得元がないため、常に候補へ含める。
  const candidates = [...new Set([...LOCAL_MODEL_REFS, ...fetched, ...(current ? [current] : [])])];
  // The search row is pinned first in both modes so Enter never connects to an arbitrary model.
  const searchRow: Choice = { value: SEARCH_ROW_VALUE, label: '🔍 キーワード検索', pinned: true };
  if (lines.interactive) {
    let keyword = query;
    for (;;) {
      const selected = await lines.choose('モデル候補 — 利用可否はアカウントによります',
        [searchRow, ...entries(candidates, current)], keyword);
      if (selected !== SEARCH_ROW_VALUE) return selected;
      const answer = (await lines.ask('キーワード検索（空白区切りは語順自由。例: seek deep / 空行・/cancelで戻る）'))?.trim();
      if (!answer || answer === '/cancel') { keyword = ''; continue; }
      if (answer.startsWith('/')) { lines.unread(answer); return null; }
      keyword = answer;
    }
  }
  let filter = query;
  for (;;) {
    const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = candidates.filter((ref) => terms.every((term) => ref.toLowerCase().includes(term)));
    lines.write('モデル候補 (利用可否は接続先・アカウントによります):\n');
    matches.forEach((ref, i) => {
      lines.write(`${i + 1}. ${ref}${ref === current ? ' (選択中)' : ''}\n`);
    });
    if (matches.length === 0) lines.write('該当するモデルはありません。\n');
    lines.write('番号で選択 / 文字列で再検索（語順自由: seek deep）/ * で全件 / 空行・/cancel で戻る\n一覧外: /connect <provider>/<model> [--base-url <url>]\n');
    const answer = (await lines.next())?.trim();
    if (!answer || answer === '/cancel') return null;
    if (answer.startsWith('/')) { lines.unread(answer); return null; }
    if (/^\d+$/.test(answer)) {
      const selected = matches[Number(answer) - 1];
      if (selected) return selected;
      lines.write('番号が範囲外です。\n');
    } else { filter = answer === '*' ? '' : answer; }
  }
}
