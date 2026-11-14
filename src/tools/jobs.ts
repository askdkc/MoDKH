import { randomUUID } from 'node:crypto';
import { ShellProcess, describeShellResult, type ShellName } from './shell-process.ts';

/**
 * Background job registry.
 *
 * Ownership and lifetime are the registry's; running the command is the producer's. A job keeps
 * its own output cursor so repeated reads return only what is new, and a settled job stays
 * readable so a late `job_output` still reports how it ended.
 *
 * Registered jobs never outlive the owning session: `close()` stops every job and waits for the
 * process groups to disappear, so DKH cannot exit leaving orphaned children.
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';

export interface JobView {
  id: string;
  kind: 'bash';
  /** First line of the command, is bounded, and is what the human sees. */
  label: string;
  command: string;
  cwd: string;
  shell: ShellName;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  /** Exit code once settled normally; never invented for a killed or failed job. */
  exitCode?: number | null;
  /** Why the job ended, when it did not simply exit. */
  detail?: string;
}

interface JobRecord {
  view: JobView;
  process: ShellProcess;
  /** Absolute character positions the model has already read. */
  outCursor: number;
  errCursor: number;
  /** Bytes the model has not seen, so a completion notice can quote the rest. */
  unreadOut: number;
  unreadErr: number;
  waiters: Set<() => void>;
}

export interface JobStartRequest {
  command: string;
  cwd: string;
  shell: ShellName;
  description?: string;
  /** Not applied to background jobs: a job has no deadline, only an explicit kill. */
}

const MAX_RETAINED_JOBS = 32;
const LABEL_MAX = 120;

