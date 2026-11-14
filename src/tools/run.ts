import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';

const RUN_TIMEOUT_MS = 120_000;
const RUN_MAX_OUTPUT = 32 * 1024;

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolError('INVALID_ARGS', `${name} は空でない文字列で指定する`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// run_command: 承認ゲートに実行内容と作業場所を見せてから1回だけ実行する。
// 中断(signal)で子プロセスを止める。通常ユーザー権限で動くため、
// 初版は信頼できるローカル作業向け(PLAN.md の方針)。
// ---------------------------------------------------------------------------

export const runCommandTool: Tool = {
  name: 'run_command',
  operationIdentity: (args, ctx) => ({ command: args.command, cwd: resolveInRoot(ctx.root, args.cwd ?? '.') }),
  description:
    'シェルコマンドを実行する。作業場所は作業ルート内に限る。実行内容と作業場所を承認してから1回だけ実行する。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '実行するコマンド' },
      cwd: { type: 'string', description: '作業ディレクトリ(ルート相対、既定はルート)' },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    const command = requireString(args.command, 'command');
    const cwdRel = args.cwd === undefined ? '.' : requireString(args.cwd, 'cwd');
    const cwd = resolveInRoot(ctx.root, cwdRel);
    const approvedCwd = assertRealInRoot(ctx.root, cwd);
    try {
      if (!fs.statSync(cwd).isDirectory()) {
        throw new ToolError('INVALID_ARGS', `作業ディレクトリが不正: ${cwdRel}`);
      }
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError('INVALID_ARGS', `作業ディレクトリが存在しない: ${cwdRel}`);
    }
    if (ctx.signal?.aborted) {
      throw new ToolError('NOT_EXECUTED', '中断済みのため実行しない');
    }
    const ok = await ctx.approval.approve({
      kind: 'command',
      title: `コマンド実行 (${cwdRel})`,
      detail: `${command}\n\n作業場所: ${cwd}`,
      // The cwd was resolved and its real path proven inside the root above.
      outsideWorkspace: false,
    });
    if (!ok) throw new ToolError('DENIED', 'コマンドは承認されなかったため実行しない');
    if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため実行しない');
    try {
      if (assertRealInRoot(ctx.root, cwd) !== approvedCwd || !fs.statSync(cwd).isDirectory()) {
        throw new Error('承認待ちの間に作業場所が変更された');
      }
    } catch (e) {
      throw new ToolError('NOT_EXECUTED', `承認後の作業場所を確認できないため実行しない: ${(e as Error).message}`);
    }
    const result = await runShell(command, cwd, ctx.signal);
    return result;
  },
};

export function runShell(command: string, cwd: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
  // Approval is asynchronous: Stop may have arrived after the earlier check.
  if (signal?.aborted) return Promise.reject(new ToolError('NOT_EXECUTED', '中断済みのため実行しない'));
  return new Promise((resolve, reject) => {
    // A dedicated POSIX process group owns the shell and its ordinary descendants.
    // This is not a sandbox: commands deliberately daemonizing must not be used.
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let closed = false;
    let code: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stopReason: 'abort' | 'timeout' | 'descendants' | undefined;
    let failure: string | undefined;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const groupExists = (): boolean => {
      if (child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
        failure = `子処理の状態を確認できない: ${(e as Error).message}`;
        return true;
      }
    };
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, sig); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
          failure = `子処理を停止できない: ${(e as Error).message}`;
        }
      }
    };
    const finish = (unconfirmed = false) => {
      if (settled || (!unconfirmed && (!closed || groupExists()))) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(cleanupDeadline);
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
      const decoder = new StringDecoder('utf8');
      const text = decoder.write(Buffer.concat(chunks)) + (truncated ? '' : decoder.end());
      const output = `--- 出力 ---\n${text}${truncated ? '\n...(出力を打ち切り)' : ''}`;
      if (unconfirmed) {
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new ToolError('RESULT_UNKNOWN', `子処理の停止を確認できない。再実行しない。${failure ?? ''}\n${output}`));
      } else if (stopReason) {
        const reason = stopReason === 'timeout' ? '制限時間を超過した'
          : stopReason === 'descendants' ? 'shell終了後に残った子処理を停止した' : 'コマンドを中断した';
        reject(new ToolError('ABORTED', `${reason}(code=${code ?? '不明'} signal=${exitSignal ?? 'なし'})\n${output}`));
      } else if (failure || exitSignal || code !== 0) {
        reject(new ToolError('RUN_FAILED', `${failure ?? `終了コード ${code ?? '不明'} signal=${exitSignal ?? 'なし'}`}\n${output}`));
      } else {
        resolve(`終了コード 0\n${output}`);
      }
    };
    const stop = (reason: NonNullable<typeof stopReason>) => {
      if (settled || stopReason) return;
      stopReason = reason;
      killGroup('SIGTERM');
      // Do not clear escalation merely because the shell closed its pipes.
      escalation = setTimeout(() => { killGroup('SIGKILL'); finish(); }, 1000);
      poll = setInterval(() => finish(), 20);
      cleanupDeadline = setTimeout(() => finish(true), 3000);
    };
    const timer = setTimeout(() => stop('timeout'), RUN_TIMEOUT_MS);
    const onAbort = () => stop('abort');
    signal?.addEventListener('abort', onAbort, { once: true });

    const onData = (data: Buffer) => {
      const kept = Math.min(data.length, RUN_MAX_OUTPUT - bytes);
      if (kept > 0) chunks.push(Buffer.from(data.subarray(0, kept)));
      bytes += kept;
      if (kept < data.length) truncated = true;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { failure = `起動に失敗した: ${err.message}`; });
    child.on('exit', () => {
      // Background commands are not a supported ownership transfer.
      if (groupExists()) stop('descendants');
    });
    child.on('close', (exitCode, sig) => {
      closed = true;
      code = exitCode;
      exitSignal = sig;
      finish();
    });
  });
}
