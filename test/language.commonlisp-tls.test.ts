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
