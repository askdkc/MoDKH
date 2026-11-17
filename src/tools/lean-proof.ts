import fs from 'node:fs';
import path from 'node:path';
import { executeBounded, privateEnvironment, type ExecutionReceipt } from '../lisp/runtime.ts';

// Load data from compiled modules without enabling candidate initializers. Replay
// candidate declarations through the kernel before checking the expected type.
export const leanProofDriver = `import Lean
import Lean.Replay
open Lean

def fromModule (env : Environment) (decl mod : Name) : Bool :=
  (env.getModuleIdxFor? decl).any fun idx => env.header.moduleNames[idx.toNat]? == some mod

def checkTarget (target : Name) : IO String := do
  initSearchPath (← getBuildDir)
  let base ← importModules #[{ module := \`Lean }, { module := \`MoDKHTarget }] {}
  let loaded ← importModules #[{ module := \`Lean }, { module := \`MoDKHTarget }, { module := \`MoDKHProof }] {}
  let some (.defnInfo expected) := base.find? \`modkhExpected | return "invalid-contract"
  if !fromModule base \`modkhExpected \`MoDKHTarget || expected.type != mkSort .zero || !expected.levelParams.isEmpty then
    return "invalid-contract"
  let some (.thmInfo theoremInfo) := loaded.find? target | return "target-missing"
  if !fromModule loaded target \`MoDKHProof then return "target-missing"
  if !theoremInfo.levelParams.isEmpty then return "unsupported-universes"
  let additions := loaded.constants.fold (init := ({} : Std.HashMap Name ConstantInfo)) fun acc name info =>
    if base.contains name then acc else acc.insert name info
  let env ← base.replay additions
  let proof : Declaration := .thmDecl {
    name := \`_modkh.checked, levelParams := [], type := expected.value, value := mkConst target }
  match env.addDeclCore 0 proof none with
  | .error _ => return "statement-mismatch"
  | .ok env =>
    let (_, result) := ((CollectAxioms.collect \`_modkh.checked).run env).run {}
    if result.axioms.any (fun ax => !([\`propext, \`Classical.choice, \`Quot.sound].contains ax)) then
      return "disallowed-axioms"
    return "proved"

def main (args : List String) : IO UInt32 := do
  match args with
  | [target] =>
    IO.println (← checkTarget (target.splitOn "." |>.foldl Name.str .anonymous))
    return 0
  | _ => return 2
`;

const rejections = new Map([
  ['target-missing', 'TARGET_THEOREM_MISSING'],
  ['statement-mismatch', 'TARGET_STATEMENT_MISMATCH'],
  ['disallowed-axioms', 'DISALLOWED_AXIOMS'],
]);

function cleanExit(receipt: ExecutionReceipt): boolean {
  return receipt.state === 'exited' && receipt.exitCode === 0 && receipt.cleanup === 'settled';
}

export function boundLeanReceipt(receipt: ExecutionReceipt): ExecutionReceipt {
  return { ...receipt, stdout: receipt.stdout.slice(0, 1024), stderr: receipt.stderr.slice(0, 1024) };
}

export async function checkLeanProof(
  runtime: string, dir: string, contract: Buffer, theorem: string,
  options: { inputDigest: string; timeoutMs: number; comparisonTimeoutMs: number; signal?: AbortSignal },
) {
  const env = privateEnvironment(dir);
  const processOptions = { inputDigest: options.inputDigest, signal: options.signal, cwd: dir, env, maxOutputBytes: 256 * 1024 };
  fs.writeFileSync(path.join(dir, 'MoDKHTarget.lean'), contract, { flag: 'wx', mode: 0o600 });
  const contractReceipt = boundLeanReceipt(await executeBounded(runtime, ['-DwarningAsError=true', '-o', 'MoDKHTarget.olean', 'MoDKHTarget.lean'], {
    ...processOptions, timeoutMs: options.timeoutMs,
  }));
  if (!cleanExit(contractReceipt)) {
    return { proofStatus: 'unverified', code: 'TARGET_CONTRACT_NOT_CHECKED', contractReceipt } as const;
  }
  fs.writeFileSync(path.join(dir, 'MoDKHCheck.lean'), leanProofDriver, { flag: 'wx', mode: 0o600 });
  const proofRun = await executeBounded(runtime, ['--run', 'MoDKHCheck.lean', theorem], {
    ...processOptions, env: { ...env, LEAN_PATH: dir }, timeoutMs: options.comparisonTimeoutMs,
  });
  const proofReceipt = boundLeanReceipt(proofRun);
  const receipts = { contractReceipt, proofReceipt };
  const verdict = proofRun.stdout.trim();
  if (cleanExit(proofReceipt)) {
    if (verdict === 'proved') return { proofStatus: 'proved', code: 'TARGET_PROVED', ...receipts } as const;
    const rejection = rejections.get(verdict);
    if (rejection) return { proofStatus: 'rejected', code: rejection, ...receipts } as const;
    if (verdict === 'invalid-contract') return { proofStatus: 'unverified', code: 'INVALID_TARGET_CONTRACT', ...receipts } as const;
    if (verdict === 'unsupported-universes') return { proofStatus: 'unverified', code: 'UNSUPPORTED_TARGET_UNIVERSES', ...receipts } as const;
  }
  return { proofStatus: 'unverified', code: 'PROOF_UNVERIFIED', ...receipts } as const;
}