function label(command: string, description?: string): string {
  const text = (description?.trim() || command.trim().split('\n')[0] || command).replace(/\s+/g, ' ');
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1)}…`;
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private closed = false;
  /** Settlements the model has not been told about yet, in completion order. */
  private readonly notices: string[] = [];
  /** Owner-visible label for a notice; never contains the command's full output. */
  private noticeBytes = 2048;

  get size(): number { return this.jobs.size; }

  /** Drain pending completion notices. Returns [] when every settlement was already reported. */
  takeNotices(): string[] {
    return this.notices.splice(0, this.notices.length);
  }

  get hasNotices(): boolean { return this.notices.length > 0; }

  private notice(record: JobRecord): void {
    const view = record.view;
    const status = view.exitCode === undefined || view.exitCode === null ? view.status : `${view.status}, exit ${view.exitCode}`;
    const head = `バックグラウンドジョブ ${view.id} (${view.label}) が終了した [${status}]`;
    // Quote only what the model has not read, and only when it fits; otherwise name the tool.
    const unread = record.process.out.read(record.outCursor).text + record.process.err.read(record.errCursor).text;
    if (unread.trim().length === 0) {
      this.notices.push(`${head}。新しい出力はない。`);
      return;
    }
    if (unread.length <= this.noticeBytes) {
      this.notices.push(`${head}。未読の出力:\n${unread.trimEnd()}\n(job_output で続きを読める)`);
      return;
    }
    this.notices.push(`${head}。未読の出力が ${unread.length} 文字ある。job_output で読む。`);
  }

  start(request: JobStartRequest): JobView {
    if (this.closed) throw new Error('ジョブ実行は終了済み');
    const process = new ShellProcess(request.command, request.cwd, { shell: request.shell });
    return this.register(process, request);
  }

  /**
   * Take ownership of a process that is already running.
   *
   * This is how a foreground command that reached its deadline keeps its work: the caller
   * abandons its own await and the job registry continues to observe, report, and stop it.
   * Everything already produced on stdout/stderr is available to the first `job_output`.
   */
  adopt(process: ShellProcess, request: JobStartRequest): JobView {
    if (this.closed) {
      process.stop('killed');
      throw new Error('ジョブ実行は終了済み');
    }
    return this.register(process, request);
  }

  private register(process: ShellProcess, request: JobStartRequest): JobView {
    // Bound retained history: drop the oldest settled record, never a live one.
    if (this.jobs.size >= MAX_RETAINED_JOBS) {
      const settled = [...this.jobs.values()].find(record => record.view.status !== 'running' && record.view.status !== 'stopping');
      if (settled) this.jobs.delete(settled.view.id);
    }
    const id = `bash-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const view: JobView = {
      id, kind: 'bash', label: label(request.command, request.description),
      command: request.command, cwd: request.cwd, shell: request.shell,
      status: 'running', startedAt: Date.now(),
    };
    const record: JobRecord = { view, process, outCursor: 0, errCursor: 0, unreadOut: 0, unreadErr: 0, waiters: new Set() };
    this.jobs.set(id, record);
    void process.result.then(
      result => {
        view.status = 'completed';
        view.finishedAt = Date.now();
        view.exitCode = result.code;
      },
      (error: Error) => {
        view.finishedAt = Date.now();
        if (process.stoppedByKill) {
          view.status = 'killed';
          // A human-supplied reason is more useful than the generic cause; keep it.
          view.detail ??= '停止を要求された';
        } else { view.status = 'failed'; view.detail = error.message.split('\n')[0]; }
      },
    ).finally(() => {
      record.unreadOut = process.out.produced - record.outCursor;
      record.unreadErr = process.err.produced - record.errCursor;
      this.notice(record);
      for (const wake of record.waiters) wake();
      record.waiters.clear();
    });
    return { ...view };
  }

  list(): JobView[] {
    return [...this.jobs.values()].map(record => ({ ...record.view }));
  }

  get(id: string): JobView | undefined {
    const record = this.jobs.get(id);
    return record ? { ...record.view } : undefined;
  }

  private require(id: string): JobRecord {
    const record = this.jobs.get(id);
    if (!record) throw new Error(`不明なジョブ: ${id}`);
    return record;
  }

  /** Output appended since the previous read. The cursor advances only for a delivered read. */
  read(id: string): { job: JobView; stdout: string; stderr: string; dropped: number } {
    const record = this.require(id);
    const out = record.process.out.read(record.outCursor);
    const err = record.process.err.read(record.errCursor);
    record.outCursor = out.next;
    record.errCursor = err.next;
    record.unreadOut = 0;
    record.unreadErr = 0;
    return { job: { ...record.view }, stdout: out.text, stderr: err.text, dropped: out.dropped + err.dropped };
  }

  /**
   * Wait until the job settles, new output appears, or the timeout expires.
   *
   * Returning early on new output is what makes polling useful: a long build reports progress
   * instead of forcing the caller to choose between blocking for minutes and busy-looping.
   */
  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const record = this.require(id);
    const settledNow = () => record.view.status !== 'running' && record.view.status !== 'stopping';
    if (settledNow()) return Promise.resolve();
    const outMark = record.process.out.produced;
    const errMark = record.process.err.produced;
    return new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        signal?.removeEventListener('abort', finish);
        record.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      // Output arrives through a stream, not an event the registry owns; a bounded poll keeps
      // the seam small without making every job wake the registry on each chunk.
      const poll = setInterval(() => {
        if (settledNow()
          || record.process.out.produced !== outMark
          || record.process.err.produced !== errMark) finish();
      }, 10);
      signal?.addEventListener('abort', finish, { once: true });
      record.waiters.add(finish);
    });
  }

  async kill(id: string, reason?: string): Promise<JobView> {
    const record = this.require(id);
    if (record.view.status === 'running') {
      record.view.status = 'stopping';
      if (reason !== undefined && reason.length > 0) record.view.detail = reason.slice(0, 200);
      record.process.stop('killed');
    }
    return { ...record.view };
  }

  /** Stop every job and wait for the process groups to settle. */
  async close(): Promise<void> {
    this.closed = true;
    const live = [...this.jobs.values()].filter(record => record.view.status === 'running' || record.view.status === 'stopping');
    for (const record of live) { record.view.status = 'stopping'; record.process.stop('killed'); }
    await Promise.allSettled(live.map(record => record.process.result));
    this.jobs.clear();
  }
}
