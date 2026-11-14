import { emitKeypressEvents, type Key } from 'node:readline';
import { usageFooter, type UsageTotals } from './usage.ts';
import { chars, clean, fitText, wrap, editorLayout, verticalCursor, lineEdge } from './editor.ts';
export { textWidth, fitText } from './editor.ts';
import { readClipboardImage, type ClipboardReader } from './clipboard.ts';
import { MAX_IMAGES, parseImage, type ImageAttachment } from '../agent/images.ts';
import type { ReadStream, WriteStream } from 'node:tty';
import { LineSource } from './lines.ts';

/** `pinned` rows stay on top and are never filtered away; they are actions, not selections. */
export interface Choice { value: string; label: string; detail?: string; pinned?: boolean }
export interface ChatTerminal {
  readonly interactive: boolean;
  readonly imageCount?: number;
  takeImages?(): ImageAttachment[];
  write(text: string): void;
  next(signal?: AbortSignal): Promise<string | null>;
  unread(line: string): void;
  ask(title: string, signal?: AbortSignal, secret?: boolean): Promise<string | null>;
  choose(title: string, choices: readonly Choice[], query?: string): Promise<string | null>;
  setModel(model: string | null): void;
  setActivity?(activity: string | null): void;
  setUsage?(usage: UsageTotals): void;
  close(): void;
}
export const COMMANDS: readonly Choice[] = [
  { value: '/connect', label: '/connect', detail: 'プロバイダーに接続' },
  { value: '/models', label: '/models', detail: 'モデルを選択' },
  { value: '/agents', label: '/agents', detail: '子エージェントの一覧・委譲' },
  { value: '/allow', label: '/allow', detail: '承認ポリシー (all / workspace / none)' },
  { value: '/keys', label: '/keys', detail: '保存済みAPIキー' },
  { value: '/help', label: '/help', detail: '操作ガイド' },
  { value: '/exit', label: '/exit', detail: '終了' },
];
const LOGO = ['██████╗  ██╗  ██╗ ██╗  ██╗', '██╔══██╗ ██║ ██╔╝ ██║  ██║',
  '██║  ██║ █████╔╝  ███████║', '██║  ██║ ██╔═██╗  ██╔══██║', '██████╔╝ ██║  ██╗ ██║  ██║', '╚═════╝  ╚═╝  ╚═╝ ╚═╝  ╚═╝'];
const ACCENT = '34'; // Use the terminal theme's blue; NO_COLOR is respected by paint().
/** Every term must appear in any order, so "seek deep" finds deepseek. Pinned rows always survive. */
function matching(choices: readonly Choice[], query: string): Choice[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return choices.filter(c => c.pinned || terms.every(t => `${c.label} ${c.value} ${c.detail ?? ''}`.toLowerCase().includes(t)));
}

/** Non-TTY / screen-reader mode preserves the line protocol and never emits ANSI. */
class PlainTerminal implements ChatTerminal {
  readonly interactive = false;
  private readonly lines = new LineSource();
  write(text: string): void { process.stdout.write(text); }
  next(signal?: AbortSignal): Promise<string | null> { return this.lines.next(signal); }
  unread(line: string): void { this.lines.unread(line); }
  setModel(_model: string | null): void {}
  /** Line mode has no footer; report the same totals once so piped runs stay observable. */
  setUsage(usage: UsageTotals): void {
    const line = usageFooter(usage, 120);
    if (line) this.write(`\n(使用量: ${line})\n`);
  }
  close(): void { this.lines.close(); }
  ask(title: string, signal?: AbortSignal): Promise<string | null> { this.write(`${title}\n`); return this.next(signal); }
  async choose(title: string, choices: readonly Choice[], query = ''): Promise<string | null> {
    for (;;) {
      const matches = matching(choices, query);
      this.write(`${title}\n`);
      matches.forEach((c, i) => this.write(`${i + 1}. ${c.label}${c.detail ? `  ${c.detail}` : ''}\n`));
      if (!matches.length) this.write('該当するモデルはありません。検索語を変えてください。\n');
      const answer = (await this.ask('番号で選択 / 文字列で検索 / * で全件 / 空行・/cancel で戻る'))?.trim();
      if (!answer || answer === '/cancel') return null;
      if (answer.startsWith('/')) { this.unread(answer); return null; }
      const direct = choices.find(c => c.value === answer);
      if (direct) return direct.value;
      if (/^\d+$/.test(answer)) {
        if (matches[Number(answer) - 1]) return matches[Number(answer) - 1].value;
        this.write('番号が範囲外です。\n');
      } else query = answer === '*' ? '' : answer;
    }
  }
}

