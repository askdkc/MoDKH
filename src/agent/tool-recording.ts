import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentMessage, ToolResult } from './types.ts';

export type ToolState = 'candidate' | 'not-executed' | 'unknown' | 'completed' | 'failed' | 'accepted' | 'reused';
type Reason = 'received' | 'response_discarded' | 'response_interrupted' | 'workflow_stopped' | 'scope_blocked'
  | 'recovery_blocked' | 'aborted' | 'id_conflict' | 'prior_unknown' | 'saved_result' | 'guard_blocked'
  | 'uncertain_batch' | 'dispatch_pending' | 'command_started' | 'job_registered' | 'command_exited'
  | 'nonzero_exit' | 'command_unconfirmed' | 'approval_denied' | 'preflight_rejected' | 'tool_returned' | 'tool_error';
type ResultRef = { message: number; result: number; attempt?: string; ordinal?: number };
interface CandidateKey { session: string; turn: number; attempt: string; ordinal: number; callId: string }
interface ToolRecord extends CandidateKey {
  state: ToolState;
  reason: Reason;
  jobId?: string;
  receipt?: ResultRef;
  source?: ResultRef;
}

export interface ToolRecording {
  session: string;
  write(event: ToolRecord): void;
}

/** Each destination fails independently. Nothing on the tool/model path consumes this journal. */
export function fileToolRecording(session: string, diagnostic: (text: string) => void): ToolRecording | undefined {
  const local = process.env.MODKH_TOOL_RECORD_FILE;
  if (!local) return;
  const localPath = resolve(local);
  const files = new Set([localPath]);
  if (process.env.AGENTICREPLAY_MODKH_FRAMES) files.add(resolve(process.env.AGENTICREPLAY_MODKH_FRAMES));
  return { session, write(event) {
    for (const file of files) {
      try {
        // The private journal preserves opaque provider IDs. Export only protocol identifiers.
        const frame = file !== localPath && !/^[A-Za-z0-9_-]{1,256}$/u.test(event.callId)
          ? { ...event, callId: 'sha256-' + createHash('sha256').update(event.callId).digest('hex') } : event;
        const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK, 0o600);
        try {
          const line = Buffer.from(JSON.stringify(frame) + '\n');
          if (!fstatSync(fd).isFile() || writeSync(fd, line) !== line.length) throw new Error('record write failed');
        } finally { closeSync(fd); }
      } catch {
        files.delete(file);
        try { diagnostic('TOOL_RECORD_WRITE_FAILED: ツール状態の記録を続けられません。\n'); } catch { /* diagnostic only */ }
      }
    }
  } };
}

export class CandidateRecord {
  private readonly key: CandidateKey;
  private readonly recording: ToolRecording;
  private jobId?: string;
  private receipt?: ResultRef;
  private commandSeen = false;
  private settled = false;
  constructor(recording: ToolRecording, key: CandidateKey) {
    this.recording = recording;
    this.key = key;
    this.emit('candidate', 'received');
  }
  expectReceipt(message: number, result = 0): void { this.receipt = { message, result }; }
  reference(message: number, result: number): ResultRef {
    return { message, result, attempt: this.key.attempt, ordinal: this.key.ordinal };
  }
  emit(state: ToolState, reason: Reason, source?: ResultRef): void {
    try {
      this.recording.write({ ...this.key, state, reason, ...(this.jobId && { jobId: this.jobId }), ...(this.receipt && { receipt: this.receipt }), ...(source && { source }) });
    } catch { /* A custom observer has no authority over execution. */ }
  }
  commandStarted(): void {
    this.commandSeen = true;
    this.emit('unknown', 'command_started');
  }
  accepted(id: string): void {
    this.jobId = id;
    this.emit('accepted', 'job_registered');
  }
  commandEnded(code: number | null): void {
    this.settled = true;
    if (code === null) this.emit('unknown', 'command_unconfirmed');
    else if (code === 0) this.emit('completed', 'command_exited');
    else this.emit('failed', 'nonzero_exit');
  }
  skipped(reason: 'approval_denied' | 'preflight_rejected' | 'guard_blocked' | 'aborted'): void {
    if (this.settled) return;
    this.settled = true;
    this.emit('not-executed', reason);
  }
  returned(result: ToolResult): void {
    if (this.jobId || this.settled) return;
    if (result.status === 'not-executed' && !this.commandSeen) this.emit('not-executed', 'preflight_rejected');
    else if (result.name === 'run_command' || result.status === 'unknown') this.emit('unknown', 'command_unconfirmed');
    else if (result.status === 'error') this.emit('failed', 'tool_error');
    else this.emit('completed', 'tool_returned');
  }
}

/** Journal references also work for resumed sessions whose original call predates recording. */
export class TurnToolRecords {
  private readonly recording: ToolRecording;
  private readonly turn: number;
  private readonly sources = new WeakMap<ToolResult, ResultRef>();
  private attempt = '';
  constructor(recording: ToolRecording, turn: number, messages: AgentMessage[]) {
    this.recording = recording;
    this.turn = turn;
    messages.forEach((m, i) => {
      if (m.role === 'tool') m.results.forEach((r, j) => this.remember(r, i, j));
    });
  }
  nextAttempt(): void { this.attempt = randomUUID(); }
  receive(callId: string, ordinal: number): CandidateRecord {
    return new CandidateRecord(this.recording, { session: this.recording.session, turn: this.turn, attempt: this.attempt, ordinal, callId });
  }
  remember(result: ToolResult, message: number, index = 0, candidate?: CandidateRecord): void {
    if (!this.sources.has(result)) this.sources.set(result, candidate?.reference(message, index) ?? { message, result: index });
  }
  source(result: ToolResult): ResultRef | undefined { return this.sources.get(result); }
}
