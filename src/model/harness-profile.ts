// Codex associates instruction templates and supported reasoning levels with a model slug.
// Use MoDKH's own tools and approval rules, not Codex-specific commands or permissions.
export function harnessProfile(ref: string): 'astra' | 'sol' | undefined {
  const slug = ref.split('/').at(-1)?.toLowerCase();
  if (slug === 'gpt-6.2-astra') return 'astra';
  if (slug === 'gpt-6.2-sol') return 'sol';
  return undefined;
}

// openai/codex @ 6ee9bc1, codex-rs/models-manager/models.json: the two entries
// share the literal instructions_template and low effort/verbosity defaults.
export const CODEX_62_DEFAULTS = { reasoning: 'low', verbosity: 'low' } as const;

export function modelInstructions(ref: string): string {
  const profile = harnessProfile(ref);
  if (!profile) return '';
  const label = profile === 'astra' ? 'Astra' : 'Sol';
  return `\n[${label} 6.2] 依頼の完了条件を確認し、許可された次の手順があれば計画の提示だけで終えず実行する。`
    + '実装では既存の変更を保ち、各成果物を実際の利用経路で検証する。長い作業では新しく分かったことを短く知らせる。'
    + '承認拒否を別経路で回避しない。範囲変更や不可逆な操作には必要な確認を取り、阻まれた場合は進められる部分を完了する。'
    + '結果を先に述べ、検証できたことと未確認事項を分ける。';
}
