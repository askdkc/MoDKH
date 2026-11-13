import { spawn, type ChildProcess } from 'node:child_process';

export interface McpOptions {
  command: string;
  args?: string[];
  /** 子プロセスへ渡す追加環境変数(検証用)。 */
  env?: Record<string, string>;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** 応答を失った要求は、サーバー側で実行済みの可能性がある。 */
export class McpRequestError extends Error {
  readonly outcomeUnknown: boolean;
  constructor(message: string, outcomeUnknown: boolean) {
    super(message);
    this.name = 'McpRequestError';
    this.outcomeUnknown = outcomeUnknown;
  }
}

interface McpResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** newline-delimited JSON-RPC 2.0。要求の再送は行わない。 */
export class McpStdioClient {
  private child: ChildProcess | null = null;
  private connecting: Promise<boolean> | null = null;
  private stopping: Promise<void> | null = null;
  private closed = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly opts: McpOptions;
  lastError: string | null = null;

  constructor(opts: McpOptions) {
    this.opts = opts;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  }

  async connect(signal?: AbortSignal): Promise<boolean> {
    if (this.closed || signal?.aborted) return false;
    if (this.connecting) return this.connecting;
    if (this.stopping) await this.stopping;
    if (this.closed || signal?.aborted) return false;
    if (this.child) return true;
    this.connecting = this.start(signal);
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  private async start(signal?: AbortSignal): Promise<boolean> {
    let child: ChildProcess;
    try {
      child = spawn(this.opts.command, this.opts.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
      });
    } catch (e) {
      this.lastError = `MCP起動に失敗した: ${(e as Error).message}`;
      return false;
    }
    this.child = child;
    let buffer = '';
    let stderrTail = '';
    child.on('error', (e) => {
      this.lastError = `MCPプロセスエラー: ${e.message}`;
      this.failAll(this.lastError);
    });
    // EPIPEはChildProcessではなくstdinにも届く。未処理errorで本作業を落とさない。
    child.stdin?.on('error', (e) => this.failAll(`MCP送信に失敗した: ${e.message}`));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-800); });
    child.on('close', () => {
      if (this.child !== child) return;
      this.child = null;
      this.failAll('MCPプロセスが終了した');
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      // 補助プロセスの無制限出力で親をメモリ不足にしない。
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        buffer = '';
        child.stdout?.pause();
        this.failAll('MCP応答が上限を超えた');
        void this.stopChild(child);
        return;
      }
      for (;;) {
        const at = buffer.indexOf('\n');
        if (at < 0) break;
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let msg: McpResponse;
        try { msg = JSON.parse(line) as McpResponse; }
        catch { continue; }
        if (!msg || typeof msg.id !== 'number') continue;
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        if (msg.jsonrpc !== '2.0' || (!('result' in msg) && !msg.error)) {
          pending.reject(new McpRequestError('MCP応答が不正', true));
        } else if (msg.error) {
          pending.reject(new McpRequestError(msg.error.message, false));
        } else pending.resolve(msg.result);
      }
    });

    try {
      const result = await this.request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dkh', version: '0.1.0' },
      }, this.connectTimeoutMs, signal);
      if (!result || typeof result !== 'object') throw new Error('MCP初期化応答が不正');
      if (signal?.aborted || this.closed) throw new Error('MCP接続を中断した');
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      return true;
    } catch (e) {
      this.lastError = `MCP初期化に失敗した: ${(e as Error).message}` +
        (stderrTail ? ` / stderr: ${stderrTail.trim()}` : '');
      await this.stopChild(child);
      return false;
    }
  }

  async listTools(signal?: AbortSignal): Promise<{ name: string; description?: string }[]> {
    const result = await this.request('tools/list', {}, undefined, signal) as {
      tools?: { name: string; description?: string }[];
    };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }, undefined, signal) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    } | null;
    if (!result || !Array.isArray(result.content)) {
      throw new McpRequestError('MCPツール応答が不正', true);
    }
    const text = result.content.filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text).join('\n');
    if (result.isError) throw new McpRequestError(text || 'MCPツールがエラーを返した', false);
    return text;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = this.callTimeoutMs,
    signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (signal?.aborted) return Promise.reject(new McpRequestError('MCP要求は中断済み', false));
    if (this.closed || this.stopping || !child?.stdin || child.stdin.destroyed) {
      return Promise.reject(new McpRequestError('MCPに接続していない', false));
    }
    const id = this.nextId++;
    const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const fail = (reason: string) => {
        this.pending.get(id)?.reject(new McpRequestError(reason, true));
        void this.stopChild(child);
      };
      const onAbort = () => fail(`MCP応答待ちを中断した: ${method}`);
      const timer = setTimeout(() => fail(`MCP応答がタイムアウトした: ${method}`), timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin!.write(message, (error) => {
        if (error) fail(`MCP送信に失敗した: ${error.message}`);
      });
    });
  }

  private failAll(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new McpRequestError(message, true));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.child) await this.stopChild(this.child);
    else if (this.stopping) await this.stopping;
  }

  private stopChild(child: ChildProcess): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.child !== child) return Promise.resolve();
    this.failAll('MCPを切断した');
    this.stopping = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      }, 250);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
