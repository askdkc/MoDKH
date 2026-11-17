import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { ToolError } from '../agent/types.ts';

/** Keep both ends of oversized output: the head names what ran, the tail holds the failure. */
const HEAD_SHARE = 0.25;

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolError('INVALID_ARGS', `${name} は空でない文字列で指定する`);
  }
  return v;
}

export type ShellName = 'bash' | 'zsh' | 'sh';
export const SHELLS: readonly ShellName[] = ['bash', 'zsh', 'sh'];

/** The shell that backs `sh`. Falls back through the usual install locations. */
export function resolveShell(name: ShellName = 'sh'): { file: string; name: ShellName } {
  if (name === 'sh') return { file: '/bin/sh', name };
  const candidates = name === 'bash'
    ? ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']
    : ['/bin/zsh', '/usr/bin/zsh'];
  for (const file of candidates) if (existsSync(file)) return { file, name };
  throw new ToolError('INVALID_ARGS', `${name} が見つからない。/bin/sh を使う`);
}

/**
 * A bounded text buffer with two views over the same stream.
 *
 * - `read(from)` serves a background job: it returns everything after an absolute position, so
 *   repeated polling reports only what is new. Old text is evicted, and a reader that fell
 *   behind is told how much it missed instead of silently receiving a gap.
 * - `text()` serves a foreground result: it keeps the FIRST part and the LAST part, because a
 *   failing command's reason is at the end while the beginning says what ran.
 *
 * Keeping the head permanently is what makes both possible; a plain rolling buffer loses it.
 */
export class TextSink {
  private readonly chunks: string[] = [];
  private first = 0;
  private length = 0;
  private readonly budget: number;
  private readonly headBudget: number;
  private head = '';
  /** Total characters ever appended, including text already evicted. */
  produced = 0;
  constructor(budget: number) {
    this.budget = budget;
    this.headBudget = Math.floor(budget * HEAD_SHARE);
  }
  push(text: string): void {
    if (text.length === 0) return;
    if (this.head.length < this.headBudget) {
      const room = this.headBudget - this.head.length;
      this.head += text.slice(0, room);
    }
    this.chunks.push(text);
    this.length += text.length;
    this.produced += text.length;
    const tailBudget = this.budget - this.headBudget;
    while (this.length > tailBudget && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.length -= dropped.length;
      this.first += dropped.length;
    }
  }
  get retainedLength(): number { return this.length; }
  /** Absolute offset of the first character still available to `read`. */
  get retainedFrom(): number { return this.first; }
  /** The foreground view: head, an elision marker, then the retained tail. */
  text(): string {
    const tail = this.chunks.join('').slice(-(this.budget - this.headBudget));
    const shown = this.head.length + tail.length;
    if (this.produced <= shown) return this.head + (this.produced > this.head.length ? tail.slice(this.head.length) : '');
    return `${this.head}\n…(${this.produced - shown} 文字省略)…\n${tail}`;
  }
  /** Everything appended after absolute position `from` (background-job view). */
  read(from: number): { text: string; next: number; dropped: number } {
    const all = this.chunks.join('');
    if (from >= this.produced) return { text: '', next: this.produced, dropped: 0 };
    if (from < this.first) return { text: all, next: this.produced, dropped: this.first - from };
    return { text: all.slice(from - this.first), next: this.produced, dropped: 0 };
  }
}

export interface ShellOptions {
  /** Defaults to POSIX sh; callers that need bash/zsh features ask for them explicitly. */
  shell?: ShellName;
  /** `0` or omitted means no timer: a background job runs until it exits or is stopped. */
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Called INSTEAD of killing the group when `timeoutMs` elapses. The receiver gets the live
   * process, so it never has to capture a variable the constructor has not assigned yet.
   *
   * This is the promotion seam: the caller keeps ownership of a still-running process instead of
   * losing its work to a deadline. Whoever receives it must continue to own its lifetime.
   */
  onTimeout?(process: ShellProcess): void;
}

