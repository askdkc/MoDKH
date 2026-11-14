import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
/** A single call may run much longer than the default, but never without a bound. */
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT = 32 * 1024;
/** Keep both ends of oversized output: the head names what ran, the tail holds the failure. */
const HEAD_SHARE = 0.25;

export type ShellName = 'bash' | 'zsh' | 'sh';
const SHELLS: readonly ShellName[] = ['bash', 'zsh', 'sh'];

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolError('INVALID_ARGS', `${name} は空でない文字列で指定する`);
  }
  return v;
}

function optionalString(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new ToolError('INVALID_ARGS', `${name} は${max}文字以内の文字列で指定する`);
  return v;
}

function positiveInt(v: unknown, name: string, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : typeof v === 'number' ? v : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ToolError('INVALID_ARGS', `${name} は1〜${max}の整数で指定する`);
  return n;
}

/** The shell that actually backs `sh`. Diagnostics prefer bash, then zsh, then POSIX sh. */
export function resolveShell(name: ShellName = 'sh'): { file: string; name: ShellName } {
  if (name === 'sh') return { file: '/bin/sh', name };
  const candidates = name === 'bash' ? ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'] : ['/bin/zsh', '/usr/bin/zsh'];
  for (const file of candidates) if (fs.existsSync(file)) return { file, name };
  throw new ToolError('INVALID_ARGS', `${name} が見つからない。/bin/sh を使う`);
}

export interface ShellOptions {
  /** Defaults to POSIX sh; callers that need bash/zsh features ask for them explicitly. */
  shell?: ShellName;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ShellResult {
  shell: ShellName;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when either stream lost its middle to the byte cap. */
  truncated: boolean;
  droppedBytes: number;
  timedOut: boolean;
  durationMs: number;
}

/** Split a byte budget between the head and the tail of one stream. */
function clip(text: string, budget: number): { text: string; dropped: number } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= budget) return { text, dropped: 0 };
  const headBudget = Math.max(0, Math.floor(budget * HEAD_SHARE));
  const tailBudget = Math.max(0, budget - headBudget);
  const chars = [...text];
  // Work in characters but measure in bytes, so multi-byte text is never cut mid-sequence.
  let head = '', headBytes = 0;
  for (const ch of chars) {
    const n = Buffer.byteLength(ch);
    if (headBytes + n > headBudget) break;
    head += ch; headBytes += n;
  }
  let tail = '', tailBytes = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    const n = Buffer.byteLength(ch);
    if (tailBytes + n > tailBudget) break;
    tail = ch + tail; tailBytes += n;
  }
  const dropped = bytes - headBytes - tailBytes;
  return { text: `${head}\n…(${dropped} バイト省略)…\n${tail}`, dropped };
}

/**
 * Buffers one stream under a byte budget while keeping BOTH ends.
 *
 * Truncating as the data arrives would keep only the beginning, and the beginning of a test
 * log is exactly where the failure is not. A rolling tail preserves the part the agent needs.
 */
class Sink {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer = Buffer.alloc(0);
  private readonly budget: number;
  received = 0;
  constructor(budget: number) { this.budget = budget; }
  private get headBudget(): number { return Math.floor(this.budget * HEAD_SHARE); }
  private get tailBudget(): number { return this.budget - this.headBudget; }
  push(data: Buffer): void {
    this.received += data.length;
    const room = this.headBudget - this.headBytes;
    if (room > 0) {
      const kept = data.subarray(0, Math.min(room, data.length));
      if (kept.length > 0) { this.head.push(Buffer.from(kept)); this.headBytes += kept.length; }
    }
    if (this.tailBudget <= 0) return;
    const combined = this.tail.length === 0 ? data : Buffer.concat([this.tail, data]);
    this.tail = combined.length <= this.tailBudget
      ? combined
      : Buffer.from(combined.subarray(combined.length - this.tailBudget));
  }
  /** Only complete UTF-8 sequences survive: a partial trailing sequence is dropped. */
  text(): { text: string; dropped: number } {
    const decoder = new StringDecoder('utf8');
    const headText = decoder.write(Buffer.concat(this.head));
    const tailText = new StringDecoder('utf8').write(this.tail);
    const dropped = this.received - this.headBytes - this.tail.length;
    if (dropped <= 0) return { text: headText + tailText, dropped: 0 };
    // The head and tail may overlap when the stream is just over budget; joining them would
    // duplicate bytes, so keep only the head in that case.
    const overlap = this.headBytes + this.tail.length > this.received;
    return { text: overlap ? headText : `${headText}\n…(${dropped} バイト省略)…\n${tailText}`, dropped };
  }
}

/**
 * Run one command. A nonzero exit is a RESULT, not an error: the caller decides what it means.
 * Only a spawn failure, an unrecoverable stop, or an unconfirmed shutdown rejects.
 */
