import { isDeepStrictEqual } from 'node:util';
import type { AgentMessage, Model, ToolCall, ToolResult, ToolSpec } from './types.ts';
import { ToolRegistry } from '../tools/registry.ts';

export interface LoopHooks {
  /** Input passed to the adapter, not proof of provider receipt or memory application. */
  onModelRequest?(): void;
  onModelActivity?(stage: 'reasoning' | 'tool-input'): void;
  /** Provider-reported token usage for one completed step; never an estimate. */
  onUsage?(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): void;
  onText?(delta: string): void;
  onToolCall?(call: ToolCall): void;
  onToolResult?(r: ToolResult): void;
}

export interface AgentLoopOptions {
  model: Model;
  registry: ToolRegistry;
  root: string;
  system?: string;
  signal: AbortSignal;
  approval: import('./types.ts').ApprovalGate;
  hooks?: LoopHooks;
  maxTurns?: number;
  /** Persist newly appended messages synchronously; failure prevents further effects. */
  checkpoint?(): void;
  /** Optional post-effect analysis; its failure never changes the tool result or replays an effect. */
  analyze?(file: string, kind: 'read' | 'write'): Promise<string | null>;
}

/** complete means response finished, not verified achievement of the user's goal. */
export type TurnOutcome = 'complete' | 'interrupted' | 'error' | 'turn-limit';
export interface TurnResult { outcome: TurnOutcome; errorMessage?: string }
const DEFAULT_MAX_TURNS = 25;

/** Call IDs belong to this conversation, not a global registry or another repository. */
function previousCalls(messages: AgentMessage[]): Map<string, { call: ToolCall; result?: ToolResult }> {
  const ledger = new Map<string, { call: ToolCall; result?: ToolResult }>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (!ledger.has(call.id)) ledger.set(call.id, { call });
      }
    } else if (message.role === 'tool') {
      for (const result of message.results) {
        const entry = ledger.get(result.callId);
        if (entry && !entry.result) entry.result = result;
      }
    }
  }
  return ledger;
}

/** Preserve partial evidence, journal before effects, never replay uncertain calls. */
export async function runAgentLoop(messages: AgentMessage[], opts: AgentLoopOptions): Promise<TurnResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const toolSpecs: ToolSpec[] = opts.registry.specs();
  const ledger = previousCalls(messages);
  const append = (message: AgentMessage) => {
    messages.push(message);
    opts.checkpoint?.();
  };
  for (let turn = 0; turn < maxTurns; turn++) {
    if (opts.signal.aborted) return { outcome: 'interrupted' };
    let text = '';
    const calls: ToolCall[] = [];
    let stopReason: 'stop' | 'tool-calls' | 'aborted' | 'error' | undefined;
    let errorMessage: string | undefined;
    try {
      opts.hooks?.onModelRequest?.();
      for await (const ev of opts.model.stream({ messages, tools: toolSpecs, system: opts.system }, opts.signal)) {
        if (opts.signal.aborted) break;
        if (ev.type === 'usage') {
          opts.hooks?.onUsage?.(ev);
        } else if (ev.type === 'activity') {
          opts.hooks?.onModelActivity?.(ev.stage);
        } else if (ev.type === 'text-delta') {
          text += ev.text;
          opts.hooks?.onText?.(ev.text);
        } else if (ev.type === 'tool-call') {
          calls.push(ev.call);
          opts.hooks?.onToolCall?.(ev.call);
        } else {
          stopReason = ev.stopReason;
          errorMessage = ev.errorMessage;
          break;
        }
      }
    } catch (e) {
      stopReason = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
    }
    append({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) });
    const interrupted = opts.signal.aborted || stopReason === 'aborted';
    if (interrupted || stopReason === 'error' || stopReason === undefined) {
      if (calls.length) append({ role: 'tool', results: calls.map(call => ({
        callId: call.id, name: call.name, status: 'not-executed',
        output: '応答が中断・失敗したため実行していない',
      })) });
      return interrupted ? { outcome: 'interrupted' }
        : { outcome: 'error', errorMessage: errorMessage ?? 'モデル応答が終了イベントなしで切れた' };
    }
    if (calls.length === 0) {
      return stopReason === 'stop' ? { outcome: 'complete' }
        : { outcome: 'error', errorMessage: 'ツール終了イベントに呼び出しがない' };
    }
    let uncertain = false;
    for (const call of calls) {
      let result: ToolResult;
      const prior = ledger.get(call.id);
      const unresolved = opts.registry.get(call.name)?.readOnly ? undefined : [...ledger.values()].find(entry =>
        (!entry.result || entry.result.status === 'unknown') && opts.registry.sameOperation(entry.call, call, {
          root: opts.root, approval: opts.approval, signal: opts.signal,
        }));
      if (opts.signal.aborted) {
        result = { callId: call.id, name: call.name, status: 'not-executed', output: '中断済みのため実行していない' };
      } else if (prior) {
        result = !isDeepStrictEqual(prior.call, call)
          ? { callId: call.id, name: call.name, status: 'error', output: '[CALL_ID_CONFLICT] 同じIDで実行内容が異なる' }
          : prior.result ?? { callId: call.id, name: call.name, status: 'unknown', output: '前回の要求に結果がない。再実行せず状態を確認する' };
      } else if (uncertain) {
        result = { callId: call.id, name: call.name, status: 'not-executed', output: '先行処理が結果不明のため実行していない' };
      } else if (unresolved) {
        result = { callId: call.id, name: call.name, status: 'unknown',
          output: `前回要求(${unresolved.call.id})が結果不明で、同一操作または別操作と確認できない。新しいIDでも再送せず状態を確認する` };
      } else {
        ledger.set(call.id, { call });
        result = await opts.registry.executeOne(call, {
          root: opts.root, approval: opts.approval, signal: opts.signal,
          ...(opts.analyze ? { analyze: opts.analyze } : {}),
        });
        ledger.set(call.id, { call, result });
      }
      append({ role: 'tool', results: [result] });
      opts.hooks?.onToolResult?.(result);
      uncertain ||= result.status === 'unknown';
    }
    if (opts.signal.aborted || uncertain) return { outcome: 'interrupted' };
  }
  return { outcome: 'turn-limit', errorMessage: `ツール往復が上限(${maxTurns}回)に達した` };
}