export interface ShellResult {
  shell: ShellName;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/**
 * One shell invocation and its process group.
 *
 * `result` settles when the shell closed AND its group is gone, so a command cannot exit while
 * silently abandoning children. A stop is always a reject: the caller cannot tell "the command
 * failed" from "we killed it", and pretending otherwise would hide a cancelled effect.
 */
export class ShellProcess {
  readonly shell: ShellName;
  readonly startedAt = Date.now();
  readonly out: TextSink;
  readonly err: TextSink;
  readonly result: Promise<ShellResult>;
  private readonly child: ChildProcess;
  private readonly timeoutMs: number;
  private settle!: (result: ShellResult) => void;
  private fail!: (error: Error) => void;
  private settled = false;
  private closed = false;
  private code: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private stopReason: 'abort' | 'timeout' | 'descendants' | 'killed' | undefined;
  private failure: string | undefined;
  private escalation: ReturnType<typeof setTimeout> | undefined;
  private cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly promoteOnTimeout: boolean;

  constructor(command: string, cwd: string, opts: ShellOptions = {}) {
    requireString(command, 'command');
    this.shell = resolveShell(opts.shell).name;
    const maxOutput = opts.maxOutputBytes ?? 32 * 1024;
    this.out = new TextSink(Math.floor(maxOutput / 2));
    this.err = new TextSink(Math.max(1, Math.ceil(maxOutput / 2)));
    this.timeoutMs = opts.timeoutMs ?? 0;
    this.promoteOnTimeout = opts.onTimeout !== undefined;
    const file = resolveShell(opts.shell).file;
    this.child = spawn(file, ['-c', command], {
      cwd,
      ...(opts.env === undefined ? {} : { env: opts.env }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.result = new Promise<ShellResult>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
    });
    this.child.stdout!.on('data', (data: Buffer) => this.out.push(decode(data)));
    this.child.stderr!.on('data', (data: Buffer) => this.err.push(decode(data)));
    this.child.on('error', (e) => { this.failure = `起動に失敗した: ${e.message}`; });
    this.child.on('exit', () => {
      // Background commands are not a supported ownership transfer.
      if (this.groupExists()) this.stop('descendants');
    });
    this.child.on('close', (exitCode, sig) => {
      this.closed = true;
      this.code = exitCode;
      this.exitSignal = sig;
      this.finish();
    });
    if (this.timeoutMs > 0) {
      this.timer = setTimeout(() => {
        if (opts.onTimeout) {
          // Deadline reached, but the process keeps running: hand ownership over and let the
          // new owner decide. The timer is spent, so this cannot fire twice.
          this.timer = undefined;
          opts.onTimeout(this);
          return;
        }
        this.stop('timeout');
      }, this.timeoutMs);
    }
  }

  /** Detach from the result: the caller no longer awaits it, but the process keeps running. */
  abandon(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    // Keep the pipes open so output continues to fill the sinks for the new owner.
    void this.result.catch(() => {});
  }

  get pid(): number | undefined { return this.child.pid; }
  get isSettled(): boolean { return this.settled; }
  get hasSettledResult(): boolean { return this.closed && !this.groupExists(); }
  /** True once a stop was requested, so a failure can be reported as a kill. */
  get stoppedByKill(): boolean { return this.stopReason === 'killed'; }

  private groupExists(): boolean {
    if (this.child.pid === undefined) return false;
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
      this.failure = `子処理の状態を確認できない: ${(e as Error).message}`;
      return true;
    }
  }
  private killGroup(sig: NodeJS.Signals): void {
    if (this.child.pid === undefined) return;
    try { process.kill(-this.child.pid, sig); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
        this.failure = `子処理を停止できない: ${(e as Error).message}`;
      }
    }
  }
  private finish(unconfirmed = false): void {
    if (this.settled || (!unconfirmed && (!this.closed || this.groupExists()))) return;
    this.settled = true;
    clearTimeout(this.timer);
    clearTimeout(this.escalation);
    clearTimeout(this.cleanupDeadline);
    clearInterval(this.poll);
    const result: ShellResult = {
      shell: this.shell, code: this.code, signal: this.exitSignal,
      stdout: this.out.text(), stderr: this.err.text(),
      truncated: this.out.produced > this.out.retainedLength || this.err.produced > this.err.retainedLength,
      timedOut: this.stopReason === 'timeout',
      durationMs: Date.now() - this.startedAt,
    };
    if (unconfirmed) {
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      this.fail(new ToolError('RESULT_UNKNOWN', `子処理の停止を確認できない。再実行しない。${this.failure ?? ''}\n${describeShellResult(result)}`));
    } else if (this.stopReason) {
      const reason = this.stopReason === 'timeout' ? `制限時間(${this.timeoutMs}ms)を超過した`
        : this.stopReason === 'descendants' ? 'shell終了後に残った子処理を停止した'
        : this.stopReason === 'killed' ? '停止を要求された' : 'コマンドを中断した';
      // Confirmed descendant cleanup is a command lifecycle error the agent can repair.
      // User cancellation and deadlines still make the command's effects uncertain.
      const code = this.stopReason === 'descendants' ? 'RUN_FAILED' : 'ABORTED';
      const guidance = this.stopReason === 'descendants'
        ? '。子処理の停止は確認済み。終了コードだけで成功と判断しない。出力と後片付けを確認し、必要な修正を行う。' : '';
      this.fail(new ToolError(code, `${reason}(code=${this.code ?? '不明'} signal=${this.exitSignal ?? 'なし'})${guidance}\n${describeShellResult(result)}`));
    } else if (this.failure !== undefined || this.exitSignal !== null) {
      // A signalled shell is an infrastructure stop, not an ordinary failure code.
      this.fail(new ToolError('RUN_FAILED', `${this.failure ?? `signal=${this.exitSignal ?? 'なし'}`}`));
    } else {
      this.settle(result);
    }
  }

