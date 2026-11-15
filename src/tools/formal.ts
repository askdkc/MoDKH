import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../agent/types.ts';
import { ToolError } from '../agent/types.ts';
import { assertRealInRoot, resolveInRoot } from './guard.ts';
import { executeBounded, privateEnvironment, sha256, temporaryDirectory } from '../lisp/runtime.ts';
export interface FormalSettings { lean?: string; java?: string; tlaJar?: string; timeoutMs?: number }
function snapshot(root: string, value: unknown, extension: string): { name: string; bytes: Buffer; digest: string } {
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
    return { name: path.basename(file), bytes, digest: sha256(bytes) };
  } finally { fs.closeSync(fd); }
}
export function formalTools(settings: FormalSettings): Tool[] {
  return (['lean', 'tla'] as const).map(verifier => ({
    name: `verify_${verifier}`,
    description: verifier === 'lean' ? 'Compile standalone Lean. Compiler acceptance always remains PROOF_UNVERIFIED; does not validate the intended target theorem.' : 'Check a standalone finite TLA+ model and explicit cfg with host-configured TLC. Not proof of implementation equivalence.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, ...(verifier === 'tla' ? { config: { type: 'string' } } : {}) }, required: verifier === 'tla' ? ['path', 'config'] : ['path'] },
    async execute(args, ctx) {
      const source = snapshot(ctx.root, args.path, verifier === 'lean' ? '.lean' : '.tla');
      const config = verifier === 'tla' ? snapshot(ctx.root, args.config, '.cfg') : undefined;
      const runtime = verifier === 'lean' ? settings.lean : settings.java;
      if (!runtime || (verifier === 'tla' && !settings.tlaJar)) throw new ToolError('NOT_EXECUTED', 'Host must configure official verifier executable (and TLC jar); no model-selected binary');
      // Local imports are unsupported; standard distribution imports still do not prove a theorem.
      if (verifier === 'lean' && [...source.bytes.toString('utf8').matchAll(/^\s*import\s+([^\r\n]+)/gm)].some(m => !m[1].split(/\s+/).every(name => /^(Init|Lean|Std)(\.[A-Za-z0-9_]+)*$/.test(name)))) throw new ToolError('UNSUPPORTED', 'Project imports require a reviewed dependency closure; standalone wrapper only');
      const hashes = { source: source.digest, ...(config ? { config: config.digest } : {}) };
      if (!await ctx.approval.approve({ kind: 'command', title: `MoDKH ${verifier} verification`, detail: `${runtime}\n${JSON.stringify(hashes)}\nTrusted executable inputs: metaprograms may execute OS code. Temporary directory is NOT a sandbox.`, signal: ctx.signal })) throw new ToolError('DENIED', 'Verification not approved');
      if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', 'Verification aborted before launch');
      const dir = temporaryDirectory('modkh-formal-');
      let settled = true;
      try {
        fs.writeFileSync(path.join(dir, source.name), source.bytes, { flag: 'wx', mode: 0o600 });
        if (config) fs.writeFileSync(path.join(dir, config.name), config.bytes, { flag: 'wx', mode: 0o600 });
        const argv = verifier === 'lean' ? ['-DwarningAsError=true', source.name]
          : ['-Xmx512m', '-cp', path.resolve(settings.tlaJar!), 'tlc2.TLC', '-workers', '1', '-config', config!.name, source.name];
        const receipt = await executeBounded(runtime, argv, { cwd: dir, env: privateEnvironment(dir), inputDigest: sha256(JSON.stringify(hashes)),
          timeoutMs: Math.min(settings.timeoutMs ?? 30000, 30000), maxOutputBytes: 256 * 1024, signal: ctx.signal });
        settled = receipt.cleanup === 'settled';
        const exited = receipt.state === 'exited';
        const accepted = exited && receipt.exitCode === 0;
        const complete = accepted && /Model checking completed\. No error has been found\./.test(receipt.stdout) && /\d+ distinct states found/.test(receipt.stdout);
        const status = verifier === 'lean' && accepted ? 'accepted' : verifier === 'tla' && complete ? 'passed'
          : exited && receipt.exitCode !== 0 ? 'failed' : receipt.state === 'not-started' ? 'not-executed' : 'unverified';
        const evidence = { verifier, status, hashes, receipt,
          ...(verifier === 'lean' ? { proofStatus: 'unverified', code: 'PROOF_UNVERIFIED', reason: 'Compiler acceptance is not target-theorem validation' }
            : { scope: 'Only this finite model/config; not implementation equivalence. Constants, constraints, fairness and deadlock behavior are defined by these exact hashed inputs.', config: config!.bytes.toString('utf8').slice(0, 16384) }),
        };
        return { status: receipt.cleanup === 'unknown' ? 'unknown' as const : verifier === 'tla' && complete ? 'ok' as const : 'error' as const, output: JSON.stringify(evidence) };
      } finally { if (settled) fs.rmSync(dir, { recursive: true, force: true }); }
    },
  }));
}
