import { oneLine } from './cyber-report.ts';

/**
 * Progress for a long scan. Every command reports when it starts and when it
 * ends, with its duration, so the terminal never looks frozen while nmap or
 * nikto is working. The same lines go to the saved transcript when the
 * terminal is in its plain (screen-reader) mode.
 */
export interface Progress {
  /** "… サービス特定 (nmap -sV)" — the command is now running. */
  start(name: string, detail?: string): void;
  /** "  3.2 秒 / 検出あり（2件）" — the command finished with a verdict. */
  done(name: string, verdict: string, count?: number): void;
  /** A note that is not a verdict, e.g. why a check was skipped. */
  note(text: string): void;
}

export interface ProgressSink {
  write(text: string): void;
  /** Live activity line for an interactive terminal; plain mode ignores it. */
  activity?(text: string | null): void;
}

export function createProgress(sink: ProgressSink, clock: () => number = () => Date.now()): Progress {
  let startedAt = 0;
  let current: string | undefined;
  return {
    start(name, detail) {
      current = name;
      startedAt = clock();
      const suffix = detail ? ` (${detail})` : '';
      sink.write(`… ${name}${suffix}\n`);
      sink.activity?.(`${name} を実行中… Ctrl+Cで中止`);
    },
    done(name, verdict, count) {
      if (current !== undefined) current = undefined;
      // Always show the duration: a fast check is still evidence that it ran.
      const elapsed = startedAt ? (clock() - startedAt) / 1000 : 0;
      sink.write(`  ${elapsed.toFixed(2)} 秒 / ${verdict}${count ? `（${count}件）` : ''}\n`);
      sink.activity?.(null);
    },
    note(text) {
      sink.write(`  ${oneLine(text, 300)}\n`);
    },
  };
}
