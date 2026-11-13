import { isDeepStrictEqual } from 'node:util';
import type { Tool, ToolCall, ToolContext, ToolResult } from '../agent/types.ts';
import { ToolError } from '../agent/types.ts';
import { listFilesTool, searchFilesTool, readFileTool } from './files.ts';
import { createFileTool, editFileTool } from './edit.ts';
import { runCommandTool } from './run.ts';

/**
 * ツール名・引数形状・宣言外の引数を検証する。
 * 各フィールドの値は個々のツールが boundary で検証する。
 */
export class ToolRegistry {
  private tools: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  specs(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Match unresolved effects conservatively. Only trusted tool code defines defaults. */
  sameOperation(a: ToolCall, b: ToolCall, ctx: ToolContext): boolean {
    if (a.name !== b.name) return false;
    const tool = this.tools.get(a.name);
    if (!tool?.operationIdentity) return isDeepStrictEqual(a.args, b.args);
    try {
      return isDeepStrictEqual(tool.operationIdentity(a.args, ctx), tool.operationIdentity(b.args, ctx));
    } catch {
      // Failure to establish a different operation cannot authorize another effect.
      return true;
    }
  }

  /**
   * モデルの要求を1件ずつ検証して実行する。
   * 未知のツール・引数不正は結果として返す(例外を握らず、モデルに観測させる)。
   * signal が abort された以降は新規実行しない(status:'not-executed')。
   */
  async executeOne(
    call: ToolCall,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const base = { callId: call.id, name: call.name };
    if (ctx.signal?.aborted) {
      return { ...base, status: 'not-executed', output: '中断済みのため実行していない' };
    }
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      return {
        ...base,
        status: 'error',
        output: `未知のツール名: ${call.name}(登録済み: ${[...this.tools.keys()].join(', ')})`,
      };
    }
    if (call.args === null || typeof call.args !== 'object' || Array.isArray(call.args)) {
      return { ...base, status: 'error', output: '引数は JSON オブジェクトで渡す' };
    }
    const properties = tool.parameters.properties;
    if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
      const unknown = Object.keys(call.args).filter(key => !Object.prototype.hasOwnProperty.call(properties, key));
      if (unknown.length) {
        return { ...base, status: 'error', output: `[INVALID_ARGS] 未知の引数: ${unknown.join(', ')}` };
      }
    }
    try {
      const output = await tool.execute(call.args as Record<string, unknown>, ctx);
      return { ...base, status: 'ok', output };
    } catch (e) {
      if (e instanceof ToolError && (e.code === 'NOT_EXECUTED' || e.code === 'DENIED')) {
        return { ...base, status: e.code === 'DENIED' ? 'error' : 'not-executed', output: `[${e.code}] ${e.message}` };
      }
      if (ctx.signal?.aborted || (e instanceof ToolError && (e.code === 'ABORTED' || e.code === 'RESULT_UNKNOWN'))) {
        return { ...base, status: 'unknown', output: `中断により結果不明: ${(e as Error).message}` };
      }
      if (e instanceof ToolError) return { ...base, status: 'error', output: `[${e.code}] ${e.message}` };
      return { ...base, status: tool.readOnly ? 'error' : 'unknown',
        output: `内部エラー(副作用の有無は未確認): ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

/** 初版が提供する5区分のツール群(作成/編集は別ツール)。 */
export function defaultTools(): Tool[] {
  return [listFilesTool, searchFilesTool, readFileTool, createFileTool, editFileTool, runCommandTool];
}
