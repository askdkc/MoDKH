import fs from 'node:fs';
import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';
import { describeShellResult, ShellProcess, SHELLS, type ShellName } from './shell-process.ts';
import { prepareCommand } from './job-tools.ts';
import type { JobView } from './jobs.ts';
import { browserCapability } from './browser-capability.ts';

export { runShellProcess, runShell, describeShellResult, resolveShell, SHELLS, TextSink, ShellProcess } from './shell-process.ts';
export type { ShellName, ShellOptions, ShellResult } from './shell-process.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
/** A single foreground call may run longer than the default, but never without a bound. */
const MAX_TIMEOUT_MS = 600_000;

function positiveInt(v: unknown, name: string, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : typeof v === 'number' ? v : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ToolError('INVALID_ARGS', `${name} は1〜${max}の整数で指定する`);
  return n;
}

/** Resolve, approve, and verify the target directory without running anything. */
async function authorize(args: Record<string, unknown>, ctx: Parameters<Tool['execute']>[1]): Promise<{ command: string; cwd: string; cwdRel: string; shell: ShellName; description?: string }> {
  const prepared = prepareCommand(args, ctx.root);
  // Capture the real target BEFORE approval; the check after approval compares against it, so a
  // directory swapped for another (even inside the root) cannot silently run the command.
  let approvedCwd: string;
  try {
    approvedCwd = assertRealInRoot(ctx.root, prepared.cwd);
    if (!fs.statSync(prepared.cwd).isDirectory()) {
      throw new ToolError('INVALID_ARGS', `作業ディレクトリが不正: ${prepared.cwdRel}`);
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError('INVALID_ARGS', `作業ディレクトリが存在しない: ${prepared.cwdRel}`);
  }
  if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため実行しない');
  const ok = await ctx.approval.approve({
    kind: 'command',
    title: `コマンド実行 (${prepared.cwdRel})`,
    detail: `${prepared.command}\n\n作業場所: ${prepared.cwd}`,
    // The cwd was resolved and its real path proven inside the root above.
    outsideWorkspace: false,
  });
  if (!ok) throw new ToolError('DENIED', 'コマンドは承認されなかったため実行しない');
  if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため実行しない');
  try {
    if (assertRealInRoot(ctx.root, prepared.cwd) !== approvedCwd || !fs.statSync(prepared.cwd).isDirectory()) {
      throw new Error('承認待ちの間に作業場所が変更された');
    }
  } catch (e) {
    throw new ToolError('NOT_EXECUTED', `承認後の作業場所を確認できないため実行しない: ${(e as Error).message}`);
  }
  return prepared;
}

const OPERATION_IDENTITY = (args: Record<string, unknown>, ctx: Parameters<Tool['execute']>[1]) => ({
  command: args.command,
  cwd: resolveInRoot(ctx.root, typeof args.cwd === 'string' ? args.cwd : '.'),
  shell: args.shell ?? 'sh',
});

const PARAMETERS = {
  type: 'object',
  properties: {
    description: { type: 'string', description: '何をするコマンドか(5〜10語、命令形。例: "run unit tests")' },
    command: { type: 'string', description: '実行するコマンド' },
    cwd: { type: 'string', description: '作業ディレクトリ(ルート相対、既定はルート)' },
    shell: { type: 'string', enum: [...SHELLS], description: '使用するシェル(既定 sh。bash は set -eou pipefail を先頭に追加する)' },
    timeoutMs: { type: 'number', description: `制限時間(ミリ秒、既定 ${DEFAULT_TIMEOUT_MS}、上限 ${MAX_TIMEOUT_MS})` },
    run_in_background: { type: 'boolean', description: 'true にすると即座に job_id を返し、結果は job_output で読む。長時間かかる処理で使う' },
  },
  required: ['command'],
} as const;

/**
 * Whether a foreground command that hits its deadline becomes a job.
 *
 * On by default because killing a build at 120 seconds discards work the human wanted. A
 * caller can turn it off to keep the strict "a deadline is a failure" contract.
 */
export const DEFAULT_PROMOTE_ON_TIMEOUT = true;

export const runCommandTool: Tool = {
  name: 'run_command',
  operationIdentity: OPERATION_IDENTITY,
  get description() { return 'シェルコマンドを1回実行し、終了コード・stdout・stderr を返す。作業場所は作業ルート内に限る。'
    + '終了コードが0以外でも実行結果として返る(エラー扱いにはしない)。'
    + 'cd は次の呼び出しに引き継がれないので cwd を指定する。'
    + '確認は grep やテスト実行のように終了コードを見て判断する。'
    + 'run_in_background を true にすると待たずに job_id を返す。ビルドやテストの全体実行など、'
    + '制限時間に収まらない見込みの処理で使う。' + browserCapability(); },
  parameters: PARAMETERS,
  async execute(args, ctx) {
    const prepared = await authorize(args, ctx);
    if (args.run_in_background === true) {
      // A background job has no deadline: it runs until it exits or job_kill stops it.
      if (!ctx.jobs) throw new ToolError('INVALID_ARGS', 'バックグラウンド実行が有効でない');
      const view = ctx.jobs.start(prepared);
      return [
        `[job_id: ${view.id}] [status: ${view.status}]`,
        `作業場所: ${view.cwd}`,
        'job_output で出力を読み、job_kill で止める。完了は通知でも届く。',
      ].join('\n');
    }
    const timeoutMs = positiveInt(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    // A foreground command that reaches its deadline keeps running as a job instead of being
    // killed: the work already done is not thrown away, and the model keeps a handle to it.
    // The call must return AT the deadline, so it resolves on whichever happens first.
    let resolvePromoted: ((view: JobView) => void) | undefined;
    const promotedSignal = ctx.jobs === undefined
      ? undefined
      : new Promise<JobView>(resolve => { resolvePromoted = resolve; });
    const shellProcess = new ShellProcess(prepared.command, prepared.cwd, {
      shell: prepared.shell,
      timeoutMs,
      ...(ctx.jobs === undefined ? {} : {
        onTimeout: (process: ShellProcess) => {
          const view = ctx.jobs!.adopt(process, prepared);
          resolvePromoted?.(view);
        },
      }),
    });
    if (ctx.signal) {
      const onAbort = () => shellProcess.stop('abort');
      if (ctx.signal.aborted) shellProcess.stop('abort');
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
      void shellProcess.result.finally(() => ctx.signal?.removeEventListener('abort', onAbort)).catch(() => {});
    }
    const outcome = await (promotedSignal
      ? Promise.race([
        shellProcess.result.then(result => ({ kind: 'result' as const, result })),
        promotedSignal.then(view => ({ kind: 'promoted' as const, view })),
      ])
      : shellProcess.result.then(result => ({ kind: 'result' as const, result })));
    if (outcome.kind === 'promoted') {
      // Promotion is not a failure: report the handle and how to keep reading.
      shellProcess.abandon();
      return [
        `[job_id: ${outcome.view.id}] [status: ${outcome.view.status}]`,
        `制限時間(${timeoutMs}ms)に達したためバックグラウンドジョブへ移した。コマンドは実行を続けている。`,
        'job_output で続きを読み、job_kill で止める。完了は通知でも届く。',
      ].join('\n');
    }
    return describeShellResult(outcome.result);
  },
};

/** Host-only acceptance path: same command authorization, no job promotion, no stdout parsing. */
export async function executeAcceptance(command: string, root: string, approval: import('../agent/types.ts').ApprovalGate,
  signal: AbortSignal, inputDigest: string, env: NodeJS.ProcessEnv): Promise<import('../lisp/runtime.ts').ExecutionReceipt> {
  const { executeBounded } = await import('../lisp/runtime.ts');
  try {
    const prepared = await authorize({ command, cwd: '.', shell: 'sh' }, { root, approval, signal });
    return await executeBounded('/bin/sh', ['-c', prepared.command], { cwd: prepared.cwd, env, inputDigest, signal, timeoutMs: 30000 });
  } catch (e) {
    return { state: 'not-started', exitCode: null, signal: null, stdout: '', stderr: String(e), inputDigest, cleanup: 'settled' };
  }
}
