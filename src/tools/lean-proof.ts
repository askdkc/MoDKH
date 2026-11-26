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

-- Older Lean exposes replay on Environment and lacks the kernel recursion argument.
-- Elaborate the supported API shape; both branches keep kernel checking enabled.
set_option linter.deprecated false in
def replayChecked (env : Environment) (additions : Std.HashMap Name ConstantInfo) : IO Environment := by
  first
  | exact Environment.ofKernelEnv <$> env.toKernelEnv.replay additions
  | exact env.replay additions

def addChecked (env : Environment) (proof : Declaration) : Except Kernel.Exception Environment := by
  first
  | exact env.addDeclCore 0 1000 proof none
  | exact env.addDeclCore 0 proof none

-- Inspect the replayed kernel's declaration graph, not metadata exported by the candidate.
partial def auditAxioms (env : Kernel.Environment) (pending : List Name)
    (seen : NameSet := {}) : Option Bool :=
  match pending with
  | [] => some true
  | name :: rest => do
    if seen.contains name then return ← auditAxioms env rest seen
    let info ← env.find? name
    if let .axiomInfo _ := info then
      if !([\`propext, \`Classical.choice, \`Quot.sound].contains name) then return false
    auditAxioms env (info.getUsedConstantsAsSet.toList ++ rest) (seen.insert name)

def checkTarget (target : Name) : IO String := do
  initSearchPath (← getBuildDir)
  let loaded ← importModules #[{ module := \`MoDKHTarget }, { module := \`MoDKHProof }] {}
  let some proofIndex := loaded.getModuleIdx? \`MoDKHProof | return "target-missing"
  let some proofData := loaded.header.moduleData[proofIndex.toNat]? | return "comparison-not-checked"
  if !proofData.imports.all (fun i => [\`Init, \`Lean, \`Std].contains i.module.getRoot) then
    return "comparison-not-checked"
  -- Load the contract and the proof's standard library dependencies, never the proof itself.
  let base ← importModules (proofData.imports.push { module := \`MoDKHTarget }) {}
  let some (.defnInfo expected) := base.find? \`modkhExpected | return "invalid-contract"
  if !fromModule base \`modkhExpected \`MoDKHTarget || expected.type != mkSort .zero || !expected.levelParams.isEmpty then
    return "invalid-contract"
  let some (.thmInfo theoremInfo) := loaded.find? target | return "target-missing"
  if !fromModule loaded target \`MoDKHProof then return "target-missing"
  if !theoremInfo.levelParams.isEmpty then return "unsupported-universes"
  let additions := loaded.constants.fold (init := ({} : Std.HashMap Name ConstantInfo)) fun acc name info =>
    if base.contains name then acc else acc.insert name info
  let env ← replayChecked base additions
  let proof : Declaration := .thmDecl {
    name := \`_modkh.checked, levelParams := [], type := expected.value, value := mkConst target }
  match addChecked env proof with
  | .error (.declTypeMismatch ..) => return "statement-mismatch"
  | .error _ => return "comparison-not-checked"
  | .ok env =>
    match auditAxioms env.toKernelEnv [\`_modkh.checked] with
    | some true => return "proved"
    | some false => return "disallowed-axioms"
    | none => return "comparison-not-checked"

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
