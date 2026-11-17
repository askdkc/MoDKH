import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseImages } from '../agent/images.ts';
import type { AgentMessage, ToolCall, ToolResult } from '../agent/types.ts';
import { safeBoundary, type CompactionState } from '../agent/compaction.ts';
import type { DelegationRecord } from '../subagents/types.ts';
import { parseDelegation, delegationDigest } from '../subagents/request.ts';

export type SessionStatus = 'active' | 'complete' | 'interrupted' | 'error' | 'turn-limit';

/** 圧縮要約の保存上限。壊れた・巨大な記録で入力が膨らむのを防ぐ。 */
export const MAX_SUMMARY_CHARS = 20_000;

/** JSONL の1行目。セッションの基本情報。seq は同ディレクトリ内の作成順(一覧の決定的並び替え用)。 */
export interface SessionHeader {
  type: 'session';
  version?: 2;
  parentSessionId?: string;
  rootSessionId?: string;
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  seq: number;
}

export interface MemoryObservation {
  stage: 'retrieved' | 'supplied' | 'unavailable' | 'capture';
  content?: string;
  outcome?: string;
  elapsedMs?: number;
}

type SessionEvent =
  | SessionHeader
  | { type: 'connection'; model: string; baseUrl?: string }
  | { type: 'format'; version: 2 }
  | { type: 'delegation'; record: DelegationRecord }
  | (MemoryObservation & { type: 'memory'; at: string })
  | { type: 'status'; status: SessionStatus; at: string; diagnostic?: string }
  /** 圧縮の記録。messages index の from 以降を生のまま送るという意味だけを持ち、原文は消さない。 */
  | { type: 'compaction'; summary: string; from: number; at: string; keptTurns: number }
  | { type: 'message'; message: AgentMessage };

export interface SessionSummary {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  status: SessionStatus;
  seq: number;
}

/** 既定の保存先。MODKH_HOME で差し替え可能(検証用)。 */
export function defaultSessionDir(): string {
  if (process.env['MODKH_HOME']) {
    return path.join(process.env['MODKH_HOME'], 'sessions');
  }
  const configBase = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(configBase, 'modkh', 'sessions');
}

/**
 * JSONL セッションストア。1行1イベント。append で追記し、読み込みで再構築する。
 * ステータスはイベントとして追記し、最後のものが有効。完了と中断を区別する。
 */
export class SessionStore {
  private readonly dir: string;
  constructor(dir: string = defaultSessionDir()) {
    this.dir = dir;
  }

