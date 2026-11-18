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
import { toolContext } from './context.ts';
import { harnessProfile, CODEX_62_DEFAULTS } from './harness-profile.ts';
import { reasoningProviderOptions } from './reasoning.ts';
import { parseImage, parseImages } from '../agent/images.ts';
import type { Model, ModelEvent, ModelRequest, TokenUsage, ToolSpec } from '../agent/types.ts';

export interface AiSdkModelOptions {
  id: string;
  languageModel: LanguageModel;
  /** 無通信タイムアウト: 受信が続く限り延びる。既定600秒。 */
  timeoutMs?: number;
  /**
   * providerOptions のキー確定用プロバイダー名。未指定なら推論オプションを送らない
   * (既存の呼び出し元の挙動を変えない)。
   */
  provider?: string;
}

function toCoreMessages(req: ModelRequest): ModelMessage[] {
  const out: ModelMessage[] = [];
  // Chat Completions accepts images in user content. Keep each tool batch contiguous
  // and attach its observations only after all matching tool receipts.
  const observations: Extract<ModelMessage, { role: 'user' }>[] = [];
  const outputs = toolContext(req.messages);
  for (const [index, m] of req.messages.entries()) {
    if (m.role === 'user') {
      const images = parseImages(m.images);
      out.push({ role: 'user', content: images.length ? [
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...images.map(image => ({ type: 'file' as const, data: Buffer.from(image.data, 'base64'), mediaType: image.mediaType })),
      ] : m.content });
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
      const parts: ToolResultPart[] = m.results.map((r, resultIndex) => ({
        type: 'tool-result',
        toolCallId: r.callId,
        toolName: r.name,
        output: { type: 'text', value: JSON.stringify({ status: r.status, output: outputs.get(`${index}:${resultIndex}`) }) },
      }));
      out.push({ role: 'tool', content: parts });
      for (const result of m.results) {
        if (!result.image) continue;
        const image = parseImage(result.image);
        observations.push({ role: 'user', content: [
          { type: 'text', text: `Image returned by tool call ${JSON.stringify(result.callId)} (observation).` },
          { type: 'file', data: Buffer.from(image.data, 'base64'), mediaType: image.mediaType },
        ] });
      }
      if (req.messages[index + 1]?.role !== 'tool') out.push(...observations.splice(0));
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
  private readonly timeoutMs: number;
  private readonly provider?: string;

  constructor(opts: AiSdkModelOptions) {
    this.id = opts.id;
    this.lm = opts.languageModel;
    this.provider = opts.provider;
    this.timeoutMs = opts.timeoutMs ?? 600000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  }

  /** 無通信タイムアウト。受信が続く限り延期され、何も来なければ締め切る。 */
  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let aborted = false;
    let timedOut = false;
    const deadline = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; deadline.abort(); }, this.timeoutMs); };
    arm();
    const requestSignal = AbortSignal.any([signal, deadline.signal]);
    let activity: 'reasoning' | 'tool-input' | undefined;
    let usage: TokenUsage | undefined;
    let errorMessage: string | undefined;
    let sawToolCall = false;
    let finishReason: 'stop' | 'tool-calls' | 'length' | undefined;
    const defaults = harnessProfile(this.id) ? CODEX_62_DEFAULTS : undefined;
    const reasoning = reasoningProviderOptions(this.provider ?? '', req.reasoning ?? defaults?.reasoning, this.id);
    // Only native OpenAI Responses is known to support text.verbosity.
    const providerOptions = defaults && this.provider === 'openai'
      ? { openai: { ...reasoning?.openai as object, textVerbosity: defaults.verbosity } } : reasoning;
    const thinking = this.provider === 'anthropic' && reasoning?.anthropic !== undefined;
    const thinkingBudget = thinking
      ? (reasoning!.anthropic as { thinking: { budgetTokens?: number } }).thinking.budgetTokens : undefined;
    try {
      const result = streamText({
        model: this.lm,
        messages: toCoreMessages(req),
        system: req.system,
        tools: toAiSdkTools(req.tools),
        abortSignal: requestSignal,
        // fullStream below owns errors; the SDK default logs entire request bodies to stderr.
        onError: () => {},
        maxRetries: 0, // A transport failure does not establish that the request was unsent.
        // providerOptions の実値はすべて JSON オブジェクト。SDK型は index signature が緩いため型の詰め替え。
        ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
        ...(thinking ? { maxOutputTokens: (thinkingBudget ?? 0) + 8192 } : {}),
      });
      for await (const part of result.fullStream) {
        arm(); // 受信が継続している間は制限時間を延ばす
        if (part.type === 'reasoning-start' || part.type === 'reasoning-delta') {
          if (activity !== 'reasoning') { activity = 'reasoning'; yield { type: 'activity', stage: activity }; }
          if (part.type === 'reasoning-delta' && part.text.length > 0) yield { type: 'reasoning-delta', text: part.text };
        } else if (part.type === 'tool-input-start') {
          activity = 'tool-input';
          yield { type: 'activity', stage: activity, toolName: part.toolName };
        } else if (part.type === 'text-delta') {
          activity = undefined;
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
          // totalUsage is the provider's own count; undefined means unreported, not zero.
          if (part.totalUsage) {
            usage = {
              input: part.totalUsage.inputTokens,
              uncachedInput: part.totalUsage.inputTokenDetails?.noCacheTokens,
              output: part.totalUsage.outputTokens,
              cacheRead: part.totalUsage.inputTokenDetails?.cacheReadTokens,
              cacheWrite: part.totalUsage.inputTokenDetails?.cacheWriteTokens,
            };
          }
          if (part.finishReason === 'stop' || part.finishReason === 'tool-calls' || part.finishReason === 'length') {
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
    } finally { clearTimeout(timer); }
    if (timedOut && !signal.aborted) errorMessage = `モデル応答が制限時間（${this.timeoutMs}ms）を超えるまで何も受信しませんでした。自動再送はしません。`;
    if (usage && (usage.input !== undefined || usage.output !== undefined)) yield { type: 'usage', ...usage };
    if (aborted) {
      yield { type: 'finish', stopReason: 'aborted' };
    } else if (errorMessage !== undefined || finishReason === undefined ||
      (finishReason !== 'length' && (finishReason === 'tool-calls') !== sawToolCall)) {
      yield { type: 'finish', stopReason: 'error', errorMessage: errorMessage ?? 'モデル終了イベントがない、またはツール要求と終了理由が不整合' };
    } else {
      yield { type: 'finish', stopReason: finishReason };
    }
  }
}
