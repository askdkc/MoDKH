import type { ChatTerminal, Choice } from './terminal.ts';
import { modelProviders, toRefs, SEARCH_ROW_VALUE, CONNECT_PROVIDERS, LOCAL_MODEL_REFS } from './catalog.ts';
import { officialModelChoices } from './official-models.ts';
import { providerModelChoices, type ModelListConnection } from './model-catalog.ts';
import { knownProviders, supportsLiveModels } from '../model/providers.ts';

export { CONNECT_PROVIDERS, modelProviders };

export async function chooseProvider(ui: ChatTerminal, current: string | null): Promise<string | null> {
  ui.write(current ? `接続中: ${current}\n` : '未接続です。\n');
  return ui.choose('Connect an integration — 認証先', modelProviders().map(p => ({ ...p,
    detail: `${current?.startsWith(`${p.value}/`) || p.value === 'openai' && current?.startsWith('chatgpt/') ? '選択中 · ' : ''}${p.detail}`,
  })));
}
export async function confirmRemoteAgent(ui: ChatTerminal): Promise<boolean> {
  return await ui.choose('Hermes側でツール実行 — MODKHの承認・Stopの保証対象外', [
    { value: 'back', label: '戻る' },
    { value: 'connect', label: 'Hermes Agent に接続', detail: 'サーバー側の権限・設定を使用' },
  ]) === 'connect';
}

/**
 * プロバイダーのモデルを選ぶ。一覧は開くたびにプロバイダーから取得し、固定値は使わない。
 * 取得できなくても「モデルIDを直接入力」で先へ進める。
 */
export async function chooseProviderModel(ui: ChatTerminal, provider: string, connection?: ModelListConnection): Promise<string | null> {
  let refs: string[];
  if (provider === 'openai' || provider === 'chatgpt') {
    const official = await officialModelChoices(provider, text => ui.write(text));
    if (official === null) return null;
    refs = official;
  } else if (provider === 'fixed' || provider === 'compatible') {
    // プロバイダーが公開する一覧が無い擬似接続先。IDは直接入力してもらう。
    refs = LOCAL_MODEL_REFS.filter(ref => ref.startsWith(`${provider}/`));
  } else if (knownProviders().includes(provider) && supportsLiveModels(provider)) {
    const result = await providerModelChoices(provider, text => ui.write(text), process.env, undefined, connection);
    if (result === null) return null;
    refs = toRefs(provider, result.ids);
  } else {
    ui.write(`(${provider}: 一覧APIがないためモデルIDを入力してください)\n`);
    refs = [];
  }
  const choices: Choice[] = refs.map(ref => ({ value: ref, label: ref }));
  choices.push({ value: 'custom', label: 'モデルIDを直接入力', detail: '一覧にないモデル' });
  const askManual = async (): Promise<string | null> => {
    const model = (await ui.ask('モデルID（空行・/cancelで戻る）'))?.trim();
    if (!model || model === '/cancel') return null;
    if (model.startsWith('/')) { ui.unread(model); return null; }
    return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  };
  for (;;) {
    // The search row is pinned first so a bare Enter never connects to an arbitrary model.
    const selected = await ui.choose(`${provider} — モデルを選択`, [
      { value: SEARCH_ROW_VALUE, label: '🔍 キーワード検索', pinned: true },
      ...choices,
    ]);
    if (selected !== SEARCH_ROW_VALUE) {
      return selected === 'custom' ? await askManual() : selected;
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
    return reopened === 'custom' ? await askManual() : reopened;
  }
}