type Pending = { finish: (value: string | null) => void; title: string; choices?: readonly Choice[]; secret?: boolean; composer?: boolean };
export interface TerminalOptions { readClipboardImage?: ClipboardReader }
const MAX_INPUT_BYTES = 128 * 1024;
/** One owner for raw input, screen and modal focus. Business effects stay in runChat. */
export class TerminalUI implements ChatTerminal {
  readonly interactive = true;
  private text = '';
  private cursor = 0;
  private selection = 0;
  private pending?: Pending;
  private queued: string[] = [];
  private transcript = '';
  private model: string | null = null;
  private activity: string | null = null;
  private usage: UsageTotals | null = null;
  private closed = false;
  private paste = false;
  private pasteBuffer = '';
  private pasteBytes = 0;
  private editorScroll = 0;
  private images: ImageAttachment[] = [];
  private clipboardTask?: AbortController;
  private inputNotice = '';
  private readonly clipboardReader: ClipboardReader;
  private scroll = 0;
  private hiddenCompletion = false;
  private readonly previousRaw: boolean;
  private readonly color: boolean;
  private readonly input: ReadStream;
  private readonly output: WriteStream;
  private readonly cwd: string;
  constructor(cwd: string, input: ReadStream = process.stdin, output: WriteStream = process.stdout, options: TerminalOptions = {}) {
    this.clipboardReader = options.readClipboardImage ?? readClipboardImage;
    this.cwd = cwd; this.input = input; this.output = output;
    this.previousRaw = input.isRaw; this.color = process.env.NO_COLOR === undefined;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', this.keypress);
    input.on('end', this.onEnd);
    output.on('resize', this.render);
    process.on('exit', this.close);
    input.resume();
    output.write('\x1b[?1049h\x1b[?2004h');
    this.render();
  }
  write(text: string): void { this.transcript = (this.transcript + clean(text)).slice(-64_000); this.scroll = 0; this.render(); }
  setModel(model: string | null): void { this.model = model; this.render(); }
  setActivity(activity: string | null): void { if (this.activity !== activity) { this.activity = activity; this.render(); } }
  setUsage(usage: UsageTotals): void { this.usage = usage; this.render(); }
  unread(line: string): void { this.queued.unshift(line); }
  get imageCount(): number { return this.images.length; }
  takeImages(): ImageAttachment[] { const images = this.images; this.images = []; this.render(); return images; }
  next(signal?: AbortSignal): Promise<string | null> { return this.wait('何を調べますか？ / でコマンド', undefined, '', signal, false, true); }
  ask(title: string, signal?: AbortSignal, secret = false): Promise<string | null> { return this.wait(title, undefined, '', signal, secret); }
  choose(title: string, choices: readonly Choice[], query = ''): Promise<string | null> { return this.wait(title, choices, query); }
  private wait(title: string, choices?: readonly Choice[], query = '', signal?: AbortSignal, secret = false, composer = false): Promise<string | null> {
    if (signal?.aborted || this.closed) return Promise.resolve(null);
    if (this.queued.length) return Promise.resolve(this.queued.shift()!);
    if (this.pending) throw new Error('端末の入力待ちは同時に1件だけです');
    this.text = query; this.cursor = chars(query).length; this.selection = 0; this.hiddenCompletion = false;
    this.editorScroll = 0; this.inputNotice = '';
    return new Promise(resolve => {
      const abort = () => finish(null);
      const finish = (value: string | null) => {
        signal?.removeEventListener('abort', abort);
        this.clipboardTask?.abort(); this.clipboardTask = undefined;
        this.paste = false; this.pasteBuffer = ''; this.pasteBytes = 0;
        if (value === null && composer) this.images = [];
        this.pending = undefined; this.text = ''; this.cursor = 0; this.render(); resolve(value);
      };
      this.pending = { title, choices, finish, secret, composer };
      signal?.addEventListener('abort', abort, { once: true });
      this.render();
    });
  }
  private options(): Choice[] | undefined {
    if (this.pending?.secret) return undefined;
    if (this.pending?.choices) {
      const visible = matching(this.pending.choices, this.text);
      // Pinned rows are actions: they stay on top so a bare Enter cannot pick an arbitrary model.
      return [...visible.filter(c => c.pinned), ...visible.filter(c => !c.pinned)];
    }
    if (!this.hiddenCompletion && this.text.startsWith('/') && !(/\s/.test(this.text))) return matching(COMMANDS, this.text);
    return undefined;
  }
  private insertText(value: string): void {
    const normalized = clean(value.replace(/\r\n?/g, '\n').replace(/\t/g, '  '));
    const added = chars(this.pending?.composer ? normalized : normalized.replace(/\n/g, ' '));
    const parts = chars(this.text);
    const next = parts.slice(0, this.cursor).concat(added, parts.slice(this.cursor)).join('');
    if (Buffer.byteLength(next) > MAX_INPUT_BYTES) { this.inputNotice = '入力は128 KiB以内にしてください'; return; }
    this.text = next; this.cursor += added.length;
    this.selection = 0; this.hiddenCompletion = false; this.inputNotice = '';
  }
  private async pasteImage(): Promise<void> {
    const pending = this.pending;
    if (!pending?.composer || pending.secret || this.clipboardTask) return;
    if (this.images.length >= MAX_IMAGES) { this.inputNotice = `添付画像は最大${MAX_IMAGES}枚です`; this.render(); return; }
    const controller = new AbortController();
    this.clipboardTask = controller; this.inputNotice = '画像を読込中…'; this.render();
    try {
      const image = parseImage(await this.clipboardReader(controller.signal));
      if (controller.signal.aborted || this.pending !== pending || this.closed) return;
      this.images.push(image); this.inputNotice = '';
    } catch (e) {
      if (!controller.signal.aborted && this.pending === pending) this.inputNotice = e instanceof Error ? e.message : '画像の読み取りに失敗しました';
    } finally {
      if (this.clipboardTask === controller) this.clipboardTask = undefined;
      this.render();
    }
  }
  private onEnd = (): void => { this.pending?.finish(null); this.close(); };
  private keypress = (value: string | undefined, key: Key): void => {
    if (key.name === 'paste-start') { this.paste = true; this.pasteBuffer = ''; this.pasteBytes = 0; return; }
    if (key.name === 'paste-end') {
      this.paste = false;
      if (this.pending && this.pasteBytes <= MAX_INPUT_BYTES) this.insertText(this.pasteBuffer);
      else if (this.pasteBytes > MAX_INPUT_BYTES) this.inputNotice = '貼り付けるテキストは128 KiB以内にしてください';
      this.pasteBuffer = ''; this.pasteBytes = 0; this.render(); return;
    }
    if (this.paste) {
      this.pasteBytes += Buffer.byteLength(value ?? '');
      if (this.pasteBytes <= MAX_INPUT_BYTES) this.pasteBuffer += value ?? '';
      return;
    }
    if (key.ctrl && key.name === 'c') {
      this.clipboardTask?.abort(); this.clipboardTask = undefined; this.inputNotice = '';
      if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT');
      else if (this.pending?.choices || this.text || this.images.length) {
        if (this.pending?.choices) this.pending.finish(null);
        else { this.text = ''; this.cursor = 0; this.images = []; this.render(); }
      } else this.pending?.finish(null);
      return;
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      this.scroll = Math.max(0, this.scroll + (key.name === 'pageup' ? 8 : -8)); this.render(); return;
    }
    if (!this.pending) return;
    if (key.ctrl && key.name === 'v') { void this.pasteImage(); return; }
    if (key.ctrl && key.name === 'x' && this.pending.composer) {
      this.clipboardTask?.abort(); this.clipboardTask = undefined;
      this.images.pop(); this.inputNotice = ''; this.render(); return;
    }
    const options = this.options();
    if (key.name === 'escape' || key.ctrl && key.name === 'd') {
      if (this.pending.choices) this.pending.finish(null);
      else if (options?.length && key.name === 'escape') { this.hiddenCompletion = true; this.render(); }
      else if (!this.text && key.ctrl) this.pending.finish(null);
      return;
    }
    const newline = this.pending.composer && (value === '\n' || key.ctrl && key.name === 'j' || (key.name === 'return' || key.name === 'enter') && (key.shift || key.meta));
    if (newline) this.insertText('\n');
    else if (options && (key.name === 'up' || key.name === 'down')) {
      this.selection = options.length ? (this.selection + (key.name === 'down' ? 1 : -1) + options.length) % options.length : 0;
    } else if (this.pending.composer && (key.name === 'up' || key.name === 'down')) {
      const width = Math.max(5, Math.min((this.output.columns || 80) - 4, 80) - 3);
      this.cursor = verticalCursor(this.text, this.cursor, width, key.name === 'up' ? -1 : 1);
    } else if (key.name === 'return' || key.name === 'enter' || key.name === 'tab') {
      if (this.clipboardTask) { this.inputNotice = '画像の読込中です。完了後にEnterで送信'; this.render(); return; }
      const selected = options?.[this.selection];
      if (key.name === 'tab') {
        if (selected && !this.pending.choices) { this.text = selected.value; this.cursor = chars(this.text).length; }
      } else if (this.pending.choices) { if (selected) this.pending.finish(selected.value); }
      else this.pending.finish(selected?.value ?? this.text);
    } else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(chars(this.text).length, this.cursor + 1);
    else if (key.name === 'home' || key.ctrl && key.name === 'a') this.cursor = lineEdge(this.text, this.cursor, 'start');
    else if (key.name === 'end' || key.ctrl && key.name === 'e') this.cursor = lineEdge(this.text, this.cursor, 'end');
    else if (key.ctrl && key.name === 'u') { this.text = ''; this.cursor = 0; this.inputNotice = ''; }
    else if (key.name === 'backspace' || key.name === 'delete') {
      const parts = chars(this.text);
      if (key.name === 'backspace' && this.cursor > 0) parts.splice(--this.cursor, 1);
      else if (key.name === 'delete') parts.splice(this.cursor, 1);
      this.text = parts.join(''); this.selection = 0; this.hiddenCompletion = false;
    } else if (value && !key.ctrl && !key.meta) this.insertText(value);
    this.render();
  };
  private paint(text: string, code: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
  private render = (): void => {
    if (this.closed) return;
    const columns = Math.max(12, this.output.columns || 80), rows = Math.max(6, this.output.rows || 24);
    const width = Math.max(8, Math.min(columns - 4, 80));
    const left = Math.max(0, Math.floor((columns - width) / 2));
    const screen = Array<string>(rows).fill('');
    const place = (row: number, text: string, style = '') => {
      if (row >= 0 && row < rows) screen[row] = ' '.repeat(left) + this.paint(fitText(text, width), style);
    };
    const displayText = this.pending?.secret ? '•'.repeat(chars(this.text).length) : this.text;
    const editor = editorLayout(displayText, width - 3);
    const cursor = editor.positions[Math.min(this.cursor, editor.positions.length - 1)];
    const composer = !this.pending || this.pending.composer;
    const inputRows = Math.min(Math.max(1, rows - 7), Math.max(composer ? 3 : 1, editor.lines.length));
    if (cursor.row < this.editorScroll) this.editorScroll = cursor.row;
    if (cursor.row >= this.editorScroll + inputRows) this.editorScroll = cursor.row - inputRows + 1;
    this.editorScroll = Math.min(this.editorScroll, Math.max(0, editor.lines.length - inputRows));
    const extraRows = inputRows - 1;
    const logs = wrap(this.transcript.trimEnd(), width);
    const history = this.transcript.includes('▶') || this.transcript.includes('https://') || this.scroll > 0 || logs.length > 8;
    const showLogo = !history && rows >= 20 + extraRows && width >= 28;
    const bottomPanel = Math.max(1, rows - 6 - extraRows);
    // Center the whole welcome group, not just its logo. During a conversation
    // the editor stays at the bottom so the available history area is retained.
    const welcomeTop = Math.max(0, Math.floor((rows - (showLogo ? 16 : 9) - extraRows) / 2));
    const panel = history ? bottomPanel : Math.min(bottomPanel, Math.max(1, welcomeTop + (showLogo ? 10 : 3)));
    if (history) {
      const end = Math.max(0, logs.length - this.scroll);
      logs.slice(Math.max(0, end - panel), end).forEach((line, i) => place(i, line));
    } else {
      if (showLogo) LOGO.forEach((line, i) => place(panel - 10 + i, ' '.repeat(Math.floor((width - 26) / 2)) + line, ACCENT));
      place(Math.max(0, panel - 2), 'DKH  ·  Coding Harness', '1');
      // Recent status stays visible; PageUp exposes earlier connection/auth output.
      const end = Math.max(0, logs.length - this.scroll);
      logs.slice(Math.max(0, end - 2), end).forEach((line, i) => place(panel - 1 + i, line));
    }
    const options = this.options();
    if (options) {
      for (let i = 0; i <= panel; i++) screen[i] = '';
      const height = Math.max(1, Math.min(options.length || 1, panel - 2, 8));
      const start = Math.max(0, Math.min(this.selection - height + 1, options.length - height));
      const top = panel - height - 2;
      place(top, this.pending?.choices ? this.pending.title : 'Commands', '1');
      if (!options.length) place(top + 1, '該当なし — 検索語を変える / Esc で戻る');
      const matched = options.filter(choice => !choice.pinned).length;
      options.slice(start, start + height).forEach((choice, i) => {
        const active = start + i === this.selection;
        const detail = choice.pinned && this.pending?.choices
          ? `${this.text ? `${matched}件一致` : `${matched}件`} · 空白区切りは語順自由` : choice.detail ?? '';
        const label = `${active ? '›' : ' '} ${choice.label}  ${detail}`;
        place(top + i + 1, label, active ? '97;44' : choice.pinned ? '2' : '');
      });
    }
    place(panel + 1, this.pending?.secret ? this.pending.title : '─'.repeat(width), ACCENT);
    for (let i = 0; i < inputRows; i++) {
      const line = editor.lines[this.editorScroll + i] ?? '';
      const placeholder = i === 0 && !this.text ? (this.pending?.choices ? 'Search…' : this.pending?.title ?? this.activity ?? '処理中… Ctrl+C で中止') : '';
      place(panel + 2 + i, `│ ${line || placeholder}`);
    }
    const attachments = composer && this.images.length ? ` · 画像${this.images.length}枚 (Ctrl+Xで削除)` : '';
    const status = this.inputNotice && !this.pending?.secret ? this.inputNotice : `DKH  ·  ${this.model ?? '未接続 — /connect'}${attachments}`;
    place(panel + 2 + inputRows, `│ ${status}`, ACCENT);
    const hints = !this.pending ? 'Ctrl+C 中止（入力は応答完了後）' : this.pending.choices ? '↑↓ 選択  Enter 決定  Esc 戻る'
      : composer ? 'Enter 送信  Ctrl+J 改行  Ctrl+V 画像  Cmd+V テキスト' : 'Enter 決定  Ctrl+C 中止';
    place(panel + 3 + inputRows, hints);
    // Usage is the least important line: it takes the bottom row and yields to cwd when narrow.
    const footer = this.usage ? usageFooter(this.usage, width) : '';
    const showFooter = footer.length > 0 && (width >= 40 || this.cwd.length + footer.length + 3 > width);
    place(panel + 4 + inputRows, showFooter ? footer : this.cwd, showFooter ? '2' : '');
    if (showFooter) place(panel + 5 + inputRows, this.cwd, '2');
    const cursorRow = Math.min(rows, panel + 3 + cursor.row - this.editorScroll);
    const cursorCol = Math.min(columns, left + 3 + cursor.column);
    this.output.write('\x1b[?25l\x1b[H' + screen.map(line => line + '\x1b[K').join('\r\n')
      + `\x1b[${cursorRow};${cursorCol}H` + (this.pending ? '\x1b[?25h' : ''));
  };
  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.clipboardTask?.abort(); this.clipboardTask = undefined;
    this.images = [];
    this.pending?.finish(null);
    this.input.removeListener('keypress', this.keypress);
    this.input.removeListener('end', this.onEnd);
    this.output.removeListener('resize', this.render);
    process.removeListener('exit', this.close);
    this.input.setRawMode(this.previousRaw);
    this.input.pause();
    this.output.write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l');
  };
}
export function createTerminal(cwd: string): ChatTerminal {
  return process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb' && process.env.DKH_PLAIN !== '1'
    ? new TerminalUI(cwd) : new PlainTerminal();
}
