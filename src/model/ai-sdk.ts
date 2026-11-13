import {
  streamText,
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
  type AssistantContent,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import type { AgentMessage, Model, ModelEvent, ModelRequest, ToolSpec } from '../agent/types.ts';

export interface AiSdkModelOptions {
  id: string;
  languageModel: LanguageModel;
}

function toCoreMessages(req: ModelRequest): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const content: AssistantContent = [];
      if (m.content.length > 0) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        const part: ToolCallPart = {
          type: 'tool-call',
          toolCallId: c.id,
          toolName: c.name,
          input: c.args,
        };
        content.push(part);
      }
      out.push({ role: 'assistant', content });
    } else {
      const parts: ToolResultPart[] = m.results.map((r) => ({
        type: 'tool-result',
        toolCallId: r.callId,
        toolName: r.name,
        output: { type: 'text', value: JSON.stringify({ status: r.status, output: r.output }) },
      }));
      out.push({ role: 'tool', content: parts });
    }
  }
  return out;
}

/** モデルへ渡すツール定義。execute は持たせず、実行は CLI 側で承認付きで行う。 */
function toAiSdkTools(specs: ToolSpec[]): ToolSet {
  const out: ToolSet = {};
  for (const s of specs) {
    out[s.name] = tool({
      description: s.description,
      inputSchema: jsonSchema<Record<string, unknown>>(s.parameters as never),
    });
  }
  return out;
}

/**
 * AI SDK (Vercel AI SDK) 経由の Model 実装。1回の stream() は1ステップ
 * (テキスト+ツール要求まで)。ツール実行と次ステップは Agent ループが担う。
 * 中断は abortSignal で伝え、'aborted' で静かに終わる。
 */
export class AiSdkModel implements Model {
  readonly id: string;
  private readonly lm: LanguageModel;

  constructor(opts: AiSdkModelOptions) {
    this.id = opts.id;
    this.lm = opts.languageModel;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let aborted = false;
    let errorMessage: string | undefined;
    let sawToolCall = false;
    let finishReason: 'stop' | 'tool-calls' | undefined;
    try {
      const result = streamText({
        model: this.lm,
        messages: toCoreMessages(req),
        system: req.system,
        tools: toAiSdkTools(req.tools),
        abortSignal: signal,
        maxRetries: 0, // A transport failure does not establish that the request was unsent.
      });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          yield { type: 'text-delta', text: part.text };
        } else if (part.type === 'tool-call') {
          sawToolCall = true;
          yield {
            type: 'tool-call',
            call: {
              id: part.toolCallId,
              name: part.toolName,
              args: (part.input ?? {}) as Record<string, unknown>,
            },
          };
        } else if (part.type === 'finish') {
          if (part.finishReason === 'stop' || part.finishReason === 'tool-calls') {
            finishReason = part.finishReason;
          } else {
            errorMessage = `モデル応答は未完了: ${part.finishReason}`;
          }
        } else if (part.type === 'error') {
          errorMessage = (part.error as Error)?.message ?? String(part.error);
        }
      }
      aborted = signal.aborted;
    } catch (e) {
      aborted = signal.aborted;
      if (!aborted) errorMessage = (e as Error).message;
    }
    if (aborted) {
      yield { type: 'finish', stopReason: 'aborted' };
    } else if (errorMessage !== undefined || finishReason === undefined || (finishReason === 'tool-calls') !== sawToolCall) {
      yield { type: 'finish', stopReason: 'error', errorMessage: errorMessage ?? 'モデル終了イベントがない、またはツール要求と終了理由が不整合' };
    } else {
      yield { type: 'finish', stopReason: finishReason };
    }
  }
}
