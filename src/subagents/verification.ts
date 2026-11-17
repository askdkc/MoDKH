import fs from 'node:fs';
import path from 'node:path';
import { ToolError, type Tool, type ApprovalGate } from '../agent/types.ts';
import type { LocalDefinition } from '../plugins/api.ts';
import { sha256, temporaryDirectory, privateEnvironment, type ExecutionReceipt } from '../lisp/runtime.ts';
import { executeAcceptance } from '../tools/run.ts';
import { readFileTool } from '../tools/files.ts';
import { editFileTool } from '../tools/edit.ts';

export interface Verification {
  status: 'passed' | 'failed' | 'unknown' | 'not-executed';
  output: string;
  receipt?: ExecutionReceipt;
  manifest: Record<string, string>;
  sourceDigests: Record<string, string>;
  change: 'changed' | 'no-change/verified' | 'no-change/unverified';
  application: 'applied' | 'not-applied' | 'stale' | 'partial';
  isolation: 'private-snapshot-not-os-sandbox' | 'unavailable';
  isolationRequirement: 'integrity-only' | 'required';
}
interface Snapshot { bytes: Buffer; stat: fs.Stats; file: string }
function safeSnapshot(root: string, relative: string, max = 2 * 1024 * 1024): Snapshot {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new ToolError('INVALID_ARGS', 'Unsafe manifest path');
  const file = path.join(root, relative);
  let probe = root;
  for (const part of relative.split('/')) {
    probe = path.join(probe, part);
    if (fs.lstatSync(probe).isSymbolicLink()) throw new ToolError('DENIED', 'Symlinks are not supported by edit-verify');
  }
  const expected = fs.lstatSync(file);
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > max) throw new ToolError('DENIED', 'Only bounded existing single-link regular files are supported');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size > max || fs.realpathSync(file) !== file) throw new ToolError('STALE', 'File identity changed during open');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > max || stat.mtimeMs !== fs.fstatSync(fd).mtimeMs) throw new ToolError('STALE', 'File changed during snapshot');
    return { file, bytes, stat };
  } finally { fs.closeSync(fd); }
}

