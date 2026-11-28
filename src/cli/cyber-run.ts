import { spawn } from 'node:child_process';

/**
 * One bounded child process for the security scan.
 *
 * A program name plus an argument array means a URL, host or path never becomes
 * shell syntax. The child leads its own process group, so an abort also stops
 * grandchildren (semgrep and trivy start helpers). Output is capped because a
 * scanner can print megabytes, and a truncated report has no usable verdict.
 * A missing executable is `started: false`, which lets the caller report 未実行
 * instead of 失敗.
 */
export interface RunResult {
  started: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  truncated: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

const KILL_GRACE_MS = 1_000;

export function runTool(program: string, args: readonly string[], signal: AbortSignal, options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  return new Promise<RunResult>(resolve => {
    const result: RunResult = {
      started: true, code: null, stdout: '', stderr: '',
      aborted: signal.aborted, timedOut: false, truncated: false,
    };
    if (signal.aborted) { resolve(result); return; }
    let child;
    try {
      child = spawn(program, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      result.started = false;
      resolve(result);
      return;
    }

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, sig); } catch { /* already gone */ }
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      escalation.unref?.();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs) : undefined;
    timer?.unref?.();

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (result.truncated) return;
      const room = maxBytes - Buffer.byteLength(result[target]);
      const text = chunk.toString('utf8');
      if (Buffer.byteLength(text) > room) {
        let cut = text.slice(0, Math.max(0, room));
        // Do not split a UTF-8 sequence.
        while (cut.length > 0 && Buffer.byteLength(cut) > room) cut = cut.slice(0, -1);
        result[target] += cut;
        result.truncated = true;
        // A scanner that cannot be read in full has no verdict; stop paying for output.
        stop();
        return;
      }
      result[target] += text;
    };
    child.stdout!.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr!.on('data', (chunk: Buffer) => append('stderr', chunk));

    const onAbort = () => { result.aborted = true; stop(); };
    signal.addEventListener('abort', onAbort, { once: true });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('error', () => { result.started = false; finish(); });
    child.on('close', (code) => { result.code = code; finish(); });
  });
}
