import fs from 'node:fs';
import path from 'node:path';

type Run = (name: string, command: string, args: string[], cwd?: string) => Promise<string>;

export function opensslCandidates(opt: string): string[] {
  if (!fs.existsSync(opt)) return [];
  return fs.readdirSync(opt).filter(name => /^openssl(?:@[\w.]+)?$/.test(name))
    .sort((a, b) => a === 'openssl' ? -1 : b === 'openssl' ? 1 : b.localeCompare(a, undefined, { numeric: true }))
    .map(name => path.join(opt, name, 'lib'))
    .filter(dir => ['libcrypto.dylib', 'libssl.dylib'].every(name => fs.existsSync(path.join(dir, name))));
}

// Test loaded symbols, not a version number or the presence of a dylib filename.
export const tlsProbeSource = `#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  void *crypto = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  void *ssl = dlopen(argv[2], RTLD_NOW | RTLD_LOCAL);
  if (!crypto || !ssl) { puts("MODKH_TLS_UNAVAILABLE"); return 0; }
  if (!dlsym(crypto, "ASN1_STRING_data") || !dlsym(crypto, "ASN1_STRING_length") ||
      !dlsym(ssl, "SSL_new") || !dlsym(ssl, "TLS_method")) {
    puts("MODKH_TLS_MISSING_SYMBOLS"); return 0;
  }
  puts("MODKH_TLS_COMPATIBLE"); return 0;
}
`;

export function tlsConfiguration(lib: string): string {
  return `(let ((*standard-output* *error-output*) (*trace-output* *error-output*))
  (ql:quickload "cl+ssl/config" :silent t))
(cl+ssl/config:define-libcrypto-path ${JSON.stringify(fs.realpathSync(path.join(lib, 'libcrypto.dylib')))})
(cl+ssl/config:define-libssl-path ${JSON.stringify(fs.realpathSync(path.join(lib, 'libssl.dylib')))})
(let ((*standard-output* *error-output*) (*trace-output* *error-output*))
  (ql:quickload "cl+ssl" :silent t)
  (asdf:load-system "cl+ssl" :force t))
`;
}

/** Explicit CL+SSL configuration; never relink Homebrew or change global loader settings. */
export async function prepareDarwinTls(root: string, run: Run) {
  const source = path.join(root, 'probe-tls.c'), command = path.join(root, 'probe-tls');
  fs.writeFileSync(source, tlsProbeSource, { flag: 'wx' });
  await run('tls-probe-build', 'cc', [source, '-o', command]);
  const candidates = [...opensslCandidates('/opt/homebrew/opt'), ...opensslCandidates('/usr/local/opt')];
  for (const [index, lib] of candidates.entries()) {
    const output = await run(`tls-library:${index}`, command, [path.join(lib, 'libcrypto.dylib'), path.join(lib, 'libssl.dylib')]);
    if (!output.split(/\r?\n/).includes('MODKH_TLS_COMPATIBLE')) continue;
    const file = path.join(root, 'configure-tls.lisp');
    fs.writeFileSync(file, tlsConfiguration(lib), { flag: 'wx' });
    return { file, libraryDirectory: fs.realpathSync(lib) };
  }
  throw new Error('No installed Homebrew OpenSSL pair provides the CL+SSL APIs (ASN1_STRING_data, SSL_new, TLS_method). Install a compatible OpenSSL package; global libraries were not changed.');
}
