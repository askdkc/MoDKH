import type { ChatTerminal } from './terminal.ts';

/** 接続保証ではなく選択用の候補。一覧外は /connect で直接指定できる。 */
export const MODEL_SUGGESTIONS: readonly string[] = [
  'chatgpt/gpt-5.2', 'chatgpt/gpt-5.1-codex',
  'opencode/gpt-6-sol', 'opencode/gpt-5.4',
  'infron/openai/gpt-5.2', 'hermes/hermes-agent',
  'openai/gpt-5.2', 'openai/gpt-4.1',
  'anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-5',
  'google/gemini-2.5-pro', 'google/gemini-2.5-flash',
  'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner',
  'openrouter/openai/gpt-5.2', 'groq/llama-3.3-70b-versatile',
  'xai/grok-3', 'ollama/llama3.2', 'lmstudio/local-model', 'fixed/scripted',
  'ollama-cloud/gemma4:31b', 'ollama-cloud/gpt-oss:120b', 'ollama-cloud/gpt-oss:20b',
];

export async function selectModel(lines: ChatTerminal, query: string, current: string | null): Promise<string | null> {
  if (lines.interactive) return lines.choose('モデル候補 — 利用可否はアカウントによります',
    [...new Set([...MODEL_SUGGESTIONS, ...(current ? [current] : [])])].map(ref => ({ value: ref, label: ref })), query);
  const candidates = [...new Set([...MODEL_SUGGESTIONS, ...(current ? [current] : [])])];
  let filter = query;
  for (;;) {
    const terms = filter.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = candidates.filter((ref) => terms.every((term) => ref.toLowerCase().includes(term)));
    lines.write('モデル候補 (利用可否は接続先・アカウントによります):\n');
    matches.forEach((ref, i) => lines.write(`${i + 1}. ${ref}${ref === current ? ' (選択中)' : ''}\n`));
    if (matches.length === 0) lines.write('該当するモデルはありません。\n');
    lines.write('番号で選択 / 文字列で再検索 / * で全件 / 空行・/cancel で戻る\n一覧外: /connect <provider>/<model> [--base-url <url>]\n');
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
