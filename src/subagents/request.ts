import { createHash } from 'node:crypto';
import { fields, object, pluginId, text } from '../plugins/package.ts';
import type { DelegationRequest } from './types.ts';

/** Canonical field order is shared by admission and durable receipt recovery. */
export function parseDelegation(value: unknown): DelegationRequest {
  const raw = object(value);
  fields(raw, ['pluginId', 'task', 'context', 'targetPaths', 'formalInput', 'behaviorChange']);
  const request: DelegationRequest = { pluginId: pluginId(raw.pluginId), task: text(raw.task, 'task', 32768) };
  if (raw.context !== undefined) request.context = text(raw.context, 'context', 131072);
  if (raw.behaviorChange !== undefined) {
    const change = object(raw.behaviorChange);
    fields(change, ['before', 'after']);
    request.behaviorChange = {
      before: text(change.before, 'behaviorChange.before', 512).trim(),
      after: text(change.after, 'behaviorChange.after', 512).trim(),
    };
  }
  if (raw.targetPaths !== undefined) {
    if (!Array.isArray(raw.targetPaths) || raw.targetPaths.length < 1 || raw.targetPaths.length > 8 ||
        !raw.targetPaths.every(p => typeof p === 'string' && p.length < 1024 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s: string) => !s || s === '.' || s === '..')) ||
        new Set(raw.targetPaths).size !== raw.targetPaths.length) throw new Error('Invalid targetPaths: 1..8 unique relative file paths required');
    request.targetPaths = [...raw.targetPaths].sort() as string[];
  }
  if (raw.formalInput !== undefined) {
    const input = object(raw.formalInput);
    fields(input, ['path', 'config']);
    request.formalInput = { path: text(input.path, 'formalInput.path', 1024) };
    if (input.config !== undefined) request.formalInput.config = text(input.config, 'formalInput.config', 1024);
    if (request.targetPaths) throw new Error('formalInput and targetPaths are mutually exclusive');
  }
  return request;
}

export function delegationDigest(request: DelegationRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
