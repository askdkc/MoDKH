import type { ApprovalGate, ApprovalRequest } from '../agent/types.ts';

export interface ApprovalIo {
  /** 同じ入力キューを共有し、中断時はこの質問の待機だけを解除する。 */
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
  write(text: string): void;
}

/** 端末承認。Stop は承認待ちと、その質問が所有する入力待ちを取り消す。 */
export class TerminalApprovalGate implements ApprovalGate {
  private readonly io: ApprovalIo;
  private pending = new Set<AbortController>();

  constructor(io: ApprovalIo) {
    this.io = io;
  }

  interrupt(): void {
    for (const controller of this.pending) controller.abort();
  }

  async approve(req: ApprovalRequest): Promise<boolean> {
    this.io.write(`\n--- 承認要求(${req.kind}) ---\n${req.title}\n${req.detail}\n`);
    const answer = await this.askOrInterrupt('実行しますか? [y/N] ', req.signal);
    if (answer === null) {
      this.io.write('(中断により拒否)\n');
      return false;
    }
    const ok = answer.trim().toLowerCase() === 'y';
    this.io.write(ok ? '(承認)\n' : '(拒否)\n');
    return ok;
  }

  private async askOrInterrupt(prompt: string, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    this.pending.add(controller);
    let onAbort: () => void = () => {};
    try {
      const interrupted = new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const answer = await Promise.race([this.io.ask(prompt, controller.signal), interrupted]);
      return controller.signal.aborted ? null : answer;
    } finally {
      signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
      this.pending.delete(controller);
    }
  }
}
