import { randomUUID } from 'node:crypto';
import type { ApprovalGate, Tool, ToolCall } from '../agent/types.ts';
import type { LispConfiguration } from '../lisp/config.ts';
import { snapshot } from '../tools/formal-input.ts';
import type { Session } from '../session/store.ts';
import type { DelegationRecord, DelegationRequest } from '../subagents/types.ts';
import type { ToolRegistry } from '../tools/registry.ts';

const roles = [
  { id: 'micro-zenki', title: '前鬼', tool: 'verify_stateright' },
  { id: 'micro-goki', title: '後鬼', tool: 'verify_lean' },
] as const;

function verdict(record: DelegationRecord | undefined, role: Pick<typeof roles[number], 'tool'>,
  expected?: { root: string; path: string; contractDigest?: string }): string | undefined {
  if (!record?.result || record.result.status === 'unknown') return;
  for (const value of [...record.result.formalEvidence ?? []].reverse()) {
    const receipt = value as { name: string; status: string; output: string };
    if (receipt.name !== role.tool || !['ok', 'error'].includes(receipt.status)) continue;
    try {
      const result = JSON.parse(receipt.output);
      if (expected) {
        const lean = role.tool === 'verify_lean';
        const file = snapshot(expected.root, expected.path, lean ? '.lean' : '.json');
        if ((lean ? result.proofPath : result.modelPath) !== file.relativePath || result.hashes?.source !== file.digest) continue;
        if (lean && result.proofStatus === 'proved' && (!expected.contractDigest || result.hashes?.contract !== expected.contractDigest
          || snapshot(expected.root, result.target?.expectedPropositionPath, '.lean').digest !== expected.contractDigest)) continue;
      }
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

/** The model judges relevance. The host binds inputs and owns both verifier dispatches. */
export function pstackFormalChecks(root: string, contractPath?: string, configured?: { model: string; lean: string }) {
  let inputs: { model: string; lean: string } | undefined;
  let required = false;
  // The ordinary pstack parent can edit the workspace, including the expected proposition.
  // Only a contract already present when the user requested the work can certify the result.
  let contractDigest: string | undefined;
  if (contractPath) {
    try { contractDigest = snapshot(root, contractPath, '.lean').digest; } catch { /* surfaced if proof is requested */ }
  }
  const tool: Tool = {
    name: 'require_formal_checks',
    description: 'For pstack work requiring formal verification (state transitions, concurrency invariants, or a theorem), bind the finite model JSON and Lean proof source for the final checks. The host delegates both. Use after identifying the relevant inputs; do not use for routine tasks.',
    parameters: { type: 'object', properties: { model: { type: 'string' }, lean: { type: 'string' } }, required: ['model', 'lean'] },
    async execute(args, ctx) {
      required = true;
      if (inputs && (args.model !== inputs.model || args.lean !== inputs.lean)) {
        throw new Error('この依頼の形式検証対象はすでに指定されています。');
      }
      if (configured && (args.model !== configured.model || args.lean !== configured.lean)) {
        throw new Error('Use the host-configured formal inputs: ' + JSON.stringify(configured));
      }
      const model = snapshot(ctx.root, args.model, '.json').relativePath;
      const lean = snapshot(ctx.root, args.lean, '.lean').relativePath;
      inputs = configured ?? { model, lean };
      return '形式検証を予約しました。作業が済むとホストが前鬼と後鬼を呼びます。';
    },
  };
  return { tool, contractDigest, get inputs() { return inputs; }, get required() { return required; } };
}

interface HeadCheckTurn {
  config?: LispConfiguration;
  pstack?: ReturnType<typeof pstackFormalChecks>;
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
  if (!policy && !turn.pstack) return;
  const activeRoles = turn.config ? roles : roles.map(role => ({ ...role, id: `modkh-${role.id}` }));
  const checkRequired = /(?:修正|実装|変更|改修|追加)(?:して|をお願い)|(?:^|[.!?]\s+)(?:please\s+)?(?:fix|implement|refactor|add|change)\b/i.test(turn.input);
  const prior = new Set(turn.session.delegations().map(record => record.runId));
  const inputs = policy?.inputs;
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
  const active = () => Boolean(policy || turn.pstack?.required);
  const latest = (id: string) => current().findLast(record => record.pluginId === id);
  const roleVerdict = (role: typeof activeRoles[number]) => {
    const paths = turn.pstack?.inputs;
    const expected = paths && { root: turn.root, contractDigest: turn.pstack?.contractDigest, path: role.tool === 'verify_lean' ? paths.lean : paths.model };
    return verdict(latest(role.id), role, expected);
  };
  const formalVerdict = () => {
    if (!active()) return;
    const statuses = activeRoles.map(roleVerdict);
    if (statuses[0] === 'passed' && statuses[1] === 'proved') {
      return { status: 'passed', message: '形式検証は合格: 前鬼のStateright passed、後鬼のLean proved' } as const;
    }
    if (statuses.some(status => !status) && !statuses[1]?.startsWith('rejected')) return;
    const failed = activeRoles.flatMap((role, index) => {
      const status = statuses[index];
      return !status || status === 'passed' || status === 'proved' ? [] : [`${role.title} ${status}`];
    });
    if (failed.length) return { status: 'failed', message: `形式検証は不合格: ${failed.join('、')}` } as const;
  };
  const terminalFailure = () => {
    const editFailure = editor && latest(editor.descriptor.id)?.result;
    if (editFailure?.code === 'EDIT_TURN_LIMIT') {
      return '編集は不合格: 対象に差分がないまま編集担当のターン上限に達しました (EDIT_TURN_LIMIT)';
    }
    if (editFailure && editFailure.status !== 'completed') {
      return `編集は不合格: ${editFailure.diagnostic ?? editFailure.verification?.status ?? editFailure.status}`;
    }
    const formal = formalVerdict();
    if (formal?.status === 'failed') return formal.message;
  };

  async function beforeComplete(): Promise<{ continueWith: string } | { errorMessage: string } | undefined> {
    const errorMessage = terminalFailure();
    if (errorMessage) return { errorMessage };
    if (turn.pstack && !turn.pstack.required && !policy && current().some(record => activeRoles.some(role => role.id === record.pluginId))) {
      if (++repeats > 2) return { errorMessage: '形式検証は未検証: モデル JSON と Lean 証明元が指定されていません。' };
      return { continueWith: 'pstack の形式検証を開始しています。require_formal_checks に対象のモデル JSON と Lean 証明元を指定し、両方の結果を確認してください。' };
    }
    if (!(policy && checkRequired) && !turn.pstack?.required) return;
    const formalInputs = inputs ?? turn.pstack?.inputs;
    if (turn.pstack?.required && !formalInputs) return { errorMessage: '形式検証は未検証: 有効なモデル JSON と Lean 証明元が必要です。' };
    if (unknown) return { errorMessage: '委譲結果が不明のため完了できません' };
    const editMissing = editor && !current().some(record => record.pluginId === editor.descriptor.id &&
      record.assignment && record.result?.verification?.application === 'applied');

    const missing = activeRoles.filter(role => !roleVerdict(role));
    if (formalInputs && missing.length && !editMissing) {
      const eligible = missing.filter(role => {
        if (dispatched.has(role.id)) return false;
        const result = latest(role.id)?.result;
        return !result || (result.status === 'error' &&
          (result.formalEvidence ?? []).every(value => {
            const receipt = value as { output: string };
            return /^\[(?:INVALID_ARGS|NOT_FOUND|OUT_OF_ROOT)\]/.test(receipt.output);
          }) && !/DENIED|承認|拒否/.test(result.diagnostic ?? ''));
      });
      const selected = turn.pstack?.required ? eligible : eligible.slice(0, 1);
      for (const next of selected) {
        if (turn.signal.aborted) return { errorMessage: '形式検証を中断しました' };
        const formalInput = next.tool === 'verify_stateright' ? { path: formalInputs.model } : { path: formalInputs.lean };
        await delegate({ pluginId: next.id, task: `${next.title}の検証。指定された入力を使用。`, formalInput });
        if (unknown) return { errorMessage: '委譲結果が不明のため完了できません' };
      }
      if (selected.length) {
        const names = selected.map(role => role.title).join('と');
        const rejected = selected.some(role => roleVerdict(role)?.startsWith('rejected'));
        return { continueWith: `(ホストの完了確認) ${names}の検証が未確認だったため実行しました。ツール結果を読み、残りの確認を続けてください。${rejected ? ' 命題不一致は不合格です。検証入力を変更せず、結果を報告してください。' : ''}` };
      }
    }

    if (missing.length || editMissing) {
      const pending = [...missing.map(role => `${role.title}の検証が未確認 (${role.id})`),
        ...(editMissing ? [`編集反映が未確認 (${editor.descriptor.id}, targetPaths: ${JSON.stringify(editor.definition.verificationManifest?.sources)})`] : [])].join('、');
      repeats = pending === lastMissing ? repeats + 1 : 0;
      lastMissing = pending;
      if (turn.pstack?.required && missing.every(role => dispatched.has(role.id)) && !editMissing) {
        return { errorMessage: '形式検証は未検証: ' + pending + '。各担当の実行結果を確認してください。' };
      }
      if (repeats >= 2) return { errorMessage: `未完了: ${pending}` };
      return { continueWith: `(ホストの完了確認) ${pending}。完了を報告する前に、未確認の担当だけを start_subagent で呼んでください。${editMissing ? ' 先に編集担当に変更そのものを指示し、targetPaths と同じ操作の現状・期待結果を behaviorChange.before / behaviorChange.after に渡してください。' : ' 前鬼には formalInput.path（モデルJSON）、後鬼には証明元 formalInput.path を渡します。'} 拒否または結果不明の操作は再送しないでください。` };
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

  return { formalVerdict, hooks: { beforeComplete, terminalToolBlock: terminalFailure, recoverOutputLimit } };
}
