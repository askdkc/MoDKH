import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ToolError } from '../agent/types.ts';
import type { ApprovalGate } from '../agent/types.ts';
import type { ExternalHost, ProcessRequest, ProcessResult } from '../plugins/api.ts';
import { object, fields, text } from '../plugins/package.ts';
import { runShell } from '../tools/run.ts';
import type { Session } from '../session/store.ts';

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Tracks every host-managed process even if a plugin forgets to await it. */
export class ExternalProcesses implements ExternalHost {
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private closed = false;
  private jobs: Promise<ProcessResult>[] = [];
  readonly outcomes: ProcessResult[] = [];
  private root: string;
  private approval: ApprovalGate;
  private session: Session;
  constructor(root: string, approval: ApprovalGate, session: Session, signal: AbortSignal) {
    this.root = root; this.approval = approval; this.session = session;
    this.signal = AbortSignal.any([signal, this.controller.signal]);
  }
  run(request: ProcessRequest): Promise<ProcessResult> {
    if (this.closed || this.signal.aborted) return Promise.reject(new ToolError('NOT_EXECUTED', 'External host is closed'));
    const raw = object(request);
    fields(raw, ['command', 'args']);
    const command = text(raw.command, 'command', 4096);
    if (!Array.isArray(raw.args) || raw.args.length > 256 || !raw.args.every(a => typeof a === 'string' && !a.includes('\0')) || Buffer.byteLength(JSON.stringify(raw.args)) > 131072) throw new Error('Invalid process arguments');
    const line = [command, ...raw.args as string[]].map(shellQuote).join(' ');
    const job = this.execute(line);
    this.jobs.push(job);
    // Observe rejection without detaching its ownership; close() collects it again.
    void job.catch(() => {});
    return job;
  }
  private async execute(command: string): Promise<ProcessResult> {
    const callId = randomUUID();
    this.session.append({ role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'external_process', args: { command, cwd: this.root } }] });
    let result: ProcessResult;
    try {
      if (this.signal.aborted) throw new ToolError('NOT_EXECUTED', '中断済み');
      const approved = await this.approval.approve({ signal: this.signal, kind: 'command', title: '外部プラグインのプロセス起動', detail: `${command}\n作業場所: ${this.root}\nOSサンドボックスではありません。リモート処理の停止は保証できません。` });
      if (!approved) throw new ToolError('DENIED', '実行は承認されませんでした');
      if (this.signal.aborted || fs.realpathSync(this.root) !== this.root) throw new ToolError('NOT_EXECUTED', '停止済み、または作業場所が変更されました');
      // No inherited provider credentials. A trusted CLI can still access its own files.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) env[key] = process.env[key];
      result = { status: 'ok', output: await runShell(command, this.root, this.signal, env), cleanup: 'settled' };
    } catch (e) {
      const code = e instanceof ToolError ? e.code : 'RESULT_UNKNOWN';
      result = { status: code === 'NOT_EXECUTED' || code === 'DENIED' ? 'not-executed' : code === 'RUN_FAILED' ? 'error' : 'unknown', output: String(e), cleanup: code === 'RESULT_UNKNOWN' ? 'unknown' : 'settled' };
    }
    this.outcomes.push(result);
    this.session.append({ role: 'tool', results: [{ callId, name: 'external_process', status: result.status, output: result.output }] });
    return result;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    const settled = await Promise.allSettled(this.jobs);
    const failures = settled.filter(r => r.status === 'rejected');
    if (failures.length || this.outcomes.some(r => r.cleanup === 'unknown')) throw new Error('External process cleanup or journaling is unconfirmed');
  }
}
