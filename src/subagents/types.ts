export interface DelegationRequest {
  pluginId: string;
  task: string;
  context?: string;
  behaviorChange?: { before: string; after: string };
  targetPaths?: string[];
  formalInput?: { path: string; config?: string };
}
export interface HeadAssignment {
  task: string;
  targets: string[];
  completion: { condition: string; evidence: string };
  userRequest?: string;
  behaviorChange?: NonNullable<DelegationRequest['behaviorChange']>;
}
export interface SubagentResult {
  agentId: string;
  runId: string;
  status: 'completed' | 'error' | 'cancelled' | 'unknown';
  text: string;
  cleanup: 'settled' | 'unknown';
  diagnostic?: string;
  code?: 'EDIT_TURN_LIMIT';
  verification?: import('./verification.ts').Verification;
  formalEvidence?: unknown[];
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
  assignment?: HeadAssignment;
  state: 'starting' | 'running' | 'stopping' | 'finished';
  result?: SubagentResult;
}
export interface SubagentHandle {
  readonly agentId: string;
  readonly runId: string;
  readonly result: Promise<SubagentResult>;
  cancel(reason: string): Promise<void>;
}
