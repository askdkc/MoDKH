import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelBaseUrl, parseModelRef } from './factory.ts';

interface ModelMetadata {
  id?: string;
  slug?: string;
  name?: string;
  model?: string;
  context_length?: unknown;
  context_window?: unknown;
  max_model_len?: unknown;
  loaded_instances?: { id: string; config?: { context_length?: unknown } }[];
}
interface ModelCatalog {
  models?: ModelMetadata[];
  data?: ModelMetadata[];
  max_input_tokens?: unknown;
  inputTokenLimit?: unknown;
}


export function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Resolve the selected deployment only. Some providers omit limits from their model metadata. */
export async function readContextWindow(ref: string, override: string | undefined, key: string | undefined,
  signal: AbortSignal): Promise<number | undefined> {
  const { provider, model } = parseModelRef(ref);
  const base = modelBaseUrl(provider, override)?.replace(/\/$/, '');
  const headers: Record<string, string> = {};
  try {
    if (provider === 'chatgpt' && !base) {
      const directory = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
      const catalog: ModelCatalog = JSON.parse(await readFile(path.join(directory, 'models_cache.json'), 'utf8'));
      return positiveTokenCount(catalog.models?.find(entry => entry?.slug === model)?.context_window);
    }
    let url: string;
    if (provider === 'google') {
      url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model.replace(/^models\//, ''));
      if (key) headers['x-goog-api-key'] = key;
    } else if (provider === 'anthropic') {
      url = (!base || base === 'https://api.anthropic.com' ? 'https://api.anthropic.com/v1' : base) + '/models/' + encodeURIComponent(model);
      headers['anthropic-version'] = '2023-06-01';
      if (key) headers['x-api-key'] = key;
    } else if ((provider === 'ollama' || provider === 'lmstudio') && base?.endsWith('/v1')) {
      url = base.slice(0, -3) + (provider === 'ollama' ? '/api/ps' : '/api/v1/models');
      if (key) headers.Authorization = 'Bearer ' + key;
    } else {
      if (!base) return undefined;
      url = base + '/models';
      if (key) headers.Authorization = 'Bearer ' + key;
    }
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    if (!response.ok) return undefined;
    const body = await response.json() as ModelCatalog;
    if (provider === 'google') return positiveTokenCount(body.inputTokenLimit);
    if (provider === 'anthropic') return positiveTokenCount(body.max_input_tokens);
    if (provider === 'ollama' && url.endsWith('/api/ps')) {
      return positiveTokenCount(body.models?.find(entry =>
        [model, model.includes(':') ? model : model + ':latest'].includes(entry?.model ?? entry?.name ?? ''))?.context_length);
    }
    if (provider === 'lmstudio' && url.endsWith('/api/v1/models')) {
      const instance = body.models?.flatMap(entry => entry.loaded_instances ?? []).find(entry => entry.id === model);
      return positiveTokenCount(instance?.config?.context_length);
    }
    const entry = body.data?.find(item => item?.id === model);
    return positiveTokenCount(entry?.context_length ?? entry?.context_window ?? entry?.max_model_len);
  } catch {
    return undefined;
  }
}
