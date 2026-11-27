import { isConnectionLoss } from './reconnect.ts';
import {
  APICallError,
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
import { parsePdfs } from '../agent/documents.ts';
import { isContextLimitError, toolContext } from './context.ts';
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
  /** Selected by the factory for a local endpoint with a known wire contract. */
  replayChatReasoning?: boolean;
}

/** A capability rejection is safe to recover from. A bad image, an oversized request or a transport error is not. */
function rejectsImageInput(error: unknown): boolean {
  if (!APICallError.isInstance(error) || (error.statusCode !== 400 && error.statusCode !== 422)) return false;
  return /\b(?:does not|doesn't|cannot|can't) (?:support|accept|read|process) (?:images?|image inputs?|multimodal (?:requests?|inputs?))(?: yet)?\s*(?:[.,;:!]|$)/i.test(error.message)
    || /\b(?:images|image input|multimodal (?:requests|input)) (?:is|are) (?:not supported|unsupported)(?: (?:by|for) this model)?\s*(?:[.,;:!]|$)/i.test(error.message);
}

function toCoreMessages(req: ModelRequest, replayChatReasoning: boolean, omitToolImages: boolean): ModelMessage[] {
  const out: ModelMessage[] = [];
  // Chat Completions accepts images in user content. Keep each tool batch contiguous
  // and attach its observations only after all matching tool receipts.
  const observations: Extract<ModelMessage, { role: 'user' }>[] = [];
  const outputs = toolContext(req.messages);
  for (const [index, m] of req.messages.entries()) {
    if (m.role === 'user') {
      const images = parseImages(m.images);
      const pdfs = parsePdfs(m.pdfs);
      out.push({ role: 'user', content: images.length || pdfs.length ? [
        ...pdfs.map(pdf => ({ type: 'file' as const, filename: pdf.filename, data: Buffer.from(pdf.data, 'base64'), mediaType: 'application/pdf' })),
        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
        ...images.map(image => ({ type: 'file' as const, data: Buffer.from(image.data, 'base64'), mediaType: image.mediaType })),
      ] : m.content });
    } else if (m.role === 'assistant') {
      const content: AssistantContent = [];
      const continuation = replayChatReasoning ? req.continuation?.(m) : undefined;
      if (continuation?.kind === 'chat-reasoning') content.push({ type: 'reasoning', text: continuation.text });
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
        if (omitToolImages) {
          observations.push({ role: 'user', content: 'The image from tool call ' + JSON.stringify(result.callId)
            + ' was not inspected because this model rejected image input. Use the recorded text results and perform only outstanding work. '
            + 'Report the saved path and leave visual details unverified.' });
          continue;
        }
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
  private toolImagesUnsupported = false;
  private readonly lm: LanguageModel;
  private readonly timeoutMs: number;
  private readonly provider?: string;
  private readonly replayChatReasoning: boolean;

  constructor(opts: AiSdkModelOptions) {
    this.id = opts.id;
    this.lm = opts.languageModel;
    this.provider = opts.provider;
    this.replayChatReasoning = opts.provider === 'deepseek' || opts.replayChatReasoning === true;
    this.timeoutMs = opts.timeoutMs ?? 600000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  }

  /** 無通信タイムアウト。受信が続く限り延期され、何も来なければ締め切る。 */
  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const replaysPrivate = this.replayChatReasoning && req.messages.some(m => req.continuation?.(m)?.kind === 'chat-reasoning');
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
    let connectionLost = false;
    let rejectedToolHistory = false;
    let rejectedImageInput = false;
    let responseStarted = false;
    const omitToolImages = this.toolImagesUnsupported;
    let sawToolCall = false;
    const privateReasoning: string[] = [];
    let finishReason: 'stop' | 'tool-calls' | 'length' | undefined;
    const defaults = harnessProfile(this.id) ? CODEX_62_DEFAULTS : undefined;
    const reasoning = reasoningProviderOptions(this.provider ?? '', req.reasoning ?? defaults?.reasoning, this.id);
    // Only native OpenAI Responses is known to support text.verbosity.
    const providerOptions = this.provider === 'openai' && (defaults || req.promptCacheKey !== undefined)
      ? { openai: {
        ...reasoning?.openai as object,
        ...(defaults ? { textVerbosity: defaults.verbosity } : {}),
        ...(req.promptCacheKey !== undefined ? { promptCacheKey: req.promptCacheKey } : {}),
      } } : reasoning;
    const thinking = this.provider === 'anthropic' && reasoning?.anthropic !== undefined;
    const thinkingBudget = thinking
      ? (reasoning!.anthropic as { thinking: { budgetTokens?: number } }).thinking.budgetTokens : undefined;
    try {
      const result = streamText({
        model: this.lm,
        messages: toCoreMessages(req, this.replayChatReasoning, omitToolImages),
        system: req.system,
        tools: toAiSdkTools(omitToolImages ? req.tools.filter(t => t.name !== 'view_image') : req.tools),
        abortSignal: requestSignal,
        // fullStream below owns errors; the SDK default logs entire request bodies to stderr.
        onError: () => {},
        maxRetries: 0, // The agent loop owns reconnects and discards partial tool calls.
        // providerOptions の実値はすべて JSON オブジェクト。SDK型は index signature が緩いため型の詰め替え。
        ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
        ...(thinking ? { maxOutputTokens: (thinkingBudget ?? 0) + 8192 } : {}),
      });
      for await (const part of result.fullStream) {
        arm(); // 受信が継続している間は制限時間を延ばす
        if (part.type === 'start-step') {
          responseStarted = true;
        } else if (part.type === 'reasoning-start' || part.type === 'reasoning-delta') {
          if (activity !== 'reasoning') { activity = 'reasoning'; yield { type: 'activity', stage: activity }; }
          if (part.type === 'reasoning-delta' && part.text.length > 0) {
            if (req.continuation && this.replayChatReasoning) privateReasoning.push(part.text);
            yield { type: 'reasoning-delta', text: part.text };
          }
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
          } else if (!isContextLimitError(errorMessage)) {
            errorMessage = `モデル応答は未完了: ${part.finishReason}`;
          }
        } else if (part.type === 'error') {
          connectionLost ||= isConnectionLoss(part.error);
          rejectedImageInput = rejectsImageInput(part.error);
          rejectedToolHistory = APICallError.isInstance(part.error) && part.error.statusCode === 500
            && part.error.message === 'no user query found in messages';
          errorMessage = (part.error as Error)?.message ?? String(part.error);
        }
      }
      aborted = signal.aborted;
    } catch (e) {
      aborted = signal.aborted;
      if (!aborted) {
        connectionLost ||= isConnectionLoss(e);
        rejectedImageInput = rejectsImageInput(e);
        errorMessage = (e as Error).message;
      }
    } finally { clearTimeout(timer); }
    if (timedOut && !signal.aborted) errorMessage = `モデル応答が制限時間（${this.timeoutMs}ms）を超えるまで何も受信しませんでした。自動再送はしません。`;
    if (usage && (usage.input !== undefined || usage.output !== undefined)) yield { type: 'usage', ...usage };
    if (aborted) {
      yield { type: 'finish', stopReason: 'aborted' };
    } else if (rejectedImageInput && !timedOut && !responseStarted && !omitToolImages
      && !req.messages.some(m => m.role === 'user' && (m.images?.length || m.pdfs?.length))
      && req.messages.some(m => m.role === 'tool' && m.results.some(r => r.image))) {
      this.toolImagesUnsupported = true;
      if (req.continueAfterImageRejection) {
        yield { type: 'activity', stage: 'tool-images-unavailable' };
        if (signal.aborted) yield { type: 'finish', stopReason: 'aborted' };
        else yield* this.stream(req, signal);
        return;
      }
      const report = yield* this.reportRejectedTurn(req, signal, 'Answer the original request using the text results already obtained. '
        + 'State that the tool image could not be inspected and give its saved path if available. Do not infer visual details.');
      if (signal.aborted) yield { type: 'finish', stopReason: 'aborted' };
      else if (report) {
        yield { type: 'text-delta', text: report };
        yield { type: 'finish', stopReason: 'stop' };
      } else yield { type: 'finish', stopReason: 'error', errorMessage: '画像入力が拒否され、テキスト結果からも回答を取得できませんでした。' };
    } else if (rejectedToolHistory && !timedOut && this.provider === 'ollama'
      && req.messages.at(-1)?.role === 'tool' && req.messages.some(m => m.role === 'user' && m.content.trim())) {
      if (req.recoverToolHistory) {
        yield { type: 'finish', stopReason: 'error', errorMessage, rejectedToolHistory: true };
        return;
      }
      // The endpoint rejected the continuation before streaming. Ask for a report only.
      // The added prompt exists exclusively on the wire and cannot trigger a tool.
      const report = yield* this.reportRejectedTurn(req, signal);
      if (signal.aborted) yield { type: 'finish', stopReason: 'aborted' };
      else yield { type: 'finish', stopReason: 'error', errorMessage:
        'Ollama がツール結果を含む履歴を拒否しました (no user query found in messages)。'
        + (report ? '\n' + report : '') };
    } else if (errorMessage !== undefined || finishReason === undefined ||
      (finishReason !== 'length' && (finishReason === 'tool-calls') !== sawToolCall)) {
      if (replaysPrivate) errorMessage = isContextLimitError(errorMessage) ? 'context_length_exceeded' : 'モデルの継続応答が未完了です (詳細非表示)';
      yield { type: 'finish', stopReason: 'error', ...(connectionLost && !timedOut ? { connectionLost: true } : {}), errorMessage: errorMessage ?? 'モデル終了イベントがない、またはツール要求と終了理由が不整合' };
    } else {
      if (finishReason !== 'length' && privateReasoning.length) {
        yield { type: 'continuation', value: { kind: 'chat-reasoning', text: privateReasoning.join('') } };
      }
      yield { type: 'finish', stopReason: finishReason };
    }
  }

  private async *reportRejectedTurn(req: ModelRequest, signal: AbortSignal,
    instruction = 'Summarize the results already obtained and what remains incomplete. Use the language of the original request. Do not request tools.',
  ): AsyncGenerator<ModelEvent, string> {
    const messages: ModelRequest['messages'] = [...req.messages, { role: 'user', content: instruction }];
    let report = '';
    for await (const event of this.stream({ ...req, messages, tools: [] }, signal)) {
      if (event.type === 'usage') yield event;
      if (event.type === 'text-delta') report += event.text;
      if (event.type === 'tool-call') return '';
      if (event.type === 'finish' && event.stopReason === 'stop') return report.trim();
    }
    return '';
  }
}
