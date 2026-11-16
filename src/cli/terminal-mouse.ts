import { StringDecoder } from 'node:string_decoder';

export interface ScreenPoint { row: number; column: number }
export interface MouseReport extends ScreenPoint { button: number; released: boolean }

const report = /\x1b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/g;
const incomplete = /\x1b(?:\[(?:<(?:\d{0,3}(?:;\d{0,5}(?:;\d{0,5})?)?)?)?)?(?![\s\S])/;

/** Deliver mouse reports before readline can interpret them as keyboard input. */
export class TerminalMouseInput {
  private readonly decoder = new StringDecoder('utf8');
  private tail = '';
  private timer?: NodeJS.Timeout;

  private readonly keyboard: (text: string) => void;
  private readonly mouse: (event: MouseReport) => void;
  private readonly inPaste: () => boolean;

  constructor(keyboard: (text: string) => void, mouse: (event: MouseReport) => void, inPaste: () => boolean) {
    this.keyboard = keyboard;
    this.mouse = mouse;
    this.inPaste = inPaste;
  }

  write = (chunk: Buffer | string): void => {
    clearTimeout(this.timer);
    const input = this.tail + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    this.tail = '';
    let offset = 0;
    for (const match of input.matchAll(report)) {
      this.keyboard(input.slice(offset, match.index));
      if (this.inPaste()) this.keyboard(match[0]);
      else this.mouse({ button: Number(match[1]), column: Number(match[2]), row: Number(match[3]), released: match[4] === 'm' });
      offset = match.index + match[0].length;
    }
    const rest = input.slice(offset);
    const partial = incomplete.exec(rest);
    if (partial) {
      this.tail = partial[0];
      this.keyboard(rest.slice(0, partial.index));
      // A standalone Escape is also a key. Give fragmented reports time to arrive.
      this.timer = setTimeout(this.flush, 35).unref();
    } else this.keyboard(rest);
  };

  close(): void {
    clearTimeout(this.timer);
    this.tail = '';
  }

  private flush = (): void => {
    const text = this.tail;
    this.tail = '';
    if (!text.startsWith('\x1b[<')) this.keyboard(text);
  };
}
