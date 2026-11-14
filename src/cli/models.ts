import type { ChatTerminal, Choice } from './terminal.ts';
import { allSuggestions, suggestionsFor, noteFor, isRecommended, SEARCH_ROW_VALUE } from './catalog.ts';

/** 接続保証ではなく選択用の候補。一覧外は /connect で直接指定できる。 */
export const MODEL_SUGGESTIONS: readonly string[] = allSuggestions();

function entries(refs: readonly string[], current: string | null): Choice[] {
  return refs.map(ref => {
    const detail = [
      isRecommended(ref) ? 'おすすめ' : '',
      ref === current ? '選択中' : '',
      noteFor(ref) ?? '',
    ].filter(Boolean).join(' · ');
    return { value: ref, label: ref, ...(detail ? { detail } : {}) };
  });
}

export async function selectModel(lines: ChatTerminal, query: string, current: string | null): Promise<string | null> {
  const candidates = [...new Set([...MODEL_SUGGESTIONS, ...(current ? [current] : [])])];
  // The search row is pinned first in both modes so Enter never connects to an arbitrary model.
  const searchRow: Choice = { value: SEARCH_ROW_VALUE, label: '🔍 キーワード検索', pinned: true };
  if (lines.interactive) {
    const provider = query.trim().split(/\s+/)[0];
    const providerList = provider && !provider.includes('/') && /^[a-z][a-z0-9-]*$/.test(provider)
      ? suggestionsFor(provider, current) : [];
    const ordered = [...new Set([...providerList, ...candidates])];
    let keyword = query;
    for (;;) {
      const selected = await lines.choose('モデル候補 — 利用可否はアカウントによります',
        [searchRow, ...entries(ordered, current)], keyword);
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
      const note = [isRecommended(ref) ? 'おすすめ' : '', noteFor(ref) ?? ''].filter(Boolean).join(' · ');
      lines.write(`${i + 1}. ${ref}${note ? `  ${note}` : ''}${ref === current ? ' (選択中)' : ''}\n`);
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
