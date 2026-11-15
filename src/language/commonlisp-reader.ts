import fs from 'node:fs';
import path from 'node:path';
import { executeBounded, privateEnvironment, sha256, temporaryDirectory, type ExecutionReceipt } from '../lisp/runtime.ts';

export interface ReaderDiagnostic {
  provider: 'SBCL reader';
  scope: 'reader syntax only; no evaluation, macro expansion, type or project-package checking';
  status: 'syntax-error' | 'readable' | 'unverified';
  line?: number;
  column?: number;
  detail: string;
  sourceSha256: string;
  receipt?: ExecutionReceipt;
}

/** A supplemental reader check, never a substitute for CL-LSP semantic diagnostics. */
export async function commonLispReader(text: string, options: { sbcl?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ReaderDiagnostic> {
  const base: ReaderDiagnostic = { provider: 'SBCL reader', scope: 'reader syntax only; no evaluation, macro expansion, type or project-package checking', status: 'unverified', detail: '', sourceSha256: sha256(text) };
  if (Buffer.byteLength(text) > 256 * 1024) return { ...base, detail: 'Reader input exceeds 256 KiB' };
  const root = temporaryDirectory('modkh-cl-reader-');
  // Only fixed host code is evaluated. Project forms are read as data with #. disabled.
  const driver = `(define-condition blocked-read-eval (error) ())
(let ((*read-eval* nil) (*readtable* (copy-readtable nil)) (*package* (find-package :cl-user)))
  (set-dispatch-macro-character #\\# #\\. (lambda (stream char argument)
    (declare (ignore stream char argument)) (error (quote blocked-read-eval))))
  (with-open-file (in "input.lisp" :external-format :utf-8)
    (let* ((text (with-output-to-string (out) (loop for c = (read-char in nil nil) while c do (write-char c out))))
           (stream (make-string-input-stream text)) (end (gensym)))
      (handler-case
          (progn (loop for form = (read stream nil end) until (eq form end)) (format t "MODKH_READER_READABLE"))
        (blocked-read-eval () (format t "MODKH_READER_UNVERIFIED") (princ "Read-time evaluation is disabled" *error-output*))
        (package-error (e) (format t "MODKH_READER_UNVERIFIED") (princ e *error-output*))
        (end-of-file (e) (format t "MODKH_READER_ERROR ~D" (file-position stream)) (princ e *error-output*))
        (reader-error (e) (format t "MODKH_READER_ERROR ~D" (file-position stream)) (princ e *error-output*))
        (error (e) (format t "MODKH_READER_UNVERIFIED") (princ e *error-output*))))))`;
  let receipt: ExecutionReceipt | undefined;
  try {
    fs.writeFileSync(path.join(root, 'input.lisp'), text, { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'reader.lisp'), driver, { mode: 0o600 });
    receipt = await executeBounded(options.sbcl ?? 'sbcl', ['--noinform', '--no-sysinit', '--no-userinit', '--disable-debugger', '--script', 'reader.lisp'], { cwd: root, env: privateEnvironment(root), inputDigest: base.sourceSha256, timeoutMs: options.timeoutMs ?? 5000, maxOutputBytes: 16384, signal: options.signal });
    if (receipt.state !== 'exited' || receipt.exitCode !== 0) return { ...base, receipt, detail: `Reader ${receipt.state}: ${receipt.stderr}` };
    if (receipt.stdout === 'MODKH_READER_READABLE') return { ...base, receipt, status: 'readable', detail: 'Reader accepted the input; semantic diagnostics remain unverified' };
    const error = /^MODKH_READER_ERROR (\d+)$/.exec(receipt.stdout);
    if (error) {
      // SBCL string offsets count Unicode code points; public columns are UTF-16.
      const prefix = Array.from(text).slice(0, Number(error[1])).join('');
      const lines = prefix.split('\n');
      return { ...base, receipt, status: 'syntax-error', line: lines.length, column: lines.at(-1)!.length + 1, detail: receipt.stderr };
    }
    return { ...base, receipt, detail: receipt.stderr || 'No valid reader completion receipt' };
  } finally { if (receipt?.cleanup !== 'unknown') fs.rmSync(root, { recursive: true, force: true }); }
}
