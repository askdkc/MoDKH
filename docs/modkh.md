# MoDKH: trusted Common Lisp microagents

MoDKH (Mixture of DKH) is distributed as `modkh`, exposing only the `modkh` command so an existing `dkh` installation is not overwritten. `DKH_HOME`, configuration location and session format remain compatible. No npm publication or global installation is required to test this checkout.

## Run

```sh
npm run build
cat experiments/presets/ts.lisp experiments/presets/formal.lisp > agents.lisp
# Read/review agents.lisp before explicitly trusting its exact bytes.
shasum -a 256 agents.lisp
node dist/index.js chat --cwd . --lisp-config agents.lisp \
  --trust-lisp-sha256 REVIEWED_SHA256 --sbcl sbcl
```

SBCL must already be installed. Without `--lisp-config`, ordinary DKH behavior remains available. With it, builtin/installed plugins are excluded for this session, the head has read/language/delegation tools only, and editing/formal checking is delegated. Hermes cannot be used as the head because its remote tools bypass this boundary. Normal input always goes through the head model unless `--routing auto` is explicitly supplied.

The trusted Lisp file is **arbitrary OS code**, not sandboxed configuration. Its input bytes are snapshotted, hash checked, and evaluated with startup files disabled in a private temporary HOME/TMPDIR and a minimal environment. Additional files loaded by that trusted code are not recursively covered by the hash. Relative loads resolve in the snapshot directory: combine the presets before hashing, or explicitly review absolute dependencies. There is no implicit reload or workspace discovery.

Limits: input 64 KiB, combined process output 256 KiB, evaluation 10 seconds, 64 simultaneous definitions, 1–32 turns per microagent. These are host ceilings, not model options. POSIX process groups are stopped on timeout/abort; processes that deliberately escape the group are outside this guarantee. Unconfirmed cleanup is reported as unknown.

## Verification isolation policy

`--verification-isolation required` is a host-owned requirement for delegated edit acceptance. Plugins, child prompts and skill contents cannot lower it. There is currently no verified OS enforcement backend: this mode returns `not-executed`, `isolation: unavailable`, and a structured `not-started` receipt, without launching the fixed checker or applying the edited snapshot. The receipt digest includes the isolation policy. This is refusal when isolation is unavailable, not an implementation of OS isolation.

The compatibility default is `--verification-isolation integrity-only`. It retains the existing snapshot/digest/freshness checks and explicitly reports `private-snapshot-not-os-sandbox`; it is suitable only for trusted checker/input code. It does not protect host secrets or prevent arbitrary OS writes. No mode currently reports `os-enforced`. This option does not sandbox evaluation of the trusted Lisp configuration itself.

## Configuration API

```lisp
(in-package :dkh)
(defmicroagent micro-ts-outline
  :title "TypeScript構造担当"
  :tool "code_outline" :language "ts" :task-kind "outline"
  :instruction "指定ファイルを調べ、根拠と未確認事項を返す。"
  :max-turns 4)
(register-agent "micro-example" :tool "code_hover" :instruction "型情報を調べる。")
(disable-agent "micro-example")
(remove-agent "micro-example")
(list-agents)
```

The eight presets contain 30 observation roles and 8 editors. Editors remain disabled until BOTH a fixed check and an owner-controlled source/verifier manifest are present. `formal.lisp` adds 前鬼 (`micro-zenki`) and 後鬼 (`micro-goki`).

Every role receives the full manifest-verified `kiokuko-single-purpose-functions/SKILL.md` and `one-shot-software-completion/SKILL.md`. The bundled upstream revision and per-file SHA256 are in `skills/kiokuko-dsh/manifest.json`. Other generic automatic skill injection is disabled for these children. Referenced documents are not implicitly read. Roles cannot add tools beyond host/user permissions; missing tools prevent model execution.

## One-file edit and independent acceptance

```lisp
(defmicroagent micro-js-edit
  :title "JavaScript編集担当"
  :tool "edit_file" :workflow "edit-verify"
  :language "js" :task-kind "edit"
  :instruction "指定ソースだけを修正する。受入テストを変更しない。"
  :max-turns 8)
(set-agent-check "micro-js-edit" "node --test test/addition.test.mjs"
  :sources '("src/addition.mjs")
  :protected '("test/addition.test.mjs" "package.json"))
```

The manifest must explicitly include the trusted check's project inputs/dependencies. The model cannot supply the manifest or command. `targetPaths` must be an exact subset of owner-approved sources and cannot include protected files. Paths must be relative; existing single-link regular files only; symlinks, creation, rename, deletion and multi-file edits are refused. The request format allows up to eight paths for future workflows, but this workflow currently accepts exactly one.

The child only reads/edits private source snapshots. It cannot read/edit the verifier tree through its tools. The host runs the fixed command through the existing approval path in the snapshot, with a 30-second limit and no job promotion. Exit state/code come from the host process handle; stdout cannot fabricate them. On success, current source/verifier hashes and source inode identity are checked before applying the single-file change through a no-follow file descriptor. Concurrent changes produce stale/unknown instead of a pass for another revision. Checks that fail leave the original source unchanged. Successful no-ops are `no-change/verified`; failed or unexecuted checks cannot verify a no-op.

**Security limitation:** the private snapshot is not an OS sandbox. Arbitrary checker or tested source code may execute OS operations, and pre/post hashes do not prove the verifier stayed unchanged throughout execution. External executable/dependency closures and hostile filesystem races are not fully protected. A process can interfere with its own test execution. `passed` means this fixed command exited zero for the recorded unchanged snapshots, not a proof against adversarial code or proof of the task's semantics. Use reviewed trusted execution inputs. Strong hostile-input isolation remains unfinished; see `modkh-verification.md`.

