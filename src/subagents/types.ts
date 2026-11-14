export interface DelegationRequest { pluginId: string; task: string; context?: string }
export interface SubagentResult {
  agentId: string;
  runId: string;
  status: 'completed' | 'error' | 'cancelled' | 'unknown';
  text: string;
  cleanup: 'settled' | 'unknown';
  diagnostic?: string;
}
export interface DelegationRecord {
  runId: string;
  childSessionId: string;
  parentSessionId: string;
  rootSessionId: string;
  callId: string;
  requestDigest: string;
  operationDigest: string;
  pluginId: string;
  pluginVersion: string;
  pluginDigest: string;
  apiVersion: 1;
  model: string;
  root: string;
  /** Parent/user permission ceiling captured before importing the plugin. */
  tools: string[];
  /** Effective local tool intersection, captured before the model executes. */
  effectiveTools?: string[];
  state: 'starting' | 'running' | 'stopping' | 'finished';
  result?: SubagentResult;
}
export interface SubagentHandle {
  readonly agentId: string;
  readonly runId: string;
  readonly result: Promise<SubagentResult>;
  cancel(reason: string): Promise<void>;
}
