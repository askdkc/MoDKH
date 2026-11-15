import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export interface ExecutionReceipt {
  state: 'exited' | 'aborted' | 'timed-out' | 'not-started' | 'output-limit' | 'unknown';
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  inputDigest: string;
  cleanup: 'settled' | 'unknown';
}
export function privateEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8',
    HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    XDG_DATA_HOME: home, XDG_STATE_HOME: home,
    ...(process.env.SBCL_HOME ? { SBCL_HOME: process.env.SBCL_HOME } : {}) };
}
export function temporaryDirectory(prefix: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** shell:false, bounded pipes and owned POSIX process group. Escaped sessions are not a sandbox. */
export function executeBounded(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; inputDigest: string; timeoutMs: number;
  maxOutputBytes?: number; signal?: AbortSignal;
}): Promise<ExecutionReceipt> {
  const base: ExecutionReceipt = { state: 'not-started', exitCode: null, signal: null, stdout: '', stderr: '', inputDigest: options.inputDigest, cleanup: 'settled' };
  if (options.signal?.aborted) return Promise.resolve(base);
  if (process.platform === 'win32') return Promise.resolve({ ...base, stderr: 'POSIX process groups required' });
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let closed = false, finished = false, bytes = 0;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let stopped: ExecutionReceipt['state'] | undefined;
    let poll: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
    };
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* checked at settlement */ } } };
    const finish = (unknown = false) => {
      if (finished || (!unknown && (!closed || alive()))) return;
      finished = true;
      clearTimeout(timer); clearTimeout(deadline); clearInterval(poll);
      options.signal?.removeEventListener('abort', abort);
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve({ ...base, state: unknown ? 'unknown' : stopped ?? (base.exitCode === null ? 'not-started' : 'exited'), cleanup: unknown ? 'unknown' : 'settled' });
    };
    const stop = (state: ExecutionReceipt['state']) => {
      stopped ??= state; kill();
      poll ??= setInterval(() => finish(), 20);
      deadline ??= setTimeout(() => finish(true), 3000);
    };
    const abort = () => stop('aborted');
    const timer = setTimeout(() => stop('timed-out'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const append = (key: 'stdout' | 'stderr', data: Buffer) => {
      const budget = options.maxOutputBytes ?? 256 * 1024;
      const room = Math.max(0, budget - bytes);
      base[key] += decoders[key].write(data.subarray(0, room)); bytes += data.length;
      if (bytes > budget) stop('output-limit');
    };
    child.stdout?.on('data', (data: Buffer) => append('stdout', data));
    child.stderr?.on('data', (data: Buffer) => append('stderr', data));
    child.on('error', error => { base.stderr = error.message.slice(0, 4096); });
    child.on('exit', () => { if (alive()) stop('unknown'); });
    child.on('close', (code, signal) => { closed = true; base.stdout += decoders.stdout.end(); base.stderr += decoders.stderr.end(); base.exitCode = code; base.signal = signal; finish(); });
  });
}
