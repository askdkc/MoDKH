import fs from 'node:fs';
import path from 'node:path';

/** Explicitly selected, trusted dependency sources, never an implicit project root. */
export function commonLispRegistry(projects: string): string {
  const root = fs.realpathSync(projects);
  const directories = new Set<string>();
  let visited = 0;
  const visit = (directory: string) => {
    if (++visited > 10000) throw new Error('Common Lisp dependency directory limit exceeded');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && !['.git', 'node_modules', '.qlot'].includes(entry.name)) visit(path.join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.asd')) directories.add(directory + path.sep);
    }
  };
  visit(root);
  // Explicit directories also work when an upstream tree ships an incomplete ASDF search cache.
  const lispString = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
  return `(:source-registry ${[...directories].sort().map(dir => `(:directory ${lispString(dir)})`).join(' ')} :inherit-configuration)`;
}

export function commonLispSystemProbe(registry: string): string {
  return `(progn (require :asdf) (asdf:clear-source-registry) (asdf:initialize-source-registry '${registry})
    (dolist (name '("cl-lsp" "lem-language-server/cli" "lem/core" "micros" "lem-mailbox" "lem-extension-manager" "async-process" "jsonrpc"))
      (let ((system (asdf:find-system name nil)))
        (unless system (error "MODKH_MISSING_ASDF_SYSTEM ~A" name))
        (format t "MODKH_ASDF_SYSTEM ~A ~A~%" name (asdf:system-source-file system))))
    (write-line "MODKH_ASDF_DISCOVERY_OK"))`;
}
