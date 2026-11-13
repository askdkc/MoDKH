import { McpStdioClient, McpRequestError, type McpOptions } from './mcp.ts';

export interface MemoryPolicy {
  globalRead: boolean;
  globalWrite: boolean;
  projects: { id: string; name: string; read: boolean }[];
  raw: string;
}

export interface CaptureProposal {
  title: string;
  body: string;
}

/** unknownは送信済み・結果不明。保存の自動再送をしてはいけない。 */
export type CaptureOutcome = 'saved' | 'declined' | 'unavailable' | 'unknown';
export type KiokukoMemoryOptions = McpOptions;

export interface KiokukoMemory {
  /** memory_policy の取得。接続不能や無効は null(コーディングは続く)。 */
  policy(signal?: AbortSignal): Promise<MemoryPolicy | null>;
  /** policy が読み取りを許可したグローバル／プロジェクトだけを検索する。 */
  recall(query: string, projectId?: string, signal?: AbortSignal): Promise<string | null>;
  /** 表示した提案そのものが承認され、Stopされていない場合だけ保存を送信する。 */
  captureIfApproved(
    proposal: CaptureProposal,
    confirm: (display: string) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<CaptureOutcome>;
  close(): Promise<void>;
}

const DEFAULT_COMMAND = 'kiokuko';
const DEFAULT_ARGS = ['mcp', '--profile', 'chatgpt-memory'];

function disabled(): KiokukoMemory {
  return {
    async policy() { return null; },
    async recall() { return null; },
    async captureIfApproved() { return 'declined'; },
    async close() {},
  };
}

/**
 * Kiokuko 本体メモリへの接続。既定は無効。
 * 補助機能の障害は本作業へthrowせず、利用不可と保存結果不明を区別する。
 */
export function openKiokukoMemory(
  enabled: boolean,
  options?: Partial<KiokukoMemoryOptions>,
): KiokukoMemory {
  if (!enabled) return disabled();
  const client = new McpStdioClient({
    ...options,
    command: options?.command ?? DEFAULT_COMMAND,
    args: options?.args ?? DEFAULT_ARGS,
  });
  let policy: MemoryPolicy | null = null;

  const getPolicy = async (signal?: AbortSignal): Promise<MemoryPolicy | null> => {
    if (signal?.aborted) return null;
    if (policy !== null) return policy;
    if (!(await client.connect(signal))) {
      if (client.lastError && !signal?.aborted) process.stderr.write(`dkh memory: ${client.lastError}\n`);
      return null;
    }
    try {
      const raw = await client.callTool('memory_policy', {}, signal);
      const parsed = JSON.parse(raw) as {
        global?: { read?: boolean; write?: boolean };
        projects?: { id: string; name: string; read?: boolean }[];
      };
      if (signal?.aborted) return null;
      policy = {
        globalRead: parsed.global?.read === true,
        globalWrite: parsed.global?.write === true,
        projects: (parsed.projects ?? []).map((p) => ({ id: p.id, name: p.name, read: p.read === true })),
        raw,
      };
      return policy;
    } catch (e) {
      client.lastError = `memory_policy の取得に失敗した: ${(e as Error).message}`;
      return null;
    }
  };

  return {
    policy: getPolicy,
    async recall(query, projectId, signal) {
      const p = await getPolicy(signal);
      if (p === null || signal?.aborted) return null;
      const readable = projectId === undefined
        ? p.globalRead : p.projects.some((project) => project.id === projectId && project.read);
      if (!readable) return null;
      try {
        const args: Record<string, unknown> = { query };
        if (projectId !== undefined) args['project'] = projectId;
        return await client.callTool('memory_recall', args, signal);
      } catch (e) {
        client.lastError = `memory_recall に失敗した: ${(e as Error).message}`;
        return null;
      }
    },
    async captureIfApproved(proposal, confirm, signal) {
      // 呼出元がawait中にオブジェクトを変更しても、承認内容を変えない。
      const snapshot = { title: proposal.title, body: proposal.body };
      if (signal?.aborted) return 'declined';
      try {
        const p = await getPolicy(signal);
        if (signal?.aborted) return 'declined';
        if (p === null || !p.globalWrite) return 'unavailable';
        const display = [
          'メモリ保存の提案(保存先: グローバルのみ)',
          `タイトル: ${snapshot.title}`, '本文:', snapshot.body,
        ].join('\n');
        if (!(await confirm(display)) || signal?.aborted) return 'declined';
        await client.callTool('memory_capture', snapshot, signal);
        return 'saved';
      } catch (e) {
        if (e instanceof McpRequestError && e.outcomeUnknown) return 'unknown';
        return signal?.aborted ? 'declined' : 'unavailable';
      }
    },
    async close() { await client.close(); },
  };
}
