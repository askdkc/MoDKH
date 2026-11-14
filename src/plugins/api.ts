// Public v1 contract. Runtime input is validated by the host, not by these types.
export interface PluginManifest {
  apiVersion: 1;
  id: string;
  version: string;
  title: string;
  description: string;
  kind: 'local' | 'external';
  entry: string;
}
export interface LocalDefinition { system: string; tools: string[] }
export interface ExternalRequest { task: string; context?: string }
export interface ProcessRequest { command: string; args: string[] }
export interface ProcessResult {
  status: 'ok' | 'error' | 'unknown' | 'not-executed';
  output: string;
  cleanup: 'settled' | 'unknown';
}
export interface ExternalHost {
  readonly signal: AbortSignal;
  run(request: ProcessRequest): Promise<ProcessResult>;
}
export interface ExternalRun {
  result: Promise<{ text: string }>;
  stop(): Promise<void>;
}
export interface LocalPlugin { define(): LocalDefinition }
export interface ExternalPlugin {
  start(request: ExternalRequest, host: ExternalHost): ExternalRun | Promise<ExternalRun>;
}
export interface PluginDescriptor extends PluginManifest {
  digest: string;
  enabled: boolean;
  builtin: boolean;
}
