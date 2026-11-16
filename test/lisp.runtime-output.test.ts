import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { executeBounded, privateEnvironment, temporaryDirectory } from '../src/lisp/runtime.ts';
import { COMMON_LISP_BUILD_OUTPUT_BYTES } from '../src/language/commonlisp-install.ts';

test('trusted CL build keeps a 16 MiB tail and completes after more than 16 MiB of diagnostics', async () => {
  const root = temporaryDirectory('modkh-build-log-');
  try {
    assert.equal(COMMON_LISP_BUILD_OUTPUT_BYTES, 16 * 1024 * 1024);
    const script = `const fs=require('node:fs');for(let i=0;i<17;i++)fs.writeSync(2,Buffer.alloc(1024*1024,120));fs.writeSync(2,'\\nBUILD_COMPLETE\\n');`;
    const r = await executeBounded(process.execPath, ['-e', script], { cwd: root, env: privateEnvironment(root), inputDigest: 'large-build', timeoutMs: 15000, maxOutputBytes: COMMON_LISP_BUILD_OUTPUT_BYTES, outputOverflow: 'tail' });
    assert.equal(r.state, 'exited'); assert.equal(r.exitCode, 0); assert.equal(r.cleanup, 'settled');
    assert.equal(r.outputTruncated, true); assert.ok(r.outputBytes! > COMMON_LISP_BUILD_OUTPUT_BYTES);
    assert.equal(Buffer.byteLength(r.stderr), COMMON_LISP_BUILD_OUTPUT_BYTES);
    assert.match(r.stderr, /BUILD_COMPLETE\n$/); assert.equal(r.terminationReason, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('default output limit still stops verification processes and preserves its stop reason', async () => {
  const root = temporaryDirectory('modkh-output-limit-');
  try {
    const r = await executeBounded(process.execPath, ['-e', `process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000)`],
      { cwd: root, env: privateEnvironment(root), inputDigest: 'limit', timeoutMs: 5000, maxOutputBytes: 1024 });
    assert.equal(r.terminationReason, 'output-limit');
    assert.notEqual(r.state, 'exited'); assert.ok(Buffer.byteLength(r.stdout) <= 1024);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tail retention preserves UTF-8 boundaries and does not suppress timeouts', async () => {
  const root = temporaryDirectory('modkh-output-tail-');
  try {
    const r = await executeBounded(process.execPath, ['-e', `process.stderr.write('日本語'.repeat(1000));setInterval(()=>{},1000)`],
      { cwd: root, env: privateEnvironment(root), inputDigest: 'tail-timeout', timeoutMs: 500, maxOutputBytes: 100, outputOverflow: 'tail' });
    assert.equal(r.terminationReason, 'timed-out'); assert.equal(r.outputTruncated, true);
    assert.ok(Buffer.byteLength(r.stderr) <= 100); assert.ok(!r.stderr.includes('\ufffd'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a full stderr tail does not hide the final stdout result', async () => {
  const root = temporaryDirectory('modkh-output-streams-');
  try {
    const r = await executeBounded(process.execPath, ['-e', `require('node:fs').writeSync(2,'x'.repeat(4096));setTimeout(()=>process.stdout.write('COMPLETE'),100)`],
      { cwd: root, env: privateEnvironment(root), inputDigest: 'mixed-tail', timeoutMs: 3000, maxOutputBytes: 128, outputOverflow: 'tail' });
    assert.equal(r.exitCode, 0); assert.equal(r.stdout, 'COMPLETE');
    assert.ok(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) <= 128);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
