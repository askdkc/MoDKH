import type { Model, ModelEvent, ModelRequest } from '../agent/types.ts';

/** 1ステップ = モデルの1応答(テキスト差分・ツール要求・finish の並び)。 */
export type FixedStep = ModelEvent[];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * スクリプト化した応答を順に返す固定応答モデル。
 * 実APIに接続できない環境でのループ検証・配布確認に使う。
 * 中断を尊重し、abort 時は 'aborted' で静かに終わる。
 */
export class FixedModel implements Model {
  readonly id = 'fixed/scripted';
  readonly requests: ModelRequest[] = [];
  private queue: FixedStep[];

  constructor(steps: FixedStep[], opts?: { skip?: number }) {
    // 再開時は消費済みステップ数分を飛ばす(1ステップ=1つのアシスタント応答)
    const skip = Math.max(0, opts?.skip ?? 0);
    this.queue = steps.slice(skip).map((s) => [...s]);
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // 検証用に送信時点のスナップショットを残す(配列は後で伸びるため複製する)
    this.requests.push({ ...req, messages: [...req.messages] });
    const step = this.queue.shift();
    if (step === undefined) {
      yield { type: 'finish', stopReason: 'error', errorMessage: '応答スクリプトが枯渇した' };
      return;
    }
    for (const ev of step) {
      if (signal.aborted) {
        yield { type: 'finish', stopReason: 'aborted' };
        return;
      }
      await delay(1);
      if (signal.aborted) {
        yield { type: 'finish', stopReason: 'aborted' };
        return;
      }
      yield ev;
    }
  }
}
