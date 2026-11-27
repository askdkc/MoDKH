import { setTimeout as wait } from 'node:timers/promises';
import type { Model, ModelEvent, ModelRequest } from '../agent/types.ts';

const networkCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENETDOWN',
  'ENETRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

export function isConnectionLoss(error: unknown): boolean {
  const seen = new Set<object>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if ('statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 300) return false;
    if ('code' in error && typeof error.code === 'string' && networkCodes.has(error.code)) return true;
    if (!error.cause && error instanceof TypeError && error.message === 'fetch failed') return true;
    error = error.cause;
  }
  return false;
}

export async function* streamWithReconnect(model: Model, request: ModelRequest, signal: AbortSignal,
  onRetry: (delayMs: number) => void, onAttempt: () => void): AsyncGenerator<ModelEvent> {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 0; !signal.aborted; attempt++) {
    onAttempt();
    let retry = false;
    for await (const event of model.stream(request, signal)) {
      if (event.type === 'finish' && event.stopReason === 'error' && event.connectionLost && attempt < delays.length) {
        retry = true;
        break;
      }
      yield event;
    }
    if (!retry || signal.aborted) break;
    onRetry(delays[attempt]);
    try { await wait(delays[attempt], undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