/** The child edits private source files. Only the owner manifest selects source vs verifier. */
export class EditVerification {
  readonly root: string;
  private originalRoot: string;
  private before = new Map<string, Snapshot>();
  private targets: string[];
  private protectedPaths: string[];
  private command: string;
  private consumed = false;
  private isolationRequirement: 'integrity-only' | 'required';
  constructor(root: string, definition: LocalDefinition, targets: string[] | undefined, isolationRequirement: 'integrity-only' | 'required' = 'integrity-only') {
    if (isolationRequirement !== 'integrity-only' && isolationRequirement !== 'required') throw new ToolError('INVALID_ARGS', 'Unknown host verification isolation policy');
    this.isolationRequirement = isolationRequirement;
    if (!definition.verificationCommand || !definition.verificationManifest || !targets?.length) throw new ToolError('NOT_EXECUTED', 'Fixed check, owner manifest and explicit targetPaths required');
    if (targets.length !== 1) throw new ToolError('NOT_EXECUTED', 'Initial edit-verify supports one existing file; multi-file transaction requires a separate workflow');
    this.originalRoot = fs.realpathSync(root);
    this.targets = [...targets];
    this.command = definition.verificationCommand;
    this.protectedPaths = definition.verificationManifest.protected;
    for (const p of targets) if (!definition.verificationManifest.sources.includes(p) || this.protectedPaths.includes(p)) throw new ToolError('DENIED', 'Target is not owner-approved source or belongs to verifier');
    const all = [...new Set([...definition.verificationManifest.sources, ...this.protectedPaths])];
    // Pin all input bytes before exposing any model tool; no partial configuration application.
    for (const p of all) this.before.set(p, safeSnapshot(this.originalRoot, p));
    this.root = fs.realpathSync(temporaryDirectory('modkh-edit-'));
    try {
      for (const p of this.targets) this.materialize(p);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private materialize(relative: string, root = this.root, bytes = this.before.get(relative)!.bytes): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  }
  hasChanges(): boolean {
    return this.targets.some(target =>
      !safeSnapshot(this.root, target).bytes.equals(this.before.get(target)!.bytes));
  }
  sourceDigest(): string {
    return sha256(safeSnapshot(this.root, this.targets[0]!).bytes);
  }
  tools(): Tool[] {
    const allowedPath = { type: 'string', enum: [...this.targets], description: 'Authorized source path in the edit snapshot.' };
    return [readFileTool, editFileTool].map(tool => ({ ...tool,
      parameters: { ...tool.parameters, properties: { ...(tool.parameters.properties as Record<string, unknown>), path: allowedPath } },
      execute: async (args, ctx) => {
        if (this.consumed) throw new ToolError('STALE', 'Editing is closed once acceptance begins');
        if (typeof args.path !== 'string' || !this.targets.includes(args.path)) throw new ToolError('DENIED', 'Outside exact target allowlist');
        safeSnapshot(this.root, args.path);
        return tool.execute(args, { ...ctx, root: this.root, analyze: undefined, jobs: undefined });
      },
    }));
  }
  private unchanged(): boolean {
    try { return [...this.before].every(([p, original]) => {
      const current = safeSnapshot(this.originalRoot, p);
      return current.stat.ino === original.stat.ino && current.stat.dev === original.stat.dev && current.stat.ctimeMs === original.stat.ctimeMs && current.stat.mtimeMs === original.stat.mtimeMs && sha256(current.bytes) === sha256(original.bytes);
    }); } catch { return false; }
  }
  async verify(approval: ApprovalGate, signal: AbortSignal, allowRevision = false): Promise<Verification> {
    if (this.consumed) throw new ToolError('STALE', 'Acceptance receipts are single-use; create a fresh snapshot');
    this.consumed = true;
    const root = fs.realpathSync(temporaryDirectory('modkh-check-'));
    let result: Verification | undefined;
    try {
      result = await this.check(root, approval, signal);
      return result;
    } finally {
      if (result?.receipt?.cleanup !== 'unknown') {
        fs.rmSync(root, { recursive: true, force: true });
        if (allowRevision && result?.status === 'failed' && !signal.aborted) this.consumed = false;
      }
    }
  }
  private async check(root: string, approval: ApprovalGate, signal: AbortSignal): Promise<Verification> {
    const manifest = Object.fromEntries([...this.before].map(([p, snapshot]) => [p, sha256(snapshot.bytes)]));
    const candidates = new Map(this.targets.map(target => [target, safeSnapshot(this.root, target).bytes]));
    const sourceDigests = Object.fromEntries([...this.before.keys()].filter(p => !this.protectedPaths.includes(p))
      .map(p => [p, candidates.has(p) ? sha256(candidates.get(p)!) : manifest[p]]));
    const changed = this.targets.some(p => sourceDigests[p] !== manifest[p]);
    const result: Verification = { status: 'not-executed', output: '', manifest, sourceDigests, change: changed ? 'changed' : 'no-change/unverified', application: 'not-applied', isolation: 'private-snapshot-not-os-sandbox', isolationRequirement: this.isolationRequirement };
    const pristine = () => { try { return this.protectedPaths.every(p => sha256(safeSnapshot(root, p).bytes) === manifest[p]); } catch { return false; } };
    if (!this.unchanged()) return { ...result, status: 'unknown', application: 'stale', output: 'Source or verifier changed before acceptance' };
    const digest = sha256(JSON.stringify({ manifest, sourceDigests, command: this.command, isolationRequirement: this.isolationRequirement }));
    if (this.isolationRequirement === 'required') {
      // No reviewed OS backend currently satisfies read-only dependency closure and host secrecy.
      // A successful capability probe alone must never authorize an unconfined fallback.
      const reason = 'OS isolation required but no verified enforcement backend is available; acceptance command not executed';
      return { ...result, isolation: 'unavailable', output: reason, receipt: {
        state: 'not-started', exitCode: null, signal: null, stdout: '', stderr: reason,
        inputDigest: digest, cleanup: 'settled',
      } };
    }
    // Keep verifier files out of the editor workspace, including between revisions.
    for (const p of this.before.keys()) this.materialize(p, root, candidates.get(p));
    const verificationSnapshots = new Map([...this.before.keys()].map(p => [p, safeSnapshot(root, p)]));
    if (!pristine()) return { ...result, status: 'unknown', application: 'stale', output: 'Verifier changed before acceptance' };
    const receipt = await executeAcceptance(this.command, root, approval, signal, digest, privateEnvironment(root));
    result.receipt = receipt;
    result.output = receipt.stdout + receipt.stderr;
    const sameSources = () => { try { return [...verificationSnapshots].every(([p, original]) => {
      const current = safeSnapshot(root, p);
      return current.stat.ino === original.stat.ino && current.stat.dev === original.stat.dev
        && current.stat.mtimeMs === original.stat.mtimeMs && current.stat.ctimeMs === original.stat.ctimeMs
        && sha256(current.bytes) === sha256(original.bytes);
    }); } catch { return false; } };
    if (!this.unchanged() || !pristine() || !sameSources()) return { ...result, status: 'unknown', application: 'stale', output: result.output + '\nSource/verifier changed during acceptance; not applied' };
    result.status = receipt.state === 'exited' ? receipt.exitCode === 0 ? 'passed' : 'failed' : receipt.state === 'not-started' ? 'not-executed' : 'unknown';
    if (result.status !== 'passed') return result;
    signal.throwIfAborted();
    if (!changed) return { ...result, change: 'no-change/verified' };
    // Open exact existing inodes with O_NOFOLLOW and compare before writing through the fd.
    // No path-based write can follow a swapped symlink. A multi-file transaction is not claimed.
    let applied = 0;
    for (const p of this.targets) {
      const original = this.before.get(p)!;
      const bytes = safeSnapshot(root, p).bytes;
      if (sha256(bytes) === manifest[p]) continue;
      const current = safeSnapshot(this.originalRoot, p);
      if (sha256(current.bytes) !== manifest[p]) return { ...result, status: 'unknown', application: applied ? 'partial' : 'stale' };
      const fd = fs.openSync(current.file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (stat.dev !== original.stat.dev || stat.ino !== original.stat.ino || stat.nlink !== 1 || sha256(fs.readFileSync(fd)) !== manifest[p] || fs.realpathSync(current.file) !== current.file) throw new ToolError('STALE', 'Source identity changed before apply');
        fs.writeSync(fd, bytes, 0, bytes.length, 0); fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd); applied++;
      } finally { fs.closeSync(fd); }
      if (sha256(safeSnapshot(this.originalRoot, p).bytes) !== sourceDigests[p]) return { ...result, status: 'unknown', application: 'partial' };
    }
    if (!this.protectedPaths.every(p => sha256(safeSnapshot(this.originalRoot, p).bytes) === manifest[p])) return { ...result, status: 'unknown', application: 'partial', output: result.output + '\nVerifier changed during source apply' };
    result.application = 'applied';
    return result;
  }
  close(): void { fs.rmSync(this.root, { recursive: true, force: true }); }
}
