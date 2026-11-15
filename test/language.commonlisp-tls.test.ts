import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { opensslCandidates, tlsConfiguration, tlsProbeSource } from '../src/language/commonlisp-tls.ts';
import { executeBounded, privateEnvironment, temporaryDirectory } from '../src/lisp/runtime.ts';

test('TLS candidates require a pair and do not assume an OpenSSL version', () => {
  const root = temporaryDirectory('modkh-tls-candidates-');
  try {
    for (const name of ['openssl', 'openssl@99', 'openssl@98', 'unrelated']) {
      const lib = path.join(root, name, 'lib'); fs.mkdirSync(lib, { recursive: true });
      fs.writeFileSync(path.join(lib, 'libcrypto.dylib'), '');
      if (name !== 'openssl@98') fs.writeFileSync(path.join(lib, 'libssl.dylib'), '');
    }
    assert.deepEqual(opensslCandidates(root), ['openssl', 'openssl@99'].map(n => path.join(root, n, 'lib')));
    const config = tlsConfiguration(path.join(root, 'openssl/lib'));
    assert.ok(config.indexOf('define-libcrypto-path') < config.indexOf('(asdf:load-system "cl+ssl"'));
    assert.match(config, /:force t/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real loader rejects missing legacy API and accepts compatible library symbols', async () => {
  const root = temporaryDirectory('modkh-tls-loader-');
  const run = async (command: string, args: string[]) => {
    const r = await executeBounded(command, args, { cwd: root, env: privateEnvironment(root), inputDigest: 'tls-fixture', timeoutMs: 20000 });
    assert.equal(r.exitCode, 0, r.stderr); assert.equal(r.cleanup, 'settled'); return r.stdout;
  };
  try {
    const fixture = path.join(root, 'library.c'), library = path.join(root, 'libfixture.dylib');
    const source = path.join(root, 'probe.c'), binary = path.join(root, 'probe');
    fs.writeFileSync(source, tlsProbeSource);
    await run('cc', [source, '-o', binary, ...(process.platform === 'linux' ? ['-ldl'] : [])]);
    for (const compatible of [false, true]) {
      fs.writeFileSync(fixture, 'void SSL_new(void) {} void TLS_method(void) {} void ASN1_STRING_length(void) {}' +
        (compatible ? ' void ASN1_STRING_data(void) {}' : ''));
      await run('cc', [process.platform === 'darwin' ? '-dynamiclib' : '-shared', '-fPIC', fixture, '-o', library]);
      assert.equal((await run(binary, [library, library])).trim(), compatible ? 'MODKH_TLS_COMPATIBLE' : 'MODKH_TLS_MISSING_SYMBOLS');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fresh dependency environment resolves transitive CL+SSL dependencies before forced ASDF reload', async () => {
  const root = temporaryDirectory('modkh-tls-dependencies-');
  try {
    for (const name of ['libcrypto.dylib', 'libssl.dylib']) fs.writeFileSync(path.join(root, name), '');
    const configuration = tlsConfiguration(root);
    fs.writeFileSync(path.join(root, 'cl+ssl.asd'), '(asdf:defsystem "cl+ssl" :depends-on ("trivial-gray-streams"))');
    const bootstrap = `(require :asdf)
(asdf:initialize-source-registry '(:source-registry (:directory ${JSON.stringify(root + '/')}) :ignore-inherited-configuration))
(defpackage :cl+ssl/config (:use :cl) (:export :define-libcrypto-path :define-libssl-path))
(defmacro cl+ssl/config:define-libcrypto-path (p) (declare (ignore p)) nil)
(defmacro cl+ssl/config:define-libssl-path (p) (declare (ignore p)) nil)
(defpackage :ql (:use :cl) (:export :quickload))
(defun ql:quickload (name &key silent) (declare (ignore silent))
 (when (equal name "cl+ssl")
  (with-open-file (out ${JSON.stringify(path.join(root, 'trivial-gray-streams.asd'))} :direction :output :if-exists :supersede)
    (prin1 '(asdf:defsystem "trivial-gray-streams") out))
  (asdf:load-asd ${JSON.stringify(path.join(root, 'trivial-gray-streams.asd'))})
  (asdf:load-system "cl+ssl")))
`;
    const run = async (config: string) => {
      const file = path.join(root, 'test.lisp'); fs.writeFileSync(file, bootstrap + config);
      return executeBounded('sbcl', ['--noinform', '--no-sysinit', '--no-userinit', '--disable-debugger', '--script', file],
        { cwd: root, env: privateEnvironment(root), inputDigest: 'tls-dependencies', timeoutMs: 5000 });
    };
    const before = await run(configuration.replace('  (ql:quickload "cl+ssl" :silent t)\n', ''));
    assert.notEqual(before.exitCode, 0);
    assert.match(before.stderr, /trivial-gray-streams/i);
    const after = await run(configuration);
    assert.equal(after.exitCode, 0, after.stderr); assert.equal(after.cleanup, 'settled');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
