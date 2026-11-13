/** stdin から1行ずつ取得する。ターン実行中に届いた行も失わない。 */
export class LineSource {
  private buffer = '';
  private queue: string[] = [];
  private closed = false;
  private waiters: ((line: string | null) => void)[] = [];
  private readonly stdin: NodeJS.ReadableStream;

  constructor(stdin?: NodeJS.ReadableStream) {
    this.stdin = stdin ?? process.stdin;
    this.stdin.setEncoding?.('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.buffer += chunk;
      let at = this.buffer.indexOf('\n');
      while (at >= 0) {
        this.queue.push(this.buffer.slice(0, at).replace(/\r$/, ''));
        this.buffer = this.buffer.slice(at + 1);
        at = this.buffer.indexOf('\n');
      }
      this.wake();
    });
    this.stdin.on('end', () => {
      // 残りの未改行データも1行として扱う
      if (this.buffer.length > 0) {
        this.queue.push(this.buffer.replace(/\r$/, ''));
        this.buffer = '';
      }
      this.closed = true;
      this.wake();
    });
    this.stdin.on('error', () => {
      this.closed = true;
      this.wake();
    });
  }

  /** メニュー中のコマンドを通常入力へ戻す。 */
  unread(line: string): void {
    this.queue.unshift(line);
  }

  /** 次の1行。入力終端なら null。 */
  next(signal?: AbortSignal): Promise<string | null> {
    // Stop must not consume a queued instruction belonging to the next turn.
    if (signal?.aborted) return Promise.resolve(null);
    const line = this.queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (value: string | null) => {
        signal?.removeEventListener('abort', onAbort);
        this.waiters = this.waiters.filter((waiter) => waiter !== finish);
        resolve(value);
      };
      const onAbort = () => finish(null);
      this.waiters.push(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private wake(): void {
    while (this.queue.length > 0 && this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.(this.queue.shift() ?? null);
    }
    if (this.closed && this.queue.length === 0) {
      const ws = this.waiters;
      this.waiters = [];
      for (const w of ws) w(null);
    }
  }
}
