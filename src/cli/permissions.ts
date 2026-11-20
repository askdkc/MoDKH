/**
 * Approval policy for effectful tools.
 *
 * This decides when MODKH asks the human; it is not an OS sandbox. `all` and `workspace` still run
 * commands with the user's own privileges, so the distinction is about prompting, not isolation.
 */
export type PermissionPolicy = 'all' | 'workspace' | 'none';

/** Widest first, so the list reads as a scale. */
export const POLICY_LEVELS: readonly PermissionPolicy[] = ['all', 'workspace', 'none'];

/** The default keeps the old behaviour for reads/edits inside the workspace but stops prompting
 *  on every ordinary command, which is what made routine work tedious. */
export const DEFAULT_POLICY: PermissionPolicy = 'workspace';

export function parsePermissionPolicy(value: string): PermissionPolicy | null {
  const normalized = value.trim().toLowerCase();
  return (POLICY_LEVELS as readonly string[]).includes(normalized) ? normalized as PermissionPolicy : null;
}

export interface ApprovalDecisionInput {
  policy: PermissionPolicy;
  kind: 'edit' | 'command' | 'public-get';
  /** True only when the resolved target is proven outside the working root. */
  outsideWorkspace: boolean;
}

/**
 * `workspace` never asks for effects inside the root; it still asks for anything that escaped it.
 * A caller that cannot prove the target is inside must pass outsideWorkspace: true.
 */
export function shouldAsk(input: ApprovalDecisionInput): boolean {
  if (input.policy === 'all') return false;
  if (input.policy === 'none') return true;
  return input.outsideWorkspace && input.kind !== 'public-get';
}

export function describePolicy(policy: PermissionPolicy): string {
  switch (policy) {
    case 'all':
      return 'all — 承認を求めず自動実行する（ワークスペース外も含む）';
    case 'workspace':
      return 'workspace — ワークスペース内は自動、外に出る操作だけ確認する';
    case 'none':
      return 'none — 読み取り以外は毎回確認する';
  }
}
