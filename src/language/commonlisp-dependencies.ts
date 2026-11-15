import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../lisp/runtime.ts';

type RunStage = (name: string, command: string, args: string[], cwd?: string) => Promise<string>;

/** Resolve the upstream manifest in an owned prefix, without touching the user's Quicklisp. */
export async function installLemDependencies(root: string, lem: string, ros: string, rosHome: string, run: RunStage, tlsFile?: string) {
  const directory = path.join(root, 'dependencies');
  fs.mkdirSync(directory, { mode: 0o700 });
  const manifest = fs.readFileSync(path.join(lem, 'qlfile'));
  fs.writeFileSync(path.join(directory, 'qlfile'), manifest, { flag: 'wx' });
  // Resolve the current upstream manifest; don't copy Lem's historical lock into a fresh install.
  await run('qlot-bootstrap', ros, ['install', 'fukamachi/qlot']);
  const qlot = path.join(rosHome, 'bin', 'qlot');
  // Qlot deliberately quits -1 for --version; test the loadable CLI instead.
  const probe = path.join(directory, 'probe-qlot.lisp');
  fs.writeFileSync(probe, `(require :asdf)
(asdf:load-system "qlot/cli")
(assert (fboundp (find-symbol "QLOT-COMMAND" "QLOT/CLI")))
(format t "MODKH_QLOT_READY ~A~%" (asdf:component-version (asdf:find-system "qlot")))
`, { flag: 'wx' });
  const bootstrap = ['-Q', '-e', '(ros:ensure-asdf)', ...(tlsFile ? ['-l', tlsFile] : [])];
  const output = await run('qlot-capability', ros, [...bootstrap, '-l', probe, '-q']);
  const evidence = output.split(/\r?\n/).filter(line => /^MODKH_QLOT_READY \S+$/.test(line));
  if (evidence.length !== 1) throw new Error('Qlot capability missing completion evidence');
  const version = evidence[0].slice('MODKH_QLOT_READY '.length);
  if (tlsFile) {
    await run('lem-dependencies', ros, [...bootstrap, '-l', probe, '-e', '(qlot/cli:qlot-command "install" "--no-deps")', '-q'], directory);
  } else {
    await run('lem-dependencies', qlot, ['install', '--no-deps'], directory);
  }
  const home = path.join(directory, '.qlot');
  // Exit 0 alone is insufficient. Loading and ASDF resolution are checked by the next stage.
  const setupDigest = sha256(fs.readFileSync(path.join(home, 'setup.lisp')));
  const lock = fs.readFileSync(path.join(directory, 'qlfile.lock'), 'utf8');
  return { home: home + path.sep, version, manifestSha256: sha256(manifest), setupSha256: setupDigest,
    lockSha256: sha256(lock), lock, provider: 'https://github.com/fukamachi/qlot' };
}

/** Locate the source actually resolved by ASDF, not a second unrelated Git checkout. */
export function resolvedDependencyDirectory(discovery: string, system: string, root: string): string {
  const prefix = `MODKH_ASDF_SYSTEM ${system} `;
  const matches = discovery.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`Missing or ambiguous ASDF source: ${system}`);
  const source = fs.realpathSync(matches[0].slice(prefix.length));
  const relative = path.relative(fs.realpathSync(root), source);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
    || !source.endsWith('.asd') || !fs.statSync(source).isFile()) {
    throw new Error(`ASDF source outside owned dependency prefix: ${system}`);
  }
  return path.dirname(source);
}

/** async-process keeps its ASD in src/, while its Autotools entry lives above it. */
export function resolvedNativeBuildDirectory(discovery: string, root: string): string {
  const source = resolvedDependencyDirectory(discovery, 'async-process', root);
  const owned = fs.realpathSync(root);
  for (const candidate of [source, path.dirname(source)]) {
    const relative = path.relative(owned, candidate);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    if (['GNUmakefile', 'Makefile.am', 'configure.ac'].every(name => {
      const file = path.join(candidate, name);
      return fs.existsSync(file) && fs.lstatSync(file).isFile();
    })) return candidate;
  }
  throw new Error('ASDF-resolved async-process has no supported native build entry');
}