Examples inside the chat:

```text
/head Fix src/addition.mjs and delegate the edit with targetPaths.
/agents
/agents run micro-js-edit --target src/addition.mjs Fix addition.
/agents route ts outline Inspect src/example.ts.
```

`--routing auto` is an optional conservative deterministic router, not LLM judgment. Unsupported/ambiguous requests go back to the head. Mixed intents, negation, conditionals, multiple files, URLs and outside paths do not directly dispatch a role.

## Formal tools

Host flags select executables; the model never selects binaries or arbitrary verifier argv:

```sh
node dist/index.js chat --lisp-config agents.lisp --trust-lisp-sha256 REVIEWED_SHA256 \
  --java /path/to/java --tla-jar /path/to/tla2tools.jar --lean /path/to/lean
```

Both tools require command approval, snapshot bounded inputs, omit API credentials from the environment, and bound time/output. TLC uses one worker and 512 MiB heap. Only exit zero AND TLC completion/state-count output permit a finite-model check to pass. Exact source/config hashes and cfg content scope the result; fairness, constants, constraints and deadlock settings do not establish equivalence to application code.

Lean exit zero always means `accepted`, `proofStatus: unverified`, tool error `PROOF_UNVERIFIED`. This applies to true theorems, empty inputs and convincing-looking output. Compiler rejection is failed; timeout/abort/output overflow is unverified. Project imports are unsupported. Standard distribution imports do not change proof status. No target theorem statement comparison, dependency-axiom audit, comparator or external proof checker is implemented.

## Language tooling and verification

Children now receive language tools within the host ceiling. Tailwind semantic roles force the explicit `server: "tailwind"` selector; ordinary HTML servers are not substituted. Cold position queries initialize the selected server. Unavailable/waiting diagnostics return an error, not zero diagnostics. Dynamic registration acknowledgments do not implement continuous filesystem watching.

Npm installers use `latest`, the official npm registry, private runtime environment, process-group timeout, disk reserve, initialize-before-publish and a 60-second retry cooldown. TypeScript must expose `typescript/lib/tsserver.js`; if latest lacks that API, the installer makes one fallback attempt using an unambiguous numeric TypeScript package recommendation from the installed official server README. It never hardcodes a major version. Missing or conflicting recommendations fail closed. The actual language service must produce a known semantic diagnostic, and LSP initialization must succeed before publication. The receipt records the selected specifier, resolved version, and README/API hashes. Failed staging directories are removed. The control flow is fixture-tested; real registry cold installation remains unverified. PHP native installation selects an official OS/CPU release asset with SHA256 metadata, verifies bytes before extraction, rejects links/traversal, and initializes the binary before publishing. This path has not been exercised against downloaded releases here. Common Lisp bootstrap and real CL/Svelte grammar bundling are still pending.

Run focused/source tests and built-entry checks:

```sh
npm run typecheck
npm run build
node --test test/lisp*.test.ts test/formal*.test.ts test/language.overlay.test.ts test/language.install-platform.test.ts
MODKH_TEST_CHAT="file://$PWD/dist/cli/chat.js" MODKH_TEST_FIXED="file://$PWD/dist/model/fixed.js" node --test test/lisp.cli.test.ts
node scripts/modkh-mutation-check.mjs /tmp/modkh-mutations.json
npm test
```

Real-server probe (explicit installed binary; does not install or touch a real project):

```sh
node scripts/modkh-language-probe.mjs typescript /path/to/typescript-language-server /tmp/ts-result.json --stdio
node scripts/modkh-language-probe.mjs tailwind /path/to/tailwindcss-language-server /tmp/tailwind-result.json --stdio
node scripts/modkh-language-probe.mjs commonlisp /path/to/cl-lsp /tmp/cl-result.json
MODKH_TEST_LEAN=/path/to/lean MODKH_TEST_JAVA=/path/to/java MODKH_TEST_TLA_JAR=/path/to/tla2tools.jar node --test test/formal*.test.ts
```

The probe reports initialize-only separately from semantic success. In particular, the current CL probe does not establish global-function runtime definitions. Full PLAN.md acceptance has not been reached; consult the evidence report before relying on unsupported capabilities.

## Common Lisp diagnostics and current verification limits

When CL-LSP diagnostics are unavailable, `code_diagnostics` also runs a bounded SBCL reader check with a private HOME and disabled startup files. It reads forms as data; it never evaluates, compiles, macroexpands, or loads the project. Read-time evaluation and unresolved project packages remain unverified. This supplemental result **does not change the LSP_UNVERIFIED tool status**, even for readable input. It is neither CL-LSP semantic diagnostics nor a replacement for the required CL-LSP acceptance test.

After building, the real CL probe is:

```sh
node scripts/modkh-language-probe.mjs commonlisp /absolute/path/to/cl-lsp /absolute/path/to/result.json
```

It checks lexical definition coordinates and a separate malformed document, records push notifications and supported pull requests, and returns nonzero unless both checks succeed. It never loads/evaluates the project to manufacture a global definition result. CL-LSP private cold installation remains unimplemented.

Edit verification receipts are single-use. Beginning acceptance closes the child edit tools; changed or restored original files and changed snapshot dependencies invalidate acceptance. These checks do not establish OS isolation: arbitrary executed source can still access resources outside the snapshot, and complete verifier dependency isolation is not implemented. See `modkh-verification.md` for remaining acceptance failures.
