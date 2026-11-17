import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../agent/types.ts';
import { ToolError } from '../agent/types.ts';
import { snapshot } from './formal-input.ts';
import { executeBounded, privateEnvironment, sha256, temporaryDirectory } from '../lisp/runtime.ts';
import { staterightTool } from './stateright.ts';
import { boundLeanReceipt, checkLeanProof, leanProofDriver } from './lean-proof.ts';
export interface FormalSettings { lean?: string; leanContract?: string; leanTheorem?: string; stateright?: string; timeoutMs?: number }

function assertStandaloneLean(bytes: Buffer): void {
  if ([...bytes.toString('utf8').matchAll(/^\s*import\s+([^\r\n]+)/gm)].some(m => !m[1].split(/\s+/).every(name => /^(Init|Lean|Std)(\.[A-Za-z0-9_]+)*$/.test(name)))) {
    throw new ToolError('UNSUPPORTED', 'Project imports require a reviewed dependency closure; standalone wrapper only');
  }
}

export function formalTools(settings: FormalSettings): Tool[] {
  const { leanContract, leanTheorem } = settings;
  if ((leanContract !== undefined || leanTheorem !== undefined) &&
      (!leanContract || !leanTheorem || leanTheorem.length > 256 || !/^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(leanTheorem))) {
    throw new ToolError('INVALID_ARGS', '--lean-contract and --lean-theorem must be supplied together with an explicit theorem name');
  }
  const verifier = 'lean';
  const leanTool: Tool = {
    name: `verify_${verifier}`,
    description: leanTheorem
      ? `Verify only the host-selected theorem ${leanTheorem}. Submit the proof source once. The host loads the expected proposition from ${JSON.stringify(leanContract)} automatically. Do not submit that file. Report the returned proofStatus and finish without another tool call after proved or rejected.`
      : 'Compile standalone Lean. Without a host-selected proposition and theorem, proof status remains unverified.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Lean proof source path, not the host-selected proposition.' } }, required: ['path'] },
    async execute(args, ctx) {
      const source = snapshot(ctx.root, args.path, '.lean');
      const contract = leanContract && leanTheorem ? snapshot(ctx.root, leanContract, '.lean') : undefined;
      const target = contract ? { expectedPropositionPath: contract.relativePath, theorem: leanTheorem! } : undefined;
      const proofPath = source.relativePath;
      const runtime = settings.lean;
      if (!runtime) throw new ToolError('NOT_EXECUTED', 'Host must configure Lean executable; no model-selected binary');
      assertStandaloneLean(source.bytes);
      if (contract) {
        if (source.digest === contract.digest) throw new ToolError('INVALID_ARGS', 'Proof and expected proposition must be independent inputs');
        assertStandaloneLean(contract.bytes);
      }
      const hashes = { source: source.digest,
        ...(contract ? { contract: contract.digest, checker: sha256(leanProofDriver) } : {}) };
      if (!await ctx.approval.approve({ kind: 'command', title: `MoDKH ${verifier} verification`, detail: `${runtime}\n${JSON.stringify({ hashes, proofPath, target })}\nTrusted executable inputs: metaprograms may execute OS code. Temporary directory is NOT a sandbox.`, signal: ctx.signal })) throw new ToolError('DENIED', 'Verification not approved');
      if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', 'Verification aborted before launch');
      const dir = temporaryDirectory('modkh-formal-');
      let settled = true;
      try {
        const sourceName = contract ? 'MoDKHProof.lean' : source.name;
        fs.writeFileSync(path.join(dir, sourceName), source.bytes, { flag: 'wx', mode: 0o600 });
        const argv = ['-DwarningAsError=true', ...(contract ? ['-o', 'MoDKHProof.olean'] : []), sourceName];
        const timeoutMs = Math.min(settings.timeoutMs ?? 30000, 30000);
        const inputDigest = sha256(JSON.stringify(target ? { hashes, proofPath, target } : hashes));
        const receipt = await executeBounded(runtime, argv, { cwd: dir, env: privateEnvironment(dir), inputDigest,
          timeoutMs, maxOutputBytes: 256 * 1024, signal: ctx.signal });
        settled = receipt.cleanup === 'settled';
        const exited = receipt.state === 'exited';
        const accepted = exited && receipt.exitCode === 0;
        const status = accepted ? 'accepted' : exited && receipt.exitCode !== 0 ? 'failed' : receipt.state === 'not-started' ? 'not-executed' : 'unverified';
        {
          const proof = accepted && settled && contract && target
            ? await checkLeanProof(runtime, dir, contract.bytes, target.theorem, {
              inputDigest, timeoutMs, comparisonTimeoutMs: Math.min(settings.timeoutMs ?? 60_000, 60_000), signal: ctx.signal,
            })
            : { proofStatus: 'unverified', code: 'PROOF_UNVERIFIED' } as const;
          settled &&= (!('contractReceipt' in proof) || proof.contractReceipt?.cleanup === 'settled')
            && (!('proofReceipt' in proof) || proof.proofReceipt?.cleanup === 'settled');
          return { status: !settled ? 'unknown' : proof.proofStatus === 'proved' ? 'ok' : 'error',
            output: JSON.stringify({ verifier, status, proofPath, target, hashes, ...proof, receipt: boundLeanReceipt(receipt) }) };
        }
      } finally { if (settled) fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
  return [leanTool, staterightTool(settings)];
}
