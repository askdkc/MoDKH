import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';
import { runShellProcess, describeShellResult, resolveShell } from '../src/tools/run.ts';
import type { ApprovalGate } from '../src/agent/types.ts';

const yes: ApprovalGate = { approve: async () => true };

function root(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-shell-')));
}

function run(dir: string, command: string, extra: Record<string, unknown> = {}) {
  return new ToolRegistry(defaultTools()).executeOne(
    { id: 'shell', name: 'run_command', args: { command, ...extra } },
    { root: dir, approval: yes },
  );
}

test('a nonzero exit is a result the model can read, not a tool error', async () => {
  const dir = root();
  try {
    // This is the behaviour that made the tool feel wrong: `grep` with no match is exit 1,
    // and a failing test is exit 1. Neither is an infrastructure failure.
    const zero = await run(dir, 'printf "all good"');
    assert.equal(zero.status, 'ok');
    assert.match(zero.output, /\[exit code: 0\]/);

    const grepMiss = await run(dir, 'grep -q never-present some-file 2>/dev/null || exit 1');
    assert.equal(grepMiss.status, 'ok', 'exit 1 reaches the model as a result');
    assert.match(grepMiss.output, /\[exit code: 1\]/);

    const failedTest = await run(dir, 'printf "not ok 1 - broken\\n" ; exit 1');
    assert.equal(failedTest.status, 'ok');
    assert.match(failedTest.output, /not ok 1 - broken/, 'the failure text is available');
    assert.match(failedTest.output, /\[exit code: 1\]/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stdout and stderr are reported separately, and the exit code leads', async () => {
  const dir = root();
  try {
    const r = await run(dir, 'printf OUT; printf ERR >&2; exit 3');
    assert.equal(r.status, 'ok');
    const lines = r.output.split('\n');
    assert.equal(lines[0], '[exit code: 3]', 'the code is the first thing read');
    assert.match(r.output, /--- stdout ---\nOUT/);
    assert.match(r.output, /--- stderr ---\nERR/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a signalled shell still fails, because that is not an interpretable result', async () => {
  const dir = root();
  try {
    const r = await run(dir, 'kill -TERM $$');
    assert.equal(r.status, 'error');
    assert.match(r.output, /SIGTERM/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('oversized output keeps the head and the tail instead of only the tail', async () => {
  const result = await runShellProcess(
    `${JSON.stringify(process.execPath)} -e "process.stdout.write('HEAD_MARKER'+'x'.repeat(200000)+'TAIL_MARKER')"`,
    process.cwd(), undefined, { maxOutputBytes: 4096 });
  const text = describeShellResult(result);
  assert.match(text, /HEAD_MARKER/, 'the beginning identifies what ran');
  assert.match(text, /TAIL_MARKER/, 'the end carries the failure');
  assert.ok(Buffer.byteLength(text) < 4096 + 800, `bounded: ${Buffer.byteLength(text)}`);
  assert.match(text, /文字省略/);
});

test('timeoutMs is honoured and reported distinctly from a failure exit', async () => {
  const outcome = await runShellProcess('sleep 5', process.cwd(), undefined, { timeoutMs: 300 })
    .then(() => null, (e: Error) => e);
  assert.ok(outcome, 'a timeout rejects rather than returning a fake exit code');
  assert.match(outcome.message, /制限時間/);
});

test('bash and zsh are selectable and the chosen shell is reported', async () => {
  const dir = root();
  try {
    const bash = await run(dir, 'printf "%s" "$BASH_VERSION"', { shell: 'bash' });
    assert.equal(bash.status, 'ok', bash.output);
    // The command only prints a version inside bash; an empty result would mean sh ran.
    assert.match(bash.output, /--- stdout ---\n\d+\.\d+/);

    const sh = await run(dir, 'printf "%s" "$0"', {});
    assert.equal(sh.status, 'ok');
    assert.match(sh.output, /--- stdout ---\n\/(bin\/)?sh/, 'the default shell is sh');

    if (fs.existsSync('/bin/zsh')) {
      const zsh = await run(dir, 'printf "%s" "$ZSH_VERSION"', { shell: 'zsh' });
      assert.equal(zsh.status, 'ok', zsh.output);
      assert.match(zsh.output, /--- stdout ---\n\d+\.\d+/);
    }
    // Resolution is a lookup, not a guess: an existing shell resolves to a real file.
    assert.ok(fs.existsSync(resolveShell('bash').file));
    assert.ok(fs.existsSync(resolveShell('sh').file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Bash starts with errexit, nounset, and pipefail while default sh is unchanged', async () => {
  const dir = root();
  try {
    for (const command of ['false', 'unset MODKH_STRICT_TEST; printf "%s" "$MODKH_STRICT_TEST"', 'false | true']) {
      const result = await run(dir, `${command}\nprintf REACHED`, { shell: 'bash' });
      assert.equal(result.status, 'ok', result.output);
      assert.match(result.output, /^\[exit code: [1-9]\d*\]/);
      assert.doesNotMatch(result.output, /REACHED/);
    }
    const sh = await run(dir, 'false | true; printf REACHED');
    assert.match(sh.output, /^\[exit code: 0\]/);
    assert.match(sh.output, /REACHED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an invalid shell or timeout is rejected before anything runs', async () => {
  const dir = root();
  try {
    const badShell = await run(dir, 'printf FORBIDDEN', { shell: 'fish' });
    assert.equal(badShell.status, 'error');
    assert.match(badShell.output, /INVALID_ARGS/);
    assert.doesNotMatch(badShell.output, /FORBIDDEN/);
    const badTimeout = await run(dir, 'printf FORBIDDEN', { timeoutMs: 0 });
    assert.equal(badTimeout.status, 'error');
    assert.match(badTimeout.output, /INVALID_ARGS/);
    const huge = await run(dir, 'printf FORBIDDEN', { timeoutMs: 10_000_000 });
    assert.equal(huge.status, 'error');
    assert.doesNotMatch(huge.output, /FORBIDDEN/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cwd still cannot escape the root, and shell choice does not bypass the guard', async () => {
  const dir = root();
  try {
    const escape = await run(dir, 'pwd', { cwd: '..', shell: 'bash' });
    assert.equal(escape.status, 'error');
    assert.match(escape.output, /OUT_OF_ROOT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('state does not persist between calls, so cwd must be passed explicitly', async () => {
  const dir = root();
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    const first = await run(dir, 'cd sub && pwd');
    assert.match(first.output, new RegExp(`sub`));
    // A fresh shell each call: the second command starts at the root again.
    const second = await run(dir, 'pwd');
    const real = fs.realpathSync(dir);
    assert.match(second.output, new RegExp(real.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(second.output, /\/sub$/m);
    const explicit = await run(dir, 'pwd', { cwd: 'sub' });
    assert.match(explicit.output, /\/sub\n?$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
