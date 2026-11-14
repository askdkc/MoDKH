import { createHash } from 'node:crypto';
import { fields, object, pluginId, text } from '../plugins/package.ts';
import type { DelegationRequest } from './types.ts';

/** Canonical field order is shared by admission and durable receipt recovery. */
export function parseDelegation(value: unknown): DelegationRequest {
  const raw = object(value);
  fields(raw, ['pluginId', 'task', 'context']);
  const request: DelegationRequest = { pluginId: pluginId(raw.pluginId), task: text(raw.task, 'task', 32768) };
  if (raw.context !== undefined) request.context = text(raw.context, 'context', 131072);
  return request;
}

export function delegationDigest(request: DelegationRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