export function runShellProcess(command: string, cwd: string, signal?: AbortSignal, opts: ShellOptions = {}): Promise<ShellResult> {
  // Approval is asynchronous: Stop may have arrived after the earlier check.
  if (signal?.aborted) return Promise.reject(new ToolError('NOT_EXECUTED', '中断済みのため実行しない'));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const shell = resolveShell(opts.shell);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    // A dedicated POSIX process group owns the shell and its ordinary descendants.
    // This is not a sandbox: commands deliberately daemonizing must not be used.
    const child = spawn(shell.file, ['-c', command], {
      cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let closed = false;
    let code: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stopReason: 'abort' | 'timeout' | 'descendants' | undefined;
    let failure: string | undefined;
    const out = new Sink(Math.floor(maxOutput / 2));
    const err = new Sink(Math.ceil(maxOutput / 2));
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
    const decode = (chunks: Buffer[]): string => {
      const decoder = new StringDecoder('utf8');
      return decoder.write(Buffer.concat(chunks)) + decoder.end();
    };
    const finish = (unconfirmed = false) => {
      if (settled || (!unconfirmed && (!closed || groupExists()))) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(cleanupDeadline);
      clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
      const head = out.text();
      const tail = err.text();
      const result: ShellResult = {
        shell: shell.name, code, signal: exitSignal,
        stdout: head.text, stderr: tail.text,
        truncated: head.dropped > 0 || tail.dropped > 0,
        droppedBytes: head.dropped + tail.dropped,
        timedOut: stopReason === 'timeout',
        durationMs: Date.now() - started,
      };
      if (unconfirmed) {
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new ToolError('RESULT_UNKNOWN', `子処理の停止を確認できない。再実行しない。${failure ?? ''}\n${formatShellResult(result)}`));
      } else if (stopReason) {
        const reason = stopReason === 'timeout' ? `制限時間(${timeoutMs}ms)を超過した`
          : stopReason === 'descendants' ? 'shell終了後に残った子処理を停止した' : 'コマンドを中断した';
        // Partial output is evidence: keep it in the failure instead of reporting only the reason.
        reject(new ToolError('ABORTED', `${reason}(code=${code ?? '不明'} signal=${exitSignal ?? 'なし'})\n${formatShellResult(result)}`));
      } else if (failure !== undefined || exitSignal !== null) {
        // A signalled shell is an infrastructure stop, not an ordinary failure code.
        reject(new ToolError('RUN_FAILED', `${failure ?? `signal=${exitSignal ?? 'なし'}`}`));
      } else {
        resolve(result);
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
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('abort');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (data: Buffer) => out.push(data));
    child.stderr.on('data', (data: Buffer) => err.push(data));
    child.on('error', (e) => { failure = `起動に失敗した: ${e.message}`; });
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

/**
 * Compatibility wrapper for callers that treat a nonzero exit as a failure.
 * It keeps the old contract (throw `RUN_FAILED`) so external-subagent reporting is unchanged.
 */
export async function runShell(command: string, cwd: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runShellProcess(command, cwd, signal, { env });
  const body = [
    result.stdout ? `--- stdout ---\n${result.stdout}` : '',
    result.stderr ? `--- stderr ---\n${result.stderr}` : '',
  ].filter(Boolean).join('\n');
  if (result.code !== 0) {
    throw new ToolError('RUN_FAILED', `[exit code: ${result.code ?? '不明'}]\n${body}`);
  }
  return `[exit code: 0]\n${body}`;
}

/** Model-facing text: the exit code leads so the agent reads it before the body. */
export function formatShellResult(result: ShellResult): string {
  const parts = [`[exit code: ${result.code ?? '不明'}]${result.signal ? ` [signal: ${result.signal}]` : ''}`];
  if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`.trimEnd());
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`.trimEnd());
  if (!result.stdout && !result.stderr) parts.push('(出力なし)');
  if (result.truncated) parts.push(`[出力は上限に達したため中間を省略した。全 ${result.droppedBytes} バイト省略]`);
  return parts.join('\n');
}

export const runCommandTool: Tool = {
  name: 'run_command',
  operationIdentity: (args, ctx) => ({
    command: args.command,
    cwd: resolveInRoot(ctx.root, typeof args.cwd === 'string' ? args.cwd : '.'),
    shell: args.shell ?? 'sh',
  }),
  description:
    'シェルコマンドを1回実行し、終了コード・stdout・stderr を返す。作業場所は作業ルート内に限る。'
    + '終了コードが0以外でも実行結果として返る(エラー扱いにはしない)。'
    + 'cd は次の呼び出しに引き継がれないので cwd を指定する。'
    + '確認は grep やテスト実行のように終了コードを見て判断する。',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '何をするコマンドか(5〜10語、命令形。例: "run unit tests")' },
      command: { type: 'string', description: '実行するコマンド' },
      cwd: { type: 'string', description: '作業ディレクトリ(ルート相対、既定はルート)' },
      shell: { type: 'string', enum: [...SHELLS], description: '使用するシェル(既定 sh。bash/zsh の構文が必要なときだけ指定)' },
      timeoutMs: { type: 'number', description: `制限時間(ミリ秒、既定 ${DEFAULT_TIMEOUT_MS}、上限 ${MAX_TIMEOUT_MS})` },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    const command = requireString(args.command, 'command');
    const cwdRel = args.cwd === undefined ? '.' : requireString(args.cwd, 'cwd');
    const shellArg = optionalString(args.shell, 'shell', 8);
    if (shellArg !== undefined && !(SHELLS as readonly string[]).includes(shellArg)) {
      throw new ToolError('INVALID_ARGS', `shell は ${SHELLS.join(' | ')} のいずれか`);
    }
    const timeoutMs = positiveInt(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS);
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
    const result = await runShellProcess(command, cwd, ctx.signal, {
      shell: (shellArg as ShellName | undefined) ?? 'sh',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return formatShellResult(result);
  },
};
