import type { AgentMessage, Model, ModelEvent, ModelRequest, TokenUsage } from '../../agent/types.ts';

import { toolContext } from '../context.ts';
import { harnessProfile, CODEX_62_DEFAULTS } from '../harness-profile.ts';
import { responsesReasoningEffort } from '../reasoning.ts';
import { parseImages, imageDataUrl } from '../../agent/images.ts';

export const DEFAULT_RESPONSES_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export interface ResponsesModelOptions {
  accessToken: string;
  accountId?: string;
  credentials?: (signal: AbortSignal) => Promise<{ accessToken: string; accountId?: string }>;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

/** 会話履歴(CLI 保持)を Responses API の input へ変換する。 */
export function toResponsesInput(messages: AgentMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  const outputs = toolContext(messages);
  for (const [index, m] of messages.entries()) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [
        ...(m.content ? [{ type: 'input_text', text: m.content }] : []),
        ...parseImages(m.images).map(image => ({ type: 'input_image', image_url: imageDataUrl(image), detail: 'auto' })),
      ] });
    } else if (m.role === 'assistant') {
      if (m.content.length > 0) {
        out.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      for (const c of m.toolCalls ?? []) {
        out.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.args ?? {}),
        });
      }
    } else {
      for (const [resultIndex, r] of m.results.entries()) {
        out.push({
          type: 'function_call_output',
          call_id: r.callId,
          output: JSON.stringify({ status: r.status, output: outputs.get(`${index}:${resultIndex}`) }),
        });
      }
    }
  }
  return out;
}

/**
 * ChatGPT Codex Responses アダプター(APIキー用の公開APIとは分離)。
 * 会話状態は CLI 側が保持するため store:false で毎回全履歴を送る。
 * 関数ツールは公式の名前空間契約(type:'function' のフラット形式)に合わせる。
 */
