import { randomUUID } from 'node:crypto';
import type { ApprovalGate, ToolCall } from '../agent/types.ts';
import type { LispConfiguration } from '../lisp/config.ts';
import type { Session } from '../session/store.ts';
import type { DelegationRecord, DelegationRequest } from '../subagents/types.ts';
import type { ToolRegistry } from '../tools/registry.ts';

const roles = [
  { id: 'micro-zenki', title: '前鬼', tool: 'verify_tla' },
  { id: 'micro-goki', title: '後鬼', tool: 'verify_lean' },
] as const;

function verdict(record: DelegationRecord | undefined, role: typeof roles[number]): string | undefined {
  if (!record?.result || record.result.status === 'unknown') return;
  for (const value of [...record.result.formalEvidence ?? []].reverse()) {
    const receipt = value as { name: string; status: string; output: string };
    if (receipt.name !== role.tool || !['ok', 'error'].includes(receipt.status)) continue;
    try {
      const result = JSON.parse(receipt.output);
      if (role.tool === 'verify_lean') {
        if (result.proofStatus === 'proved' && receipt.status === 'ok') return 'proved';
        if (result.proofStatus === 'rejected' && receipt.status === 'error') return `rejected (${result.code})`;
      } else if (result.status === 'passed' && receipt.status === 'ok') {
        return 'passed';
      } else if (result.status === 'failed' && receipt.status === 'error') {
        return 'failed';
      }
    } catch { /* Path, approval and transport errors are not verification receipts. */ }
  }
}

interface HeadCheckTurn {
  config?: LispConfiguration;
  input: string;
  session: Session;
  registry: ToolRegistry;
  root: string;
  signal: AbortSignal;
  approval: ApprovalGate;
  onToolCall(call: ToolCall): void;
  onToolResult: NonNullable<import('../agent/loop.ts').LoopHooks['onToolResult']>;
}

