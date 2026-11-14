import type { ChatTerminal, Choice } from './terminal.ts';
import { suggestionsFor, noteFor, isRecommended, SEARCH_ROW_VALUE } from './catalog.ts';

export const CONNECT_PROVIDERS = [
  { value: 'openai', label: 'OpenAI', detail: 'ChatGPT OAuth (chatgpt) / OPENAI_API_KEY', key: 'OPENAI_API_KEY' },
  { value: 'opencode', label: 'OpenCode', detail: 'Console · OPENCODE_API_KEY', key: 'OPENCODE_API_KEY' },
  { value: 'ollama', label: 'Ollama Local', detail: 'ローカル · OLLAMA_BASE_URL', key: null },
  { value: 'ollama-cloud', label: 'Ollama Cloud', detail: 'ollama.com · OLLAMA_API_KEY', key: 'OLLAMA_API_KEY' },
  { value: 'openrouter', label: 'OpenRouter', detail: 'OPENROUTER_API_KEY', key: 'OPENROUTER_API_KEY' },
  { value: 'infron', label: 'Infron', detail: 'INFRON_API_KEY', key: 'INFRON_API_KEY' },
  { value: 'hermes', label: 'Hermes Agent', detail: 'API server · HERMES_API_KEY', key: 'HERMES_API_KEY' },
  // Web検索のキー登録専用。モデル接続の一覧には含めない。
  { value: 'brave-search', label: 'Brave Search', detail: 'web_search 用のキー · BRAVE_SEARCH_API_KEY', key: 'BRAVE_SEARCH_API_KEY', keyOnly: true },
] as const;
export async function chooseProvider(ui: ChatTerminal, current: string | null): Promise<string | null> {
  ui.write(current ? `接続中: ${current}\n` : '未接続です。\n');
  return ui.choose('Connect an integration — 認証先', CONNECT_PROVIDERS.filter(p => !('keyOnly' in p)).map(p => ({ ...p,
    detail: `${current?.startsWith(`${p.value}/`) || p.value === 'openai' && current?.startsWith('chatgpt/') ? '選択中 · ' : ''}${p.detail}`,
  })));
}
export async function confirmRemoteAgent(ui: ChatTerminal): Promise<boolean> {
  return await ui.choose('Hermes側でツール実行 — DKHの承認・Stopの保証対象外', [
    { value: 'back', label: '戻る' },
    { value: 'connect', label: 'Hermes Agent に接続', detail: 'サーバー側の権限・設定を使用' },
  ]) === 'connect';
}
export async function chooseProviderModel(ui: ChatTerminal, provider: string): Promise<string | null> {
  const choices: Choice[] = suggestionsFor(provider).map(ref => {
    const note = noteFor(ref);
    const detail = [isRecommended(ref) ? 'おすすめ' : '', note ?? ''].filter(Boolean).join(' · ');
    return { value: ref, label: ref, ...(detail ? { detail } : {}) };
  });
  choices.push({ value: 'custom', label: 'モデルIDを直接入力', detail: '一覧にないモデル' });
  for (;;) {
    // The search row is pinned first so a bare Enter never connects to an arbitrary model.
    const selected = await ui.choose(`${provider} — モデルを選択`, [
      { value: SEARCH_ROW_VALUE, label: '🔍 キーワード検索', pinned: true },
      ...choices,
    ]);
    if (selected !== SEARCH_ROW_VALUE) {
      if (selected !== 'custom') return selected;
      const model = (await ui.ask('モデルID（空行・/cancelで戻る）'))?.trim();
      if (!model || model === '/cancel') return null;
      if (model.startsWith('/')) { ui.unread(model); return null; }
      return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
    }
    // Choosing the row with a keyword already typed just reopens the same filtered list; an empty
    // box asks for the keyword explicitly so the row is never a dead end.
    const keyword = (await ui.ask('キーワード検索（空白区切りは語順自由。例: seek deep / 空行・/cancelで戻る）'))?.trim();
    if (!keyword || keyword === '/cancel') continue;
    if (keyword.startsWith('/')) { ui.unread(keyword); return null; }
    const reopened = await ui.choose(`${provider} — モデルを選択`, [
      { value: SEARCH_ROW_VALUE, label: '🔍 キーワード検索', pinned: true },
      ...choices,
    ], keyword);
    if (reopened === SEARCH_ROW_VALUE) continue;
    if (reopened !== 'custom') return reopened;
    const model = (await ui.ask('モデルID（空行・/cancelで戻る）'))?.trim();
    if (!model || model === '/cancel') return null;
    if (model.startsWith('/')) { ui.unread(model); return null; }
    return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  }
}
