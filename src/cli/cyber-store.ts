import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Skill says to keep results outside the repository, so a run writes into
 * one fresh directory under the home directory: 0700 for the directory, 0600
 * for each report. Nothing here writes into the scanned checkout.
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

export class AuditDirectory implements ReportStore {
  readonly directory: string;

  constructor(directory?: string) {
    this.directory = fs.mkdtempSync(path.join(directory ?? os.homedir(), 'security-audit.'));
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