  /** Terminate the process group; the result rejects with the reason once the group is gone. */
  stop(reason: 'abort' | 'timeout' | 'descendants' | 'killed' = 'killed'): void {
    if (this.settled) return;
    if (this.stopReason) {
      // A real Stop during automatic cleanup must never become a recoverable error.
      if (this.stopReason === 'descendants' && reason !== 'descendants') this.stopReason = reason;
      return;
    }
    this.stopReason = reason;
    this.killGroup('SIGTERM');
    // Do not clear escalation merely because the shell closed its pipes.
    this.escalation = setTimeout(() => { this.killGroup('SIGKILL'); this.finish(); }, 1000);
    this.poll = setInterval(() => this.finish(), 20);
    this.cleanupDeadline = setTimeout(() => this.finish(true), 3000);
  }
}

function decode(data: Buffer): string {
  return new StringDecoder('utf8').write(data);
}

/** Model-facing text: the exit code leads so the agent reads it before the body. */
export function describeShellResult(result: ShellResult): string {
  const parts = [`[exit code: ${result.code ?? '不明'}]${result.signal ? ` [signal: ${result.signal}]` : ''}`];
  if (result.stdout) parts.push(`--- stdout ---\n${result.stdout}`.trimEnd());
  if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`.trimEnd());
  if (!result.stdout && !result.stderr) parts.push('(出力なし)');
  if (result.truncated) parts.push('[出力が上限に達したため一部を省略した]');
  return parts.join('\n');
}

/** Run one command to completion. See {@link ShellProcess} for the stop semantics. */
export function runShellProcess(command: string, cwd: string, signal?: AbortSignal, opts: ShellOptions = {}): Promise<ShellResult> {
  if (signal?.aborted) return Promise.reject(new ToolError('NOT_EXECUTED', '中断済みのため実行しない'));
  const process_ = new ShellProcess(command, cwd, opts);
  if (signal) {
    const onAbort = () => process_.stop('abort');
    if (signal.aborted) process_.stop('abort');
    else signal.addEventListener('abort', onAbort, { once: true });
    // The listener is one-shot; a settled process has nothing left to stop.
    void process_.result.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
  }
  return process_.result;
}

/** Compatibility wrapper: callers that treat a nonzero exit as a failure keep that contract. */
export async function runShell(command: string, cwd: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runShellProcess(command, cwd, signal, { env });
  if (result.code !== 0) {
    throw new ToolError('RUN_FAILED', `[exit code: ${result.code ?? '不明'}]\n${describeShellResult(result)}`);
  }
  return describeShellResult(result);
}
