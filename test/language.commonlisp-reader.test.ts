import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { commonLispReader } from '../src/language/commonlisp-reader.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';
import { LanguageService } from '../src/language/lsp/service.ts';
import { languageTools } from '../src/tools/language.ts';

test('real SBCL reads nested forms, strings and comments; malformed UTF-8 source has original coordinates', async () => {
  const valid = '; 日本語\n(defun add (x) (let ((v "括弧()")) (+ x 1)))\n';
  assert.equal((await commonLispReader(valid)).status, 'readable');
  const text = '; 😀日本語\n(defun broken (x)\n (+ x 1)';
  const error = await commonLispReader(text);
  assert.equal(error.status, 'syntax-error', error.detail);
  assert.equal(error.line, 3); assert.equal(error.column, 9);
});
test('reader never evaluates project code, read-time eval, or package creation', async () => {
  const root = temporaryDirectory('modkh-reader-no-eval-');
  const target = path.join(root, 'written');
  try {
    const form = `(with-open-file (s "${target}" :direction :output :if-does-not-exist :create) (write-line "bad" s))`;
    assert.equal((await commonLispReader(form)).status, 'readable');
    assert.equal((await commonLispReader('#.' + form)).status, 'unverified');
    assert.equal(fs.existsSync(target), false);
    assert.equal((await commonLispReader('(defpackage :project) project:missing')).status, 'unverified');
    assert.equal((await commonLispReader('()', { sbcl: '/missing/sbcl' })).status, 'unverified');
    assert.equal((await commonLispReader('()', { signal: AbortSignal.abort() })).status, 'unverified');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('supplemental reader does not turn absent LSP diagnostics into success', async () => {
  const root = temporaryDirectory('modkh-cl-diagnostics-');
  fs.writeFileSync(path.join(root, 'bad.lisp'), '(defun broken (');
  const service = new LanguageService({ root, settings: { autoInstall: false, disabled: [], installTimeoutMs: 1000, requestTimeoutMs: 1000, servers: { commonlisp: { command: '/missing/cl-lsp' } } } });
  try {
    const tool = languageTools(service).find(t => t.name === 'code_diagnostics')!;
    await assert.rejects(tool.execute({ path: 'bad.lisp' }, { root, approval: { approve: async () => true } }), /Supplemental SBCL reader: syntax-error/);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
