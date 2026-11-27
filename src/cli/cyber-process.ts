import { spawn } from 'node:child_process';

/**
 * One bounded child process for /cyber.
 *
 * Arguments stay an array so a URL, host or path never becomes shell syntax.
 * The child is a process-group leader so an abort also stops grandchildren
 * (semgrep and trivy spawn helpers), and output is capped because a scanner can
 * emit megabytes. A missing executable is reported as `started: false`, which
 * lets the caller say 未実行 instead of 失敗.
 */
export interface ProcessRun {
  started: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  /** Output exceeded `maxBytes` and the rest was discarded. */
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const KILL_GRACE_MS = 1_000;

export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Written to the child's stdin, then stdin is closed (openssl x509 reads a certificate). */
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export function runProcess(file: string, args: readonly string[], signal: AbortSignal | undefined, options: ProcessOptions = {}): Promise<ProcessRun> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const closedStdin = options.input === undefined;
  return new Promise<ProcessRun>(resolve => {
    const result: ProcessRun = {
      started: true, code: null, signal: null, stdout: '', stderr: '',
      aborted: signal?.aborted === true, timedOut: false, truncated: false,
    };
    if (signal?.aborted) { resolve(result); return; }
    const child = spawn(file, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: true,
      stdio: [closedStdin ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (!closedStdin) child.stdin!.end(options.input);

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, sig); } catch { /* already gone */ }
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      killGroup('SIGTERM');
      escalation ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      result.timedOut = true;
      stop();
    }, timeoutMs) : undefined;

    const collect = (chunk: Buffer, append: (text: string) => void) => {
      if (result.truncated) return;
      const text = chunk.toString('utf8');
      const room = maxBytes - Buffer.byteLength(append === out ? result.stdout : result.stderr);
      if (Buffer.byteLength(text) > room) {
        let cut = text.slice(0, Math.max(0, room));
        // Do not split a UTF-8 sequence.
        while (cut.length > 0 && Buffer.byteLength(cut) > room) cut = cut.slice(0, -1);
        append(cut);
        result.truncated = true;
        // A scanner that cannot be read in full has no usable verdict; stop paying for output.
        stop();
        return;
      }
      append(text);
    };
    const out = (text: string) => { result.stdout += text; };
    const err = (text: string) => { result.stderr += text; };
    child.stdout!.on('data', (chunk: Buffer) => collect(chunk, out));
    child.stderr!.on('data', (chunk: Buffer) => collect(chunk, err));
    const onAbort = () => { result.aborted = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('error', () => { result.started = false; finish(); });
    child.on('close', (code, closeSignal) => {
      result.code = code;
      result.signal = closeSignal;
      finish();
    });
  });
}