export class ResponsesApiModel implements Model {
  readonly id: string;
  private readonly accessToken: string;
  private readonly accountId?: string;
  private readonly credentials?: ResponsesModelOptions['credentials'];
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResponsesModelOptions) {
    this.accessToken = opts.accessToken;
    this.accountId = opts.accountId;
    this.credentials = opts.credentials;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_RESPONSES_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.id = `chatgpt/${opts.model}`;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // /reasoning で指定した effort を付与する。off と未知のレベルはキー自体を送らない。
    const defaults = harnessProfile(this.model) ? CODEX_62_DEFAULTS : undefined;
    const effort = responsesReasoningEffort(req.reasoning ?? defaults?.reasoning, this.model);
    const body = {
      model: this.model,
      ...(defaults ? { text: { verbosity: defaults.verbosity } } : {}),
      instructions: req.system,
      input: toResponsesInput(req.messages),
      tools: req.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      })),
      stream: true,
      store: false,
      ...(effort !== undefined ? { reasoning: { effort } } : {}),
    };
    let aborted = false;
    let errorMessage: string | undefined;
    let sawFunctionCall = false;
    let usage: TokenUsage | undefined;
    let completed = false;
    try {
      const credentials = this.credentials ? await this.credentials(signal) : { accessToken: this.accessToken, accountId: this.accountId };
      const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credentials.accessToken}`,
          ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok || res.body === null) {
        const detail = res.body === null ? '' : await res.text();
        yield { type: 'finish', stopReason: 'error', errorMessage: `Responses API エラー: ${res.status} ${detail}` };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let separator: RegExpExecArray | null;
          while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
            const rawEvent = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            const ev = parseSseData(rawEvent);
            if (ev === null) continue;
            if (ev['type'] === 'response.output_text.delta') {
              const text = ev['delta'];
              if (typeof text === 'string' && text.length > 0) {
                yield { type: 'text-delta', text };
              }
            } else if (ev['type'] === 'response.reasoning_summary_text.delta' || ev['type'] === 'response.reasoning_text.delta') {
              const text = ev['delta'];
              if (typeof text === 'string' && text.length > 0) {
                yield { type: 'activity', stage: 'reasoning' };
                yield { type: 'reasoning-delta', text };
              }
            } else if (ev['type'] === 'response.output_item.done') {
              const item = ev['item'] as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
              if (item?.type === 'function_call' && item.call_id && item.name) {
                sawFunctionCall = true;
                const args: unknown = JSON.parse(item.arguments ?? '{}');
                if (args === null || typeof args !== 'object' || Array.isArray(args)) {
                  throw new Error('ツール引数はJSONオブジェクトである必要がある');
                }
                yield { type: 'tool-call', call: { id: item.call_id, name: item.name, args: args as Record<string, unknown> } };
              }
            } else if (ev['type'] === 'response.completed') {
              completed = true;
              // Codex reports cached tokens in a nested detail object; missing values stay undefined.
              const reported = ev['response'] as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } | undefined;
              const tokens = reported?.usage;
              if (tokens) {
                const cached = tokens.input_tokens_details?.cached_tokens;
                usage = {
                  input: tokens.input_tokens,
                  uncachedInput: tokens.input_tokens !== undefined && cached !== undefined
                    ? tokens.input_tokens - cached : undefined,
                  output: tokens.output_tokens,
                  cacheRead: cached,
                };
              }
            } else if (ev['type'] === 'response.failed') {
              const response = ev['response'] as { error?: unknown } | null;
              errorMessage = describeFailure(response?.error) ?? errorMessage ?? 'Responses API 応答は未完了: response.failed';
            } else if (ev['type'] === 'response.incomplete') {
              errorMessage = `Responses API 応答は未完了: ${ev['type']}`;
            } else if (ev['type'] === 'error') {
              errorMessage = String(ev['message'] ?? 'Responses API のエラーイベント');
            }
          }
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      aborted = signal.aborted;
    } catch (e) {
      aborted = signal.aborted;
      if (!aborted) errorMessage = (e as Error).message;
    }
    if (usage && (usage.input !== undefined || usage.output !== undefined)) yield { type: 'usage', ...usage };
    if (aborted) {
      yield { type: 'finish', stopReason: 'aborted' };
    } else if (errorMessage !== undefined || !completed) {
      yield { type: 'finish', stopReason: 'error', errorMessage: errorMessage ?? 'Responses API の完了イベントがない' };
    } else {
      yield { type: 'finish', stopReason: sawFunctionCall ? 'tool-calls' : 'stop' };
    }
  }
}

function describeFailure(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code, type, message, headers } = error as Record<string, unknown>;
  const identifier = typeof code === 'string' && code.trim() ? code : type;
  const details = [identifier, message].filter(value => typeof value === 'string' && value.trim());
  const wait = retryWait(headers);
  if (wait) details.push(`${wait}後に再試行してください。`);
  return details.length ? `Responses API エラー: ${details.join(' ')}` : undefined;
}

function retryWait(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const fields = Object.entries(headers);
  for (const [name, divisor] of [['retry-after-ms', 1000], ['retry-after', 1]] as const) {
    const raw = fields.find(([key]) => key.toLowerCase() === name)?.[1];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const value = String(raw).trim();
    if (!/^\d+(?:\.\d+)?$/.test(value)) continue;
    const seconds = Math.ceil(Number(value) / divisor);
    if (!Number.isSafeInteger(seconds)) continue;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return (minutes ? `${minutes}分` : '') + (remainder || !minutes ? `${remainder}秒` : '');
  }
  return undefined;
}

function parseSseData(raw: string): Record<string, unknown> | null {
  const lines = raw.split('\n').filter((l) => l.startsWith('data:'));
  if (lines.length === 0) return null;
  const payload = lines.map((l) => l.slice(5).trim()).join('');
  if (payload.length === 0 || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new Error('Responses API のSSE JSONが壊れている');
  }
}
