import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentMessage, ToolResult } from '../agent/types.ts';

export type SessionStatus = 'active' | 'complete' | 'interrupted' | 'error' | 'turn-limit';

/** JSONL の1行目。セッションの基本情報。seq は同ディレクトリ内の作成順(一覧の決定的並び替え用)。 */
export interface SessionHeader {
  type: 'session';
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
  | (MemoryObservation & { type: 'memory'; at: string })
  | { type: 'status'; status: SessionStatus; at: string }
  | { type: 'message'; message: AgentMessage };

export interface SessionSummary {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  status: SessionStatus;
  seq: number;
}

/** 既定の保存先。DKH_HOME で差し替え可能(検証用)。 */
export function defaultSessionDir(): string {
  if (process.env['DKH_HOME']) {
    return path.join(process.env['DKH_HOME'], 'sessions');
  }
  const configBase = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(configBase, 'dkh', 'sessions');
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

  create(cwd: string, model: string): Session {
    const createdAt = new Date().toISOString();
    const id = `${createdAt.slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const seq = fs.readdirSync(this.dir).filter((n) => n.endsWith('.jsonl')).length;
    const file = this.fileOf(id);
    const header: SessionHeader = { type: 'session', id, createdAt, cwd, model, seq };
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`, { encoding: 'utf8', flag: 'wx' });
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
  id: string;
  cwd: string;
  model: string;
  private file: string;
  private persistedCount = 0;

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
        header = ev;
        session.cwd = ev.cwd;
        session.model = ev.model;
        return;
      }
      if (ev.type === 'status') session.status = ev.status;
      else if (ev.type === 'message') session.messages.push(ev.message);
    });
    if (header === undefined) throw new Error(`ヘッダが先頭にない: ${id}`);
    session.persistedCount = session.messages.length;
    // A crash after the request journal but before a receipt is not proof of no effect.
    const pending = new Map<string, { id: string; name: string }>();
    for (const message of session.messages) {
      if (message.role === 'assistant') {
        for (const call of message.toolCalls ?? []) pending.set(call.id, call);
      } else if (message.role === 'tool') {
        for (const result of message.results) pending.delete(result.callId);
      }
    }
    if (pending.size) {
      session.messages.push({ role: 'tool', results: [...pending.values()].map(call => ({
        callId: call.id, name: call.name, status: 'unknown',
        output: '保存された要求に結果がない。実行状態は不明。自動再実行せず状態を確認する',
      })) });
      session.status = 'interrupted';
    }
    return session;
  }

  append(msg: AgentMessage): void {
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

  setStatus(status: SessionStatus): void {
    this.persistFrom(0);
    this.write({ type: 'status', status, at: new Date().toISOString() });
    this.status = status;
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
  for (const line of lines.slice(1)) {
    const ev = JSON.parse(line) as SessionEvent;
    if (ev.type === 'status') status = ev.status;
  }
  return {
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    model: header.model,
    status,
    seq: header.seq ?? 0,
  };
}