export function headCheckCompletion(turn: HeadCheckTurn) {
  const policy = turn.config?.headChecks;
  if (!policy) return;
  const checkRequired = /(?:修正|実装|変更|改修|追加)(?:して|をお願い)|(?:^|[.!?]\s+)(?:please\s+)?(?:fix|implement|refactor|add|change)\b/i.test(turn.input);
  const prior = new Set(turn.session.delegations().map(record => record.runId));
  const inputs = policy.inputs;
  const editor = inputs?.editor ? turn.config?.entries.find(entry => entry.descriptor.id === inputs.editor) : undefined;
  const dispatched = new Set<string>();
  let lastMissing = '';
  let repeats = 0;
  let unknown = false;

  async function delegate(request: DelegationRequest) {
    const call = { id: randomUUID(), name: 'run_subagent', args: { ...request } };
    dispatched.add(request.pluginId);
    turn.session.append({ role: 'assistant', content: '', toolCalls: [call] });
    turn.onToolCall(call);
    const result = await turn.registry.executeOne(call, { root: turn.root, signal: turn.signal, approval: turn.approval });
    turn.session.append({ role: 'tool', results: [result] });
    turn.onToolResult(result);
    unknown ||= result.status === 'unknown';
  }

  const current = () => turn.session.delegations().filter(record => !prior.has(record.runId));
  const latest = (id: string) => current().findLast(record => record.pluginId === id);
  const formalFailure = () => {
    const statuses = roles.map(role => verdict(latest(role.id), role));
    if (statuses.some(status => !status) && !statuses[1]?.startsWith('rejected')) return;
    const failed = roles.flatMap((role, index) => {
      const status = statuses[index];
      return !status || status === 'passed' || status === 'proved' ? [] : [`${role.title} ${status}`];
    });
    if (failed.length) return `形式検証は不合格: ${failed.join('、')}`;
  };
  const terminalFailure = () => {
    const editFailure = editor && latest(editor.descriptor.id)?.result;
    if (editFailure?.code === 'EDIT_TURN_LIMIT') {
      return '編集は不合格: 対象に差分がないまま編集担当のターン上限に達しました (EDIT_TURN_LIMIT)';
    }
    if (editFailure && editFailure.status !== 'completed') {
      return `編集は不合格: ${editFailure.diagnostic ?? editFailure.verification?.status ?? editFailure.status}`;
    }
    if (checkRequired) return formalFailure();
  };

  async function beforeComplete(): Promise<{ continueWith: string } | { errorMessage: string } | undefined> {
    const errorMessage = terminalFailure();
    if (errorMessage) return { errorMessage };
    if (!checkRequired) return;
    if (unknown) return { errorMessage: '委譲結果が不明のため完了できません' };
    const editMissing = editor && !current().some(record => record.pluginId === editor.descriptor.id &&
      record.assignment && record.result?.verification?.application === 'applied');

    const missing = roles.filter(role => !verdict(latest(role.id), role));
    if (inputs && missing.length && !editMissing) {
      const next = missing.find(role => {
        if (dispatched.has(role.id)) return false;
        const result = latest(role.id)?.result;
        return !result || (result.status === 'error' &&
          (result.formalEvidence ?? []).every(value => {
            const receipt = value as { output: string };
            return /^\[(?:INVALID_ARGS|NOT_FOUND|OUT_OF_ROOT)\]/.test(receipt.output);
          }) && !/DENIED|承認|拒否/.test(result.diagnostic ?? ''));
      });
      if (next && !turn.signal.aborted) {
        const formalInput = next.tool === 'verify_tla' ? { path: inputs.tla, config: inputs.cfg } : { path: inputs.lean };
        await delegate({ pluginId: next.id, task: `${next.title}の検証。ホスト設定で指定された入力を使用。`, formalInput });
        if (unknown) return { errorMessage: '委譲結果が不明のため完了できません' };
        const result = verdict(latest(next.id), next);
        return { continueWith: `(ホストの完了確認) ${next.title}の検証が未確認だったため実行しました。ツール結果を読み、残りの確認を続けてください。${result?.startsWith('rejected') ? ' 命題不一致は不合格です。検証入力を変更せず、結果を報告してください。' : ''}` };
      }
    }

    if (missing.length || editMissing) {
      const pending = [...missing.map(role => `${role.title}の検証が未確認 (${role.id})`),
        ...(editMissing ? [`編集反映が未確認 (${editor.descriptor.id}, targetPaths: ${JSON.stringify(editor.definition.verificationManifest?.sources)})`] : [])].join('、');
      repeats = pending === lastMissing ? repeats + 1 : 0;
      lastMissing = pending;
      if (repeats >= 2) return { errorMessage: `未完了: ${pending}` };
      return { continueWith: `(ホストの完了確認) ${pending}。完了を報告する前に、未確認の担当だけを run_subagent で呼んでください。${editMissing ? ' 先に編集担当に変更そのものを指示し、targetPaths と同じ操作の現状・期待結果を behaviorChange.before / behaviorChange.after に渡してください。' : ' 前鬼には formalInput.path と config、後鬼には証明元 formalInput.path を渡します。'} 拒否または結果不明の操作は再送しないでください。` };
    }

    return undefined;
  }
  async function recoverOutputLimit() {
    const pluginId = inputs?.editor;
    const path = editor?.definition.verificationManifest?.sources[0];
    if (!checkRequired || !pluginId || !path || !editor?.descriptor.enabled || current().length) return;
    const call = { id: randomUUID(), name: 'read_file', args: { path, limit: 60 } };
    turn.session.append({ role: 'assistant', content: '', toolCalls: [call] });
    turn.onToolCall(call);
    const read = await turn.registry.executeOne(call, { root: turn.root, signal: turn.signal, approval: turn.approval });
    turn.session.append({ role: 'tool', results: [read] });
    turn.onToolResult(read);
    if (read.status !== 'ok') return;
    return {
      instruction: `(ホストの出力上限からの続行) 元の依頼と直前に読み取ったソースを使い、run_subagent を一件呼んでください。pluginId は ${pluginId}、targetPaths は ${JSON.stringify([path])}。task に変更内容、behaviorChange.before と after に同じ操作の現状と期待結果を具体的に入れてください。`,
      scope: {
        system: 'あなたは役小角です。ユーザーの実装依頼を指定された編集担当に一件委譲する段階です。ソースはツールで取得済みです。分析の説明を生成せず、指定された run_subagent をすぐに呼んでください。',
        tool: 'run_subagent',
        accepts: (request: ToolCall) => request.args?.pluginId === pluginId,
      },
    };
  }

  return { beforeComplete, terminalToolBlock: terminalFailure, recoverOutputLimit };
}
