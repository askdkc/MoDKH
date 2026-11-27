import { clip } from './compaction.ts';
import type { AgentMessage, Model, ModelEvent, ModelRequest, ToolCall } from './types.ts';
import { isUserRequest } from './types.ts';
import { isContextLimitError } from '../model/context.ts';

export function lastRequestIndex(messages: AgentMessage[]): number {
  return messages.findLastIndex(isUserRequest);
}

function excerpt(text: string, budget: number): string {
  // Shell environments and echoed command lines are not report evidence.
  const clean = text.split('\n').filter(line => !/^\s*(?:\$\s|[A-Z][A-Z0-9_]*=)/u.test(line)
    && !/\b(?:authorization|proxy-authorization|set-cookie|cookie|api[_-]?key|access[_-]?token|password|secret)\s*[:=]/iu.test(line));
  const body = clean.join('\n').trim();
  if (Buffer.byteLength(body) <= budget) return body;
  const diagnostic = clean.find(line => /\[(?:critical|fatal|error)\]/iu.test(line));
  return diagnostic ? clip(body, Math.floor(budget * 0.7)) + '\n' + clip(diagnostic.trim(), Math.floor(budget * 0.3))
    : clip(body, budget);
}

/** Arguments, reasoning and unbounded output stay in the journal. Keep evidence tied to its receipt. */
export function savedResults(messages: AgentMessage[], start: number) {
  const past = messages.slice(0, start).filter(isUserRequest);
  const earlier = past.length > 4 ? [past[0], ...past.slice(-3)] : past;
  const current = messages.slice(start).filter(isUserRequest);
  const taskMessages = [...earlier, ...current];
  const prior = earlier.map(m => clip(m.content, 1200)).join('\n\n');
  const active = current.map(m => clip(m.content, 3000)).join('\n\n');
  const requests = (prior ? 'Earlier requests, for context:\n' + clip(prior, 2600) + '\n\n' : '')
    + 'Active request and updates:\n' + clip(active, prior ? 3100 : 5900);
  const owners = new Map<string, ToolCall>();
  const observations = new Map<string, number>();
  const writtenFiles = new Set<string>();
  const deniedFiles = new Set<string>();
  let imagePair: AgentMessage[] = [];
  // Previous steps can contain the data for a short follow-up such as "finish the report".
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) owners.set(call.id, call);
    } else if (message.role === 'tool') {
      for (const r of message.results) {
        const call = owners.get(r.callId);
        const file = typeof call?.args.path === 'string' ? clip(call.args.path, 240) : '';
        if (file && call?.name === r.name && (r.name === 'create_file' || r.name === 'edit_file')) {
          if (r.status === 'ok') { writtenFiles.add(file); deniedFiles.delete(file); }
          else if (index >= start && (r.status === 'unknown' || /\bDENIED\b|承認されなかった/u.test(r.output))) deniedFiles.add(file);
        }
        const receipt = [r.name, file, '[' + r.status + ']', excerpt(r.output, 1350)].filter(Boolean).join(' ');
        observations.set(receipt, (observations.get(receipt) ?? 0) + 1);
        if (r.image && r.status === 'ok' && call?.name === 'view_image') {
          imagePair = [{ role: 'assistant', content: '', toolCalls: [{ id: call.id, name: call.name, args: { path: file } }] },
            { role: 'tool', results: [{ ...r, output: file }] }];
        }
      }
    } else if (!isUserRequest(message)) {
      const receipt = excerpt(message.content, 1200);
      observations.set(receipt, (observations.get(receipt) ?? 0) + 1);
    }
  }
  const entries = Array.from(observations, ([receipt, count]) => count > 1 ? `${receipt} (×${count})` : receipt);
  const images = current.findLast(m => m.images?.length)?.images;
  return { requests, taskMessages, writtenFiles, deniedFiles, images, imagePair, observations: clip(entries.join('\n\n'), 22_000) };
}

/** Every retry changes a bounded condition. Requests in this phase have no executable tools. */
export async function savedText(model: Model, build: (small: boolean, omitImages: boolean) => ModelRequest,
  signal: AbortSignal, notify: (event: ModelEvent) => void): Promise<string> {
  let small = false, omitImages = false, retriedHeaders = false;
  for (;;) {
    signal.throwIfAborted();
    const request = build(small, omitImages);
    let text = '';
    let receivedReasoning = false;
    let finish: Extract<ModelEvent, { type: 'finish' }> | undefined;
    try {
      for await (const event of model.stream(request, signal)) {
        signal.throwIfAborted();
        if (event.type === 'tool-call') throw new Error('保存済み結果からの執筆中にツール要求を受信したため、実行せず終了しました');
        if (event.type === 'text-delta') {
          text += event.text;
          if (text.length > 250_000) throw new Error('レポートが出力上限を超えました');
        } else if (event.type === 'finish') { finish = event; break; }
        else {
          receivedReasoning ||= event.type === 'reasoning-delta';
          notify(event);
        }
      }
      signal.throwIfAborted();
      if (finish?.stopReason === 'stop' && text.trim()) return text.trim();
      if (!small && (finish?.stopReason === 'length' || finish?.stopReason === 'stop')) { small = true; continue; }
      throw new Error(finish?.errorMessage ?? `モデルの執筆結果が未完了です (${finish?.stopReason ?? 'stream ended'})`);
    } catch (error) {
      if (signal.aborted) throw error;
      const diagnostic = (error as Error).message;
      if (!retriedHeaders && !text && !receivedReasoning && /\b(?:Headers Timeout Error|UND_ERR_HEADERS_TIMEOUT)\b/iu.test(diagnostic)) {
        retriedHeaders = true;
        continue;
      }
      if (!isContextLimitError(diagnostic)) throw error;
      if (!small) { small = true; continue; }
      if (omitImages || !request.messages.some(m => m.role === 'user' ? m.images?.length : m.role === 'tool' && m.results.some(r => r.image))) throw error;
      omitImages = true;
    }
  }
}
