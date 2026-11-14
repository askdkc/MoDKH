import type { ImageAttachment } from './images.ts';

// ツール・モデル・セッションの共通契約。
// このファイルは node --test で型除去のまま実行されるため、
// erasable な TypeScript 構文のみを使う(enum / namespace は不使用)。

/** モデルが出した1件のツール要求。 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** unknown は副作用が不明、not-executed は未実行を確認済み。okはツール終了であり目標達成ではない。 */
export interface ToolResult {
  callId: string;
  name: string;
  status: 'ok' | 'error' | 'unknown' | 'not-executed';
  output: string;
}

/** モデルへ渡すツール定義(JSON Schema の parameters を含む)。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 承認要求。edit は diff、command は実行内容と作業場所を detail に載せる。 */
export interface ApprovalRequest {
  kind: 'edit' | 'command';
  title: string;
  detail: string;
  /**
   * True when the caller proved the target is outside the working root. Omitted means "not proven",
   * which an approval policy must treat as outside, so a policy can never skip a wider effect.
   */
  outsideWorkspace?: boolean;
  /** Cancels only this approval request (e.g. a timed-out child). */
  signal?: AbortSignal;
}

export interface ApprovalGate {
  approve(req: ApprovalRequest): Promise<boolean>;
}

export interface ToolContext {
  /** 作業ルート(絶対パス)。すべてのファイル操作とコマンド cwd をここに制限する。 */
  root: string;
  approval: ApprovalGate;
  /** Ctrl+C などで中断されたときに打ち切る。 */
  signal?: AbortSignal;
  /** Assigned by the registry, never a model-controlled argument. */
  callId?: string;
  /**
   * Post-effect analysis (structure, diagnostics). It runs after a successful read/write and its
   * failure must never change the tool's own result or cause a second edit.
   */
  analyze?(file: string, kind: 'read' | 'write'): Promise<string | null>;
}

/** ツール内部の期待される失敗。モデルへ status:'error' として返す。 */
export class ToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** ツール本体。失敗は ToolError を throw し、実装外の事故は上位で error 扱いにする。 */
export interface Tool {
  /** Trusted implementation metadata, never a model argument. Defaults to effectful. */
  readOnly?: boolean;
  /** Pure trusted identity for uncertain-operation matching; never normalize command text.
   * Call-ID conflicts still compare original arguments, not this identity. */
  operationIdentity?(args: Record<string, unknown>, ctx: ToolContext): unknown;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string | Pick<ToolResult, 'status' | 'output'>>;
}

/** モデルストリームのイベント。 */
export type ModelEvent =
  | { type: 'activity'; stage: 'reasoning' | 'tool-input' }
  | { type: 'usage'; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'text-delta'; text: string }
  /** Provider-reported reasoning. Shown to the human, never merged into assistant content. */
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | {
      type: 'finish';
      stopReason: 'stop' | 'tool-calls' | 'aborted' | 'error';
      errorMessage?: string;
    };

/** 会話メッセージ。tool メッセージは1つのアシスタント応答に対する結果群を保持する。 */
export type AgentMessage =
  | { role: 'user'; content: string; images?: ImageAttachment[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; origin?: 'manual' }
  | { role: 'tool'; results: ToolResult[] };

export interface ModelRequest {
  messages: AgentMessage[];
  tools: ToolSpec[];
  system?: string;
}

/**
 * 接続方式の違いを Agent ループから隠す。実装は各アダプターに置く。
 * 中断は signal で要求し、アダプターは 'aborted' の finish で静かに終わる。
 */
export interface Model {
  readonly id: string;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export function isToolError(e: unknown): e is ToolError {
  return e instanceof ToolError;
}
