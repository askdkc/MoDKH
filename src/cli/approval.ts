import type { ApprovalGate, ApprovalRequest } from '../agent/types.ts';
import { DEFAULT_POLICY, describePolicy, shouldAsk, type PermissionPolicy } from './permissions.ts';

export interface ApprovalIo {
  /** 同じ入力キューを共有し、中断時はこの質問の待機だけを解除する。 */
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
  write(text: string): void;
}

/**
 * A caller can prove a request stays inside the workspace, which lets `workspace` skip the prompt.
 * `outsideWorkspace` defaults to true so an unproven request still asks.
 */
export interface ApprovalScope extends ApprovalRequest {
  outsideWorkspace?: boolean;
}

/** 端末承認。Stop は承認待ちと、その質問が所有する入力待ちを取り消す。 */
export class TerminalApprovalGate implements ApprovalGate {
  private readonly io: ApprovalIo;
  private policy: PermissionPolicy;
  private pending = new Set<AbortController>();
  private queue: Promise<void> = Promise.resolve();

  constructor(io: ApprovalIo, policy: PermissionPolicy = DEFAULT_POLICY) {
    this.io = io;
    this.policy = policy;
  }

  /** Changing the policy affects later requests only; an open prompt is not cancelled. */
  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy;
    this.io.write(`(${describePolicy(policy)})\n`);
  }

  currentPolicy(): PermissionPolicy {
    return this.policy;
  }

  interrupt(): void {
    for (const controller of this.pending) controller.abort();
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    if (request.signal?.aborted) return false;
    const req = request as ApprovalScope;
    if (!shouldAsk({ policy: this.policy, kind: req.kind, outsideWorkspace: req.outsideWorkspace !== false })) return true;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal?.addEventListener('abort', cancel, { once: true });
    this.pending.add(controller);
    let onAbort = () => {};
    const interrupted = new Promise<false>(resolve => {
      onAbort = () => resolve(false);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const operation = this.queue.then(() => controller.signal.aborted ? false : this.prompt({ ...req, signal: controller.signal }));
    this.queue = operation.then(() => {}, () => {});
    try { return await Promise.race([operation, interrupted]); }
    finally {
      request.signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', onAbort);
      this.pending.delete(controller);
    }
  }

  private async prompt(req: ApprovalScope): Promise<boolean> {
    this.io.write(`\n--- 承認要求(${req.kind}) ---\n${req.title}\n${req.detail}\n`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
    let answer: string | null;
    try { answer = await this.askOrInterrupt('実行しますか？（回答期限3分）', signal); }
    finally { clearTimeout(timer); }
    if (answer === null) {
      this.io.write(controller.signal.aborted ? '(3分以内に回答がなかったため拒否)\n' : '(中断により拒否)\n');
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
