import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../agent/types.ts';
import { ToolError } from '../agent/types.ts';
import { assertRealInRoot, resolveInRoot } from './guard.ts';
import { executeBounded, privateEnvironment, sha256, temporaryDirectory } from '../lisp/runtime.ts';
import { boundLeanReceipt, checkLeanProof, leanProofDriver } from './lean-proof.ts';
export interface FormalSettings { lean?: string; leanContract?: string; leanTheorem?: string; java?: string; tlaJar?: string; timeoutMs?: number }
function snapshot(root: string, value: unknown, extension: string): { name: string; relativePath: string; bytes: Buffer; digest: string } {
  if (typeof value !== 'string' || path.extname(value) !== extension) throw new ToolError('INVALID_ARGS', `Explicit ${extension} input required`);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(path.basename(value))) throw new ToolError('INVALID_ARGS', 'Input basename must start with a letter, not a verifier option');
  const file = resolveInRoot(root, value);
  const real = assertRealInRoot(root, file);
  if (real !== file) throw new ToolError('DENIED', 'Formal inputs must not be symlinks');
  const expected = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024 || stat.ino !== expected.ino || stat.dev !== expected.dev) throw new ToolError('INVALID_ARGS', 'Invalid or changed formal input (256 KiB limit)');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > 256 * 1024) throw new ToolError('TOO_LARGE', 'Formal input grew during read');
    return { name: path.basename(file), relativePath: path.relative(root, file), bytes, digest: sha256(bytes) };
  } finally { fs.closeSync(fd); }
}

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
  return (['lean', 'tla'] as const).map(verifier => ({
    name: `verify_${verifier}`,
    description: verifier === 'lean' ? (leanTheorem
      ? `Verify only the host-selected theorem ${leanTheorem}. Submit the proof source once. The host loads the expected proposition from ${JSON.stringify(leanContract)} automatically. Do not submit that file. Report the returned proofStatus and finish without another tool call after proved or rejected.`
      : 'Compile standalone Lean. Without a host-selected proposition and theorem, proof status remains unverified.')
      : 'Check a standalone finite TLA+ model and explicit cfg with host-configured TLC. Not proof of implementation equivalence.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', ...(verifier === 'lean' ? { description: 'Path to the supplied Lean proof source. Excludes the host-selected expected proposition file.' } : {}) },
      ...(verifier === 'tla' ? { config: { type: 'string' } } : {}),
    }, required: verifier === 'tla' ? ['path', 'config'] : ['path'] },
    async execute(args, ctx) {
      const source = snapshot(ctx.root, args.path, verifier === 'lean' ? '.lean' : '.tla');
      const config = verifier === 'tla' ? snapshot(ctx.root, args.config, '.cfg') : undefined;
      const contract = verifier === 'lean' && leanContract && leanTheorem ? snapshot(ctx.root, leanContract, '.lean') : undefined;
      const target = contract ? { expectedPropositionPath: contract.relativePath, theorem: leanTheorem! } : undefined;
      const proofPath = verifier === 'lean' ? source.relativePath : undefined;
      const runtime = verifier === 'lean' ? settings.lean : settings.java;
      if (!runtime || (verifier === 'tla' && !settings.tlaJar)) throw new ToolError('NOT_EXECUTED', 'Host must configure official verifier executable (and TLC jar); no model-selected binary');
      if (verifier === 'lean') assertStandaloneLean(source.bytes);
      if (contract) {
        if (source.digest === contract.digest) throw new ToolError('INVALID_ARGS', 'Proof and expected proposition must be independent inputs');
        assertStandaloneLean(contract.bytes);
      }
      const hashes = { source: source.digest, ...(config ? { config: config.digest } : {}),
        ...(contract ? { contract: contract.digest, checker: sha256(leanProofDriver) } : {}) };
      if (!await ctx.approval.approve({ kind: 'command', title: `MoDKH ${verifier} verification`, detail: `${runtime}\n${JSON.stringify({ hashes, proofPath, target })}\nTrusted executable inputs: metaprograms may execute OS code. Temporary directory is NOT a sandbox.`, signal: ctx.signal })) throw new ToolError('DENIED', 'Verification not approved');
      if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', 'Verification aborted before launch');
      const dir = temporaryDirectory('modkh-formal-');
      let settled = true;
      try {
        const sourceName = contract ? 'MoDKHProof.lean' : source.name;
        fs.writeFileSync(path.join(dir, sourceName), source.bytes, { flag: 'wx', mode: 0o600 });
        if (config) fs.writeFileSync(path.join(dir, config.name), config.bytes, { flag: 'wx', mode: 0o600 });
        const argv = verifier === 'lean' ? ['-DwarningAsError=true', ...(contract ? ['-o', 'MoDKHProof.olean'] : []), sourceName]
          : ['-Xmx512m', '-cp', path.resolve(settings.tlaJar!), 'tlc2.TLC', '-workers', '1', '-config', config!.name, source.name];
        const timeoutMs = Math.min(settings.timeoutMs ?? 30000, 30000);
        const inputDigest = sha256(JSON.stringify(target ? { hashes, proofPath, target } : hashes));
        const receipt = await executeBounded(runtime, argv, { cwd: dir, env: privateEnvironment(dir), inputDigest,
          timeoutMs, maxOutputBytes: 256 * 1024, signal: ctx.signal });
        settled = receipt.cleanup === 'settled';
        const exited = receipt.state === 'exited';
        const accepted = exited && receipt.exitCode === 0;
        const complete = accepted && /Model checking completed\. No error has been found\./.test(receipt.stdout) && /\d+ distinct states found/.test(receipt.stdout);
        const status = verifier === 'lean' && accepted ? 'accepted' : verifier === 'tla' && complete ? 'passed'
          : exited && receipt.exitCode !== 0 ? 'failed' : receipt.state === 'not-started' ? 'not-executed' : 'unverified';
        if (verifier === 'lean') {
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
        const evidence = { verifier, status, hashes, receipt,
          scope: 'Only this finite model/config; not implementation equivalence. Constants, constraints, fairness and deadlock behavior are defined by these exact hashed inputs.', config: config!.bytes.toString('utf8').slice(0, 16384) };
        return { status: receipt.cleanup === 'unknown' ? 'unknown' : complete ? 'ok' : 'error', output: JSON.stringify(evidence) };
      } finally { if (settled) fs.rmSync(dir, { recursive: true, force: true }); }
    },
  }));
}