  create(cwd: string, model: string, child?: { id: string; parentSessionId: string; rootSessionId: string }): Session {
    const createdAt = new Date().toISOString();
    const id = child?.id ?? `${createdAt.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const seq = fs.readdirSync(this.dir).filter((n) => n.endsWith('.jsonl')).length;
    const file = this.fileOf(id);
    const header: SessionHeader = { type: 'session', version: 2, ...child, id, createdAt, cwd, model, seq };
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx', flush: true });
    return Session.fromText(id, file, `${JSON.stringify(header)}\n`);
  }

  load(id: string): Session {
    const file = this.fileOf(id);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error(`セッションが見つからない: ${id}(${file})`);
    }
    return Session.fromText(id, file, text);
  }

  list(): SessionSummary[] {
    fs.mkdirSync(this.dir, { recursive: true });
    const out: SessionSummary[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.dir, name);
      try {
        out.push(summarize(file, fs.readFileSync(file, 'utf8')));
      } catch {
        // 読めない・壊れたファイルは一覧に載せない(保存先の掃除はユーザーの判断に任せる)
      }
    }
    out.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return b.seq - a.seq; // 同一時刻は作成順で決定的に
    });
    return out;
  }

  private fileOf(id: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      throw new Error(`セッションIDが不正: ${id}`);
    }
    return path.join(this.dir, `${id}.jsonl`);
  }
}

export class Session {
  messages: AgentMessage[] = [];
  status: SessionStatus = 'active';
  lastError?: string;
  /** 直近の圧縮状態。未圧縮なら undefined。原文の messages は常に全文。 */
  compaction?: CompactionState;
  id: string;
  /** ヘッダの作成時刻(ワークスペース記録に使う)。古いファイルは作成時刻がない。 */
  createdAt = '';
  cwd: string;
  model: string;
  private file: string;
  modelBaseUrl?: string;
  private persistedCount = 0;
  private version: 1 | 2 = 1;
  parentSessionId?: string;
  rootSessionId?: string;
  private delegationLog = new Map<string, DelegationRecord>();

  private constructor(id: string, file: string, cwd: string, model: string) {
    this.id = id;
    this.file = file;
    this.cwd = cwd;
    this.model = model;
  }

  static fromText(id: string, file: string, text: string): Session {
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) throw new Error(`空のセッション: ${id}`);
    let header: SessionHeader | undefined;
    const session = new Session(id, file, '', '');
    lines.forEach((line, i) => {
      let ev: SessionEvent;
      try {
        ev = JSON.parse(line) as SessionEvent;
      } catch {
        throw new Error(`壊れたセッション行(${i + 1}行目): ${id}`);
      }
      if (i === 0) {
        if (ev.type !== 'session') throw new Error(`ヘッダが先頭にない: ${id}`);
        if (ev.version !== undefined && ev.version !== 2) throw new Error('Unsupported session format');
        header = ev;
        session.version = ev.version ?? 1;
        session.parentSessionId = ev.parentSessionId;
        session.rootSessionId = ev.rootSessionId;
        session.cwd = ev.cwd;
        session.model = ev.model;
        session.createdAt = typeof ev.createdAt === 'string' ? ev.createdAt : '';
        return;
      }
      if (ev.type === 'format') {
        if (ev.version !== 2) throw new Error('Unsupported session format');
        session.version = 2;
      } else if (ev.type === 'connection') {
        session.model = ev.model;
        session.modelBaseUrl = ev.baseUrl;
      } else if (ev.type === 'delegation') session.acceptDelegation(ev.record);
      else if (ev.type === 'compaction') {
        // 妥当な index だけを受け入れる。壊れた記録は無視して全文送信へ戻す(安全側)。
        if (Number.isSafeInteger(ev.from) && ev.from > (session.compaction?.from ?? 0)
            && ev.from < session.messages.length && typeof ev.summary === 'string' && ev.summary.trim()) {
          session.compaction = { summary: ev.summary.slice(0, MAX_SUMMARY_CHARS), from: ev.from };
        }
      } else if (ev.type === 'status') {
        session.status = ev.status;
        session.lastError = typeof ev.diagnostic === 'string' ? ev.diagnostic.slice(0, 2048) : undefined;
      }
      else if (ev.type === 'message') {
        if (ev.message.role === 'user' && ev.message.images !== undefined) ev.message.images = parseImages(ev.message.images);
        session.messages.push(ev.message);
      }
    });
    if (header === undefined) throw new Error(`ヘッダが先頭にない: ${id}`);
    session.persistedCount = session.messages.length;
    // A crash after the request journal but before a receipt is not proof of no effect.
    const pending = new Map<string, ToolCall>();
    for (const message of session.messages) {
      if (message.role === 'assistant') {
        for (const call of message.toolCalls ?? []) pending.set(call.id, call);
      } else if (message.role === 'tool') {
        for (const result of message.results) pending.delete(result.callId);
      }
    }
    if (pending.size) {
      const results = [...pending.values()].map(call => session.recoverPending(call));
      session.messages.push({ role: 'tool', results });
      if (results.some(result => result.status === 'unknown')) session.status = 'interrupted';
    }
    if (session.compaction && safeBoundary(session.messages, session.compaction.from) !== session.compaction.from) {
      session.compaction = undefined;
    }
    if (session.delegations().some(r => !r.result || r.result.status === 'unknown')) session.status = 'interrupted';
    return session;
  }

  private recoverPending(call: ToolCall): ToolResult {
    const base = { callId: call.id, name: call.name };
    if (call.name === 'run_subagent' || call.name === 'start_subagent') {
      const record = [...this.delegationLog.values()].find(row => row.callId === call.id);
      if (record?.state === 'finished' && record.result) {
        try {
          if (delegationDigest(parseDelegation(call.args)) === record.requestDigest) {
            const result = record.result;
            return { ...base, status: result.status === 'completed' ? 'ok' : result.status === 'unknown' ? 'unknown' : 'error', output: JSON.stringify(result) };
          }
        } catch { /* Invalid or mismatched requests never inherit a completion receipt. */ }
      }
    }
    return { ...base, status: 'unknown', output: '保存された要求に結果がない。実行状態は不明。自動再実行せず状態を確認する' };
  }

  append(msg: AgentMessage): void {
    if (msg.role === 'user' && msg.images !== undefined) msg = { ...msg, images: parseImages(msg.images) };
    this.messages.push(msg);
    this.persistFrom(0);
  }

  /**
   * ループが配列へ直接追加したメッセージをファイルへ追記する(メモリには既にある)。
   * 既存呼び出しのindex引数は互換用。保存済み位置はSession自身が追跡し、二重追記しない。
   */
  persistFrom(_index: number): void {
    while (this.persistedCount < this.messages.length) {
      this.write({ type: 'message', message: this.messages[this.persistedCount] });
      this.persistedCount++;
    }
  }

  recordMemory(observation: MemoryObservation): void {
    this.write({ ...observation, type: 'memory', at: new Date().toISOString() });
  }

  /**
   * 圧縮を記録する。原文の messages は変更しない(監査・再実行防止の根拠を保つ)。
   * 書き込みに失敗した場合はメモリ上の状態も戻し、保存と表示の不一致を作らない。
   */
  recordCompaction(state: CompactionState, keptTurns: number): void {
    this.write({ type: 'compaction', summary: state.summary, from: state.from, keptTurns, at: new Date().toISOString() });
    this.compaction = { ...state };
  }

  setConnection(model: string, baseUrl?: string): void {
    this.write({ type: 'connection', model, ...(baseUrl ? { baseUrl } : {}) });
    this.model = model;
    this.modelBaseUrl = baseUrl;
  }

  setStatus(status: SessionStatus, diagnostic?: string): void {
    this.persistFrom(0);
    const detail = diagnostic?.slice(0, 2048);
    this.write({ type: 'status', status, at: new Date().toISOString(), ...(detail ? { diagnostic: detail } : {}) });
    this.status = status; this.lastError = detail;
  }

  get delegationCount(): number { return this.delegationLog.size; }

  delegations(): DelegationRecord[] { return [...this.delegationLog.values()].map(record => structuredClone(record)); }

  private acceptDelegation(record: DelegationRecord): void {
    if (!record || record.parentSessionId !== this.id || typeof record.runId !== 'string' || typeof record.callId !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.requestDigest) || !/^[a-f0-9]{64}$/.test(record.operationDigest)
      || !['starting', 'running', 'stopping', 'finished'].includes(record.state)
      || (record.state === 'finished') !== !!record.result
      || (record.result && (!['completed', 'error', 'cancelled', 'unknown'].includes(record.result.status) || typeof record.result.text !== 'string' || record.result.runId !== record.runId || record.result.agentId !== record.childSessionId || !['settled', 'unknown'].includes(record.result.cleanup) || (record.result.status === 'completed' && record.result.cleanup !== 'settled')))) throw new Error('Invalid delegation journal');
    if ([...this.delegationLog.values()].some(row => row.callId === record.callId && row.runId !== record.runId)) throw new Error('Conflicting delegation call ID');
    const previous = this.delegationLog.get(record.runId);
    if (previous && (previous.state === 'finished' || previous.requestDigest !== record.requestDigest || previous.operationDigest !== record.operationDigest || previous.callId !== record.callId)) throw new Error('Conflicting delegation journal');
    this.delegationLog.set(record.runId, structuredClone(record));
  }

  recordDelegation(record: DelegationRecord): void {
    // Validate without changing the live projection until persistence succeeds.
    const before = this.delegationLog;
    this.delegationLog = new Map(before);
    try {
      this.acceptDelegation(record);
      if (this.version === 1) { this.write({ type: 'format', version: 2 }); this.version = 2; }
      this.write({ type: 'delegation', record });
    } catch (e) { this.delegationLog = before; throw e; }
  }

  /** 結果不明のツール呼び出し(中断の痕跡)。再開時の表示と再実行禁止の根拠に使う。 */
  unknownToolResults(): ToolResult[] {
    const out: ToolResult[] = [];
    for (const m of this.messages) {
      if (m.role === 'tool') {
        for (const r of m.results) {
          if (r.status === 'unknown') out.push(r);
        }
      }
    }
    return out;
  }

  private write(ev: SessionEvent): void {
    fs.appendFileSync(this.file, `${JSON.stringify(ev)}\n`, { encoding: 'utf8', flush: true });
  }
}

function summarize(file: string, text: string): SessionSummary {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = JSON.parse(lines[0] ?? '') as SessionHeader;
  if (header.type !== 'session') throw new Error(`ヘッダが先頭にない: ${file}`);
  let status: SessionStatus = 'active';
  let model = header.model;
  for (const line of lines.slice(1)) {
    const ev = JSON.parse(line) as SessionEvent;
    if (ev.type === 'status') status = ev.status;
    if (ev.type === 'connection') model = ev.model;
  }
  return {
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    model,
    status,
    seq: header.seq ?? 0,
  };
}
