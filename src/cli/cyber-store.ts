import fs from 'node:fs';
import path from 'node:path';

/**
 * The Skill says to keep results out of the repository, but "outside" must still
 * be findable. Reports go under `<working directory>/.modkh/security-audit.<stamp>`,
 * which the workspace already ignores, so nothing lands in the checkout itself
 * and nothing scatters into the home directory.
 *
 * The directory is 0700 and every file is 0600: an audit contains the site's
 * weaknesses, so it must not be world-readable.
 */
export interface ReportStore {
  readonly directory: string;
  /** Write one report; the name is a plain file name, never a path. */
  write(name: string, contents: string): string;
  /** Absolute path for a report file that a tool writes itself. */
  file(name: string): string;
  /** Create (and return) a subdirectory a tool owns, such as sqlmap's output. */
  subdirectory(name: string): string;
}

const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/** A tool may only create plain names; anything else would escape the audit directory. */
const PLAIN_NAME = /^[a-z0-9][a-z0-9.-]*$/;

/** `security-audit.20261128-213045`, so two runs in the same directory stay apart. */
function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * The name the run will use, without creating anything. The approval prompt
 * shows it, and a denied prompt must leave no directory behind.
 */
export function plannedAuditDirectory(root: string, now = new Date()): string {
  const parent = path.join(root, '.modkh');
  let candidate = path.join(parent, `security-audit.${stamp(now)}`);
  // Two runs inside one second would otherwise share a directory.
  for (let index = 2; fs.existsSync(candidate); index++) {
    candidate = path.join(parent, `security-audit.${stamp(now)}-${index}`);
  }
  return candidate;
}

export class AuditDirectory implements ReportStore {
  readonly directory: string;

  constructor(root: string, now = new Date()) {
    this.directory = plannedAuditDirectory(root, now);
    fs.mkdirSync(path.dirname(this.directory), { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.directory, { mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }

  private resolve(name: string): string {
    if (!PLAIN_NAME.test(name)) throw new Error(`不正なレポート名: ${name}`);
    return path.join(this.directory, name);
  }

  write(name: string, contents: string): string {
    const file = this.resolve(name);
    const body = Buffer.byteLength(contents) > MAX_REPORT_BYTES
      ? `${contents.slice(0, MAX_REPORT_BYTES)}\n（上限を超えたため以降を省略）\n`
      : contents;
    fs.writeFileSync(file, body, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  }

  file(name: string): string {
    return this.resolve(name);
  }

  subdirectory(name: string): string {
    const directory = this.resolve(name);
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    fs.chmodSync(directory, 0o700);
    return directory;
  }

  /**
   * A scanner that writes its own report (nikto, sqlmap) uses the process umask,
   * so the run seals the directory at the end: 0700 directories, 0600 files.
   */
  seal(): void {
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { fs.chmodSync(file, 0o700); walk(file); }
        else if (entry.isFile()) fs.chmodSync(file, 0o600);
      }
    };
    fs.chmodSync(this.directory, 0o700);
    walk(this.directory);
  }
}
