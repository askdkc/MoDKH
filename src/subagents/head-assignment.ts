import { ToolError } from '../agent/types.ts';
import type { DelegationRequest, HeadAssignment } from './types.ts';

export interface HeadInputs {
  model: string;
  lean: string;
  editor?: { id: string; path: string };
}

const vagueBehavior = /^(?:works?(?: as expected| correctly)?|correct|fixed|done|ok|pass(?:ed)?|tests? pass|成功|正常|変更前|変更後|確認済み|修正済み|(?:正しく|正常に)動(?:く|作する))[.!。]?$/i;

function observableBehavior(value: string): boolean {
  return Boolean(value) && !/[\r\n\u2028\u2029]/.test(value) && !vagueBehavior.test(value);
}

/** Admit exactly the configured operation and its evidence before recording a child. */
export function headAssignment(inputs: HeadInputs, request: DelegationRequest, editRole: boolean, userRequest?: string): HeadAssignment | undefined {
  const { pluginId, formalInput, behaviorChange, targetPaths } = request;
  if (pluginId === 'micro-zenki' || pluginId === 'micro-goki') {
    const stateright = pluginId === 'micro-zenki';
    const path = stateright ? inputs.model : inputs.lean;
    if (formalInput?.path !== path || formalInput.config !== undefined || behaviorChange) {
      throw new ToolError('INVALID_ARGS', `Use configured formalInput ${JSON.stringify({ path })} for ${pluginId}`);
    }
    return stateright ? {
      task: '設定された有限モデルをStaterightで検査する',
      targets: [path],
      completion: { condition: '指定したモデルと設定で不変条件違反なく探索が完了する', evidence: 'verify_stateright.status=passed' },
    } : {
      task: '証明元の対象定理をホスト指定の期待命題と照合する',
      targets: [path],
      completion: { condition: '指定定理の証明が期待命題と一致する', evidence: 'verify_lean.proofStatus=proved' },
    };
  }
  if (!editRole && pluginId !== inputs.editor?.id) {
    if (behaviorChange) throw new ToolError('INVALID_ARGS', 'behaviorChange is reserved for the configured editor');
    return;
  }
  const editor = inputs.editor;
  if (!editor || editor.id !== pluginId) throw new ToolError('DENIED', 'Use the editor selected in Lisp head checks');
  if (targetPaths?.length !== 1 || targetPaths[0] !== editor.path) {
    throw new ToolError('INVALID_ARGS', `Use exactly the configured targetPaths ${JSON.stringify([editor.path])}`);
  }
  if (!behaviorChange || !observableBehavior(behaviorChange.before) || !observableBehavior(behaviorChange.after) ||
      behaviorChange.before.toLowerCase() === behaviorChange.after.toLowerCase()) {
    throw new ToolError('INVALID_ARGS', 'behaviorChange.before and behaviorChange.after must state distinct, observable behavior for one change');
  }
  return {
    task: request.task,
    targets: [editor.path],
    behaviorChange,
    ...(userRequest ? { userRequest } : {}),
    completion: { condition: behaviorChange.after, evidence: 'verification.status=passed and verification.application=applied' },
  };
}
