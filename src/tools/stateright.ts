import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../agent/types.ts';
import { ToolError } from '../agent/types.ts';
import { executeBounded, privateEnvironment, temporaryDirectory } from '../lisp/runtime.ts';
import type { FormalSettings } from './formal.ts';
import { snapshot } from './formal-input.ts';
import { findStateright } from './stateright-runtime.ts';

interface ModelInput {
  states: string[]; initial: string[]; checkDeadlocks: boolean;
  transitions: { from: string; to: string; action: string }[];
  invariants: { name: string; allowedStates: string[] }[];
}
/** Check result identity and replay any counterexample before accepting a native receipt. */
function validReport(value: unknown, digest: string, bytes: Buffer, exitCode: number | null): boolean {
  try {
    const r = value as Record<string, unknown>;
    const model: ModelInput = JSON.parse(bytes.toString('utf8'));
    if (!r || r.schemaVersion !== 1 || r.verifier !== 'stateright' || r.inputSha256 !== digest
      || !Number.isSafeInteger(r.exploredStates) || Number(r.exploredStates) < 1 || Number(r.exploredStates) > model.states.length
      || !Array.isArray(r.violatedInvariants) || typeof r.deadlock !== 'boolean') return false;
    if (r.status === 'passed') return exitCode === 0 && r.complete === true && r.counterexample === null
      && r.actions === null && r.violatedInvariants.length === 0 && !r.deadlock;
    if (r.status !== 'failed' || exitCode !== 1 || r.complete !== false || !Array.isArray(r.counterexample) || !Array.isArray(r.actions)) return false;
    const states = r.counterexample, actions = r.actions;
    if (!states.length || !model.initial.includes(states[0]) || actions.length !== states.length - 1
      || states.some(s => typeof s !== 'string' || !model.states.includes(s))) return false;
    if (actions.some((action, i) => !model.transitions.some(t => t.from === states[i] && t.to === states[i + 1] && t.action === action))) return false;
    const last = states.at(-1);
    const violations = model.invariants.filter(p => !p.allowedStates.includes(last)).map(p => p.name);
    const deadlock = model.checkDeadlocks && !model.transitions.some(t => t.from === last);
    return (violations.length > 0 || deadlock) && r.deadlock === deadlock
      && JSON.stringify(r.violatedInvariants) === JSON.stringify(violations);
  } catch { return false; }
}

export function staterightTool(settings: FormalSettings): Tool {
  return {
    name: 'verify_stateright',
    description: 'Verify an explicit finite-state JSON model with Stateright. Input: schemaVersion:1, states:string[], initial:string[], transitions:{from,to,action}[], invariants:{name,allowedStates:string[]}[], checkDeadlocks:boolean. Report explored states and counterexample. No TLA+ parsing, temporal/fairness or implementation-equivalence claim.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative model.json containing the states, transitions and invariants.' } }, required: ['path'], additionalProperties: false },
    async execute(args, ctx) {
      if (args.config !== undefined) throw new ToolError('INVALID_ARGS', 'Stateright accepts one JSON model; migrate TLA/config inputs');
      const source = snapshot(ctx.root, args.path, '.json');
      const runtime = findStateright(settings.stateright);
      if (!runtime) throw new ToolError('NOT_EXECUTED', 'Stateright未導入。modkh stateright install で導入してください');
      if (!await ctx.approval.approve({ kind: 'command', title: '前鬼: Stateright検証', detail: `${runtime}\n${source.relativePath}\nSHA-256: ${source.digest}`, signal: ctx.signal })) throw new ToolError('DENIED', 'Verification not approved');
      if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', 'Verification aborted before launch');
      const dir = temporaryDirectory('modkh-stateright-');
      let settled = true;
      try {
        fs.writeFileSync(path.join(dir, 'model.json'), source.bytes, { flag: 'wx', mode: 0o600 });
        const receipt = await executeBounded(runtime, ['--check', 'model.json'], { cwd: dir, env: privateEnvironment(dir), inputDigest: source.digest,
          timeoutMs: Math.min(settings.timeoutMs ?? 30000, 30000), maxOutputBytes: 256 * 1024, signal: ctx.signal });
        settled = receipt.cleanup === 'settled';
        let result: unknown;
        try { result = JSON.parse(receipt.stdout); } catch { /* No result is not success. */ }
        const valid = settled && receipt.state === 'exited' && validReport(result, source.digest, source.bytes, receipt.exitCode);
        const status = valid ? (result as { status: string }).status : 'unverified';
        return { status: !settled || !['exited', 'not-started'].includes(receipt.state) ? 'unknown' : status === 'passed' ? 'ok' : 'error',
          output: JSON.stringify({ verifier: 'stateright', status, modelPath: source.relativePath, hashes: { source: source.digest },
            ...(valid ? { result } : { code: 'STATERIGHT_UNVERIFIED' }), receipt,
            scope: 'Only this explicit finite-state model and its invariants. No temporal/fairness, TLA+ compatibility or implementation-equivalence claim.' }) };
      } finally { if (settled) fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
}
