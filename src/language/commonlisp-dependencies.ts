import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../lisp/runtime.ts';

type RunStage = (name: string, command: string, args: string[], cwd?: string) => Promise<string>;

/** Resolve the upstream manifest in an owned prefix, without touching the user's Quicklisp. */
export async function installLemDependencies(root: string, lem: string, ros: string, rosHome: string, run: RunStage) {
  const directory = path.join(root, 'dependencies');
  fs.mkdirSync(directory, { mode: 0o700 });
  const manifest = fs.readFileSync(path.join(lem, 'qlfile'));
  fs.writeFileSync(path.join(directory, 'qlfile'), manifest, { flag: 'wx' });
  // Resolve the current upstream manifest; don't copy Lem's historical lock into a fresh install.
  await run('qlot-bootstrap', ros, ['install', 'fukamachi/qlot']);
  const qlot = path.join(rosHome, 'bin', 'qlot');
  const version = (await run('qlot-capability', qlot, ['--version'])).trim();
  await run('lem-dependencies', qlot, ['install', '--no-deps'], directory);
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
