import { createHash } from 'node:crypto';
import { fields, object, pluginId, text } from '../plugins/package.ts';
import type { DelegationRequest } from './types.ts';

/** Canonical field order is shared by admission and durable receipt recovery. */
export function parseDelegation(value: unknown): DelegationRequest {
  const raw = object(value);
  fields(raw, ['pluginId', 'task', 'context', 'targetPaths']);
  const request: DelegationRequest = { pluginId: pluginId(raw.pluginId), task: text(raw.task, 'task', 32768) };
  if (raw.context !== undefined) request.context = text(raw.context, 'context', 131072);
  if (raw.targetPaths !== undefined) {
    if (!Array.isArray(raw.targetPaths) || raw.targetPaths.length < 1 || raw.targetPaths.length > 8 ||
        !raw.targetPaths.every(p => typeof p === 'string' && p.length < 1024 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s: string) => !s || s === '.' || s === '..')) ||
        new Set(raw.targetPaths).size !== raw.targetPaths.length) throw new Error('Invalid targetPaths: 1..8 unique relative file paths required');
    request.targetPaths = [...raw.targetPaths].sort() as string[];
  }
  return request;
}

export function delegationDigest(request: DelegationRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
