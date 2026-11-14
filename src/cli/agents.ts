import { randomUUID } from 'node:crypto';
import type { ApprovalGate, ToolCall } from '../agent/types.ts';
import type { TurnResult } from '../agent/loop.ts';
import type { Session } from '../session/store.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { DelegationRequest } from '../subagents/types.ts';
import type { ChatTerminal } from './terminal.ts';

/** Manual invocation uses exactly the same registered tool and durable parent ledger. */
export async function runDirectAgent(request: DelegationRequest, session: Session, registry: ToolRegistry, root: string, signal: AbortSignal, approval: ApprovalGate, ui: ChatTerminal): Promise<TurnResult> {
  const call: ToolCall = { id: randomUUID(), name: 'run_subagent', args: { ...request } };
  session.append({ role: 'assistant', origin: 'manual', content: '', toolCalls: [call] });
  const result = await registry.executeOne(call, { root, signal, approval });
  session.append({ role: 'tool', results: [result] });
  ui.write(`\n子の実行結果: ${result.status}\n${result.output}\n`);
  return result.status === 'ok' ? { outcome: 'complete' }
    : signal.aborted || result.status === 'unknown' ? { outcome: 'interrupted' }
    : { outcome: 'error', errorMessage: result.output };
}
