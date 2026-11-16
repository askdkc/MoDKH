import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../lisp/runtime.ts';

export const CL_LSP_REPOSITORY = 'askdkc/cl-lsp';
type Run = (name: string, command: string, args: string[], cwd?: string) => Promise<string>;

/** Upstream's headless installer loads vendor/, without Lem/Qlot/Quicklisp resolution. */
export async function installBundledCommonLisp(root: string, source: string, ros: string, run: Run) {
  const installer = path.join(source, 'scripts/install-headless.ros');
  const manifest = path.join(source, 'vendor/SOURCES.md');
  for (const file of [installer, manifest, path.join(source, 'vendor/setup.lisp')]) {
    if (!fs.lstatSync(file).isFile()) throw new Error(`Bundled CL-LSP input is not a regular file: ${file}`);
  }
  const prefix = path.join(root, 'server');
  await run('bundled-runtime-install', ros, ['-Q', '--', installer, '--prefix', prefix], source);
  const command = path.join(prefix, 'cl-lsp');
  if (!fs.lstatSync(command).isFile()) throw new Error('Bundled CL-LSP launcher missing or not a regular file');
  await run('runtime-warmup', command, ['--help'], root);
  // Actual initialize, document synchronization and definition responses are checked by the caller.
  return { command, repository: CL_LSP_REPOSITORY, sourcesSha256: sha256(fs.readFileSync(manifest)),
    installerSha256: sha256(fs.readFileSync(installer)), launcherSha256: sha256(fs.readFileSync(command)) };
}
