import { emitKeypressEvents, type Key } from 'node:readline';
import { usageFooter, usageBadgeLine, type UsageTotals } from './usage.ts';
import { chars, clean, fitText, textWidth, wrap, editorLayout, verticalCursor, lineEdge } from './editor.ts';
export { textWidth, fitText } from './editor.ts';
import { readClipboardImage, type ClipboardReader } from './clipboard.ts';
import { MAX_IMAGES, parseImage, type ImageAttachment } from '../agent/images.ts';
import type { ReadStream, WriteStream } from 'node:tty';
import { LineSource } from './lines.ts';
import {
  TranscriptColorizer,
  classifyBackground,
  parseOscBackground,
  paletteFor,
  type ColorizerState,
  type Palette,
} from './color.ts';

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
  /** Live reasoning text; `null` flushes it into the transcript. Display only, never a message. */
  setReasoning?(delta: string | null): void;
  close(): void;
}
export const COMMANDS: readonly Choice[] = [
  { value: '/connect', label: '/connect', detail: 'プロバイダーに接続' },
  { value: '/models', label: '/models', detail: 'モデルを選択' },
  { value: '/reasoning', label: '/reasoning', detail: '推論レベル (off/minimal/low/medium/high)' },
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
  private reasoning = '';
  write(text: string): void { process.stdout.write(text); }
  next(signal?: AbortSignal): Promise<string | null> { return this.lines.next(signal); }
  unread(line: string): void { this.lines.unread(line); }
  setModel(_model: string | null): void {}
  /** Line mode cannot update a status line, so reasoning is printed once when the step moves on. */
  setReasoning(delta: string | null): void {
    if (delta !== null) { this.reasoning = (this.reasoning + delta).slice(-8_000); return; }
    const text = this.reasoning.trimEnd();
    this.reasoning = '';
    if (text) this.write(`\n(推論)\n${text}\n`);
  }
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
/**
 * メインスクリーンに流し込むストリーミングUI。
 * - 完成したトランスクリプト行は一度だけ出力し、その後は端末のスクロールバックへ流れる
 * - 入力欄・状態行・ライブ推論は画面最下部の固定ブロックとして毎回再描画する
 * 代替スクリーン(?1049)は使わない。これが「起動前バッファしか辿れない」問題の原因だった。
 */
export class TerminalUI implements ChatTerminal {
  readonly interactive = true;
  private text = '';
  private cursor = 0;
  private selection = 0;
  private pending?: Pending;
  private queued: string[] = [];
  /** スクロールバックへ確定待ちの完成行(折り返し済み)。 */
  private queue: string[] = [];
  /** まだ改行が来ていない最終行。ライブブロックの一部として再描画する。 */
  private partial = '';
  private started = false;
  /** 会話開始前の案内行(ウェルカムブロックに表示し、会話開始時に本文へ流す)。 */
  private bootLines: string[] = [];
  private bootFlushed = false;
  /** 現在のコントロール範囲の先頭行(次の確定行を書き込む絶対行)。0 は未初期化(=最下段扱い)。 */
  private streamRow = 0;
  /** 最後に出した絶対カーソルの物理行(消去の起点)。 */
  private cursorRow = 0;
  /** リサイズ直後の1回だけ画面全体を消す。 */
  private clearPending = false;
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
  /** Current step's reasoning text, drawn above the composer while it streams. */
  private reasoning = '';
  private readonly clipboardReader: ClipboardReader;
  private hiddenCompletion = false;
  private readonly previousRaw: boolean;
  private readonly color: boolean;
  private readonly input: ReadStream;
  private readonly output: WriteStream;
  private readonly cwd: string;
  private readonly colorizer = new TranscriptColorizer();
  private colorizerState: ColorizerState = { mode: 'text', inDiff: false };
  private palette: Palette = paletteFor('dark');
  private backgroundProbe = false;
  /** 背景プローブ中(返信待ち)。時間による入力抑制には使わない。 */
  private backgroundWaiting = false;
  /** 返信チャンク由来のキー入力だけを一時的に握りつぶす。 */
  private replySilenced = false;
  /** 返信の先頭(\x1b]11;)から返信完了まで、分割チャンクごとに抑制を続ける。 */
  private replyStarted = false;
  private replyDone = false;

  constructor(cwd: string, input: ReadStream = process.stdin, output: WriteStream = process.stdout, options: TerminalOptions = {}) {
    this.clipboardReader = options.readClipboardImage ?? readClipboardImage;
    this.cwd = cwd; this.input = input; this.output = output;
    this.previousRaw = input.isRaw; this.color = process.env.NO_COLOR === undefined;
    // 背景プローブの data 購読を readline より先に付ける。返信チャンクからだけ
    // キー入力を落とし、ユーザーの打鍵はいつでも通常通り処理する。
    if (this.color && (input as unknown as { isTTY?: boolean }).isTTY === true) this.probeBackground();
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', this.keypress);
    input.on('end', this.onEnd);
    output.on('resize', this.onResize);
    process.on('exit', this.close);
    input.resume();
    output.write('\x1b[?2004h');
    // 起動時は一度だけ画面を消して、ロゴを上端に整えて出す(前回実行の残りを見せない)。
    this.clearPending = true;
    if (this.backgroundProbe) this.output.write('\x1b]11;?\x1b\\');
    this.render();
  }

  /**
   * OSC 11 で端末の背景色を問い合わせる。返信がなければダーク扱い(既定パレット)。
   * 返信バイトを readline が文字入力として流し込むので、返信を含むチャンクから
   * 生じるキー入力だけを握りつぶす。返信が来ない端末では何も握らない(CIでも安全)。
   */
  private probeBackground(): void {
    if (this.backgroundProbe) return;
    this.backgroundProbe = true;
    this.backgroundWaiting = true;
    let buffer = '';
    let timer: NodeJS.Timeout | undefined;
    const onData = (chunk: string): void => {
      buffer += chunk;
      if (this.backgroundWaiting && buffer.includes('\x1b]11;')) this.replyStarted = true;
      if (this.replyStarted && !this.replyDone) this.silenceReplyKeys();
      const osc = parseOscBackground(buffer);
      if (osc === null) return;
      finishProbe();
      const classified = classifyBackground(osc, process.env);
      if (classified !== null) { this.palette = paletteFor(classified); this.render(); }
    };
    const finishProbe = (): void => {
      clearTimeout(timer);
      this.backgroundWaiting = false;
      this.replyDone = true;
      this.input.off('data', onData);
      // 分割到着で入力欄に紛れた返信文字があれば取り除く(単一チャンクは握りつぶし済み)。
      const tail = /\x1b\]11;([^\x07\x1b]*)/.exec(buffer)?.[1];
      if (tail && this.text.includes(tail)) {
        this.text = this.text.split(tail).join('');
        this.cursor = Math.min(this.cursor, Math.max(0, this.text.length));
        this.render();
      }
    };
    this.input.on('data', onData);
    timer = setTimeout(finishProbe, 250);
  }

  /** 返信チャンクから生じるキー入力を、現在の入力処理の終わりまで握りつぶす。 */
  private silenceReplyKeys(): void {
    if (this.replySilenced) return;
    this.replySilenced = true;
    queueMicrotask(() => { this.replySilenced = false; });
  }

  /** リサイズ: 画面を作り直す。トランスクリプトはスクロールバックに確定済み。 */
  private onResize = (): void => {
    if (this.closed) return;
    this.clearPending = true;
    this.streamRow = 1;
    this.cursorRow = 1;
    this.render();
  };

  private columns(): number { return Math.max(12, this.output.columns || 80); }
  private rows(): number { return Math.max(6, this.output.rows || 24); }

  /** 起動直後は80、会話が始まると端末幅に応じて広げる(旧設計と同じ判断)。 */
  private width(): number {
    const columns = this.columns();
    return this.started ? Math.max(8, Math.min(columns - 2, Math.max(80, Math.floor(columns * 0.85))))
      : Math.max(8, Math.min(columns - 2, 80));
  }

  write(text: string): void { this.appendTranscript(text); this.render(); }  setModel(model: string | null): void { this.model = model; this.render(); }
  setActivity(activity: string | null): void { if (this.activity !== activity) { this.activity = activity; this.render(); } }
  setUsage(usage: UsageTotals): void { this.usage = usage; this.render(); }
  /** Accumulate one reasoning delta, or flush the finished block into the transcript with `null`. */
  setReasoning(delta: string | null): void {
    if (delta !== null) { this.reasoning = (this.reasoning + delta).slice(-20_000); this.render(); return; }
    const text = this.reasoning.trimEnd();
    this.reasoning = '';
    if (text) this.appendTranscript(`\n(推論)\n${text}\n`);
    this.render();
  }
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
    if (this.replySilenced) return; // OSC 返信の取り込みを入力にしない
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
    // 返信チャンク(OSC 応答)から生じたキー入力だけを握りつぶす。Ctrl+C は通す。
    if (this.replySilenced && !(key.ctrl && key.name === 'c')) return;
    // PageUp/PgDn は端末本来のスクロールに任せる(代替スクリーンを使わないため)。
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
      const width = Math.max(5, Math.min(this.width() - 4, 80) - 3);
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

  /**
   * トランスクリプトへ追記する。完成行は直ちに折り返して出力待ちキューへ。
   * 会話の始まり(`▶`)を検出したら、それ以降の行を広めの幅で折り返す。
   */
  private appendTranscript(text: string): void {
    let source = (this.partial + text).replace(/\r\n?/g, '\n');
    if (/(^|\n)▶/.test(text) || /https:\/\//.test(text)) this.started = true;
    const width = this.width();
    for (;;) {
      const at = source.indexOf('\n');
      if (at < 0) { this.partial = source; break; }
      const logicalLine = source.slice(0, at);
      source = source.slice(at + 1);
      // 会話が始まる前の案内行はウェルカムブロックへ(会話開始時に一括で出力する)。
      if (!this.started) { this.bootLines.push(logicalLine); continue; }
      for (const wrapped of wrap(logicalLine, width)) this.queue.push(wrapped);
      this.partial = '';
    }
  }

  private paint(text: string, code: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }

  /**
   * 1フレームの描画。
   * 1) 前回のライブブロック(最下部)を消去。伸びた分は先にスクロールして確定させる
   * 2) 確定したトランスクリプト行を出力(はみ出した行はスクロールバックへ確定)
   * 3) 最下部ブロック(ライブ推論・メニュー・入力欄・状態行)を常に最下段に再描画
   * 再描画は最下部ブロックに限るため、過去の履歴が端末のスクロールバックに蓄積する。
   */
  private render = (): void => {
    if (this.closed) return;
    const rows = this.rows();
    const width = this.width();
    // 画面全体に対してコンテンツを中央に寄せる(ウェルカムも会話中も同じ中央寄せ)。
    const paintMargin = Math.max(0, Math.floor((this.columns() - width) / 2));
    const marginPrefix = ' '.repeat(Math.min(paintMargin, Math.max(0, this.columns() - 6)));
    const stream = this.queue.splice(0, this.queue.length)
      .map(line => this.color ? this.colorizer.line(line, this.palette) : line);
    this.colorizerState = this.colorizer.state();
    // 会話が始まった瞬間、ウェルカム(ロゴ+案内)を一度だけ本文へ流し込む。
    if (this.started && !this.bootFlushed) {
      this.bootFlushed = true;
      const banner = ['DKH  ·  Coding Harness', ...LOGO];
      stream.unshift(...banner.map(l => this.paint(l, l.startsWith('DKH') ? '1' : ACCENT)),
        ...this.bootLines.flatMap(l => wrap(l, width)));
      this.bootLines = [];
    }

    // --- ライブブロック(最下部)を構成する ---
    const displayText = this.pending?.secret ? '•'.repeat(chars(this.text).length) : this.text;
    const composer = !this.pending || this.pending.composer;
    const editor = editorLayout(displayText, Math.max(5, width - 3));
    const cursor = editor.positions[Math.min(this.cursor, editor.positions.length - 1)];
    const inputRows = Math.min(Math.max(1, rows - 8), Math.max(composer ? 3 : 1, editor.lines.length));
    const options = this.options();

    const partialLines = wrap(this.partial, width);
    const partialCount = this.partial ? partialLines.length : 0;
    // ライブの推論は見出し含めて表示。はみ出すときは古い行(先頭)から落とす。
    const reasoningText = this.reasoning.trimEnd() === '' ? [] :
      wrap(`(推論)\n${this.reasoning.trimEnd()}`, width);
    const reservedForBody = 1 /* divider */ + inputRows + 4 /* status/hints/cwd+footer */ + (options ? 2 : 0) + partialCount;
    const maxReasoning = Math.max(0, Math.min(rows - reservedForBody - 1, 24));
    const liveReasoning = reasoningText.length === 0 ? [] :
      reasoningText.slice(Math.max(0, reasoningText.length - maxReasoning))
        .map(line => ({ text: line, style: this.palette.reasoning }));

    const optionsLines: { text: string; style: string }[] = [];
    if (options) {
      const height = Math.max(1, Math.min(options.length || 1, Math.max(2, rows - (partialCount + liveReasoning.length) - 6), 8));
      const start = Math.max(0, Math.min(this.selection - height + 1, options.length - height));
      optionsLines.push({ text: this.pending?.choices ? this.pending.title : 'Commands', style: '1' });
      if (!options.length) optionsLines.push({ text: '該当なし — 検索語を変える / Esc で戻る', style: '2' });
      const matched = options.filter(choice => !choice.pinned).length;
      options.slice(start, start + height).forEach((choice, i) => {
        const active = start + i === this.selection;
        const detail = choice.pinned && this.pending?.choices
          ? `${this.text ? `${matched}件一致` : `${matched}件`} · 空白区切りは語順自由` : choice.detail ?? '';
        const label = `${active ? '›' : ' '} ${choice.label}  ${detail}`;
        optionsLines.push({ text: label, style: active ? '97;44' : choice.pinned ? '2' : '' });
      });
    }
    const lines: { text: string; style: string }[] = [...optionsLines, { text: '─'.repeat(width), style: ACCENT }];
    const editorStart = partialCount + liveReasoning.length + lines.length;
    // 入力欄が表示行数を超えたら、カーソルが常に窓内に来るようにスクロールする。
    if (cursor.row < this.editorScroll) this.editorScroll = cursor.row;
    if (cursor.row >= this.editorScroll + inputRows) this.editorScroll = cursor.row - inputRows + 1;
    this.editorScroll = Math.max(0, Math.min(this.editorScroll, Math.max(0, editor.lines.length - inputRows)));
    for (let i = 0; i < inputRows; i++) {
      const line = editor.lines[this.editorScroll + i] ?? '';
      const placeholder = i === 0 && !this.text ? (this.pending?.choices ? 'Search…' : this.pending?.title ?? this.activity ?? '処理中… Ctrl+C で中止') : '';
      lines.push({ text: `│ ${line || placeholder}`, style: '' });
    }
    const attachments = composer && this.images.length ? ` · 画像${this.images.length}枚 (Ctrl+Xで削除)` : '';
    const status = this.inputNotice && !this.pending?.secret ? this.inputNotice : `DKH  ·  ${this.model ?? '未接続 — /connect'}${attachments}`;
    lines.push({ text: `│ ${status}`, style: ACCENT });
    const hints = !this.pending ? 'Ctrl+C 中止（入力は応答完了後）' : this.pending.choices ? '↑↓ 選択  Enter 決定  Esc 戻る'
      : composer ? 'Enter 送信  Ctrl+J 改行  Ctrl+V 画像  Cmd+V テキスト' : 'Enter 決定  Ctrl+C 中止';
    lines.push({ text: hints, style: '2' });
    // 最下段: 作業ルート(左)とトークン使用量のステータス(右)。狭い時はルートだけ。
    const usageStatus = this.usage ? usageBadgeLine(this.usage, Math.max(0, width - textWidth(this.cwd) - 3)) : '';
    const usageWidth = textWidth(usageStatus);
    const cwdWidth = textWidth(this.cwd);
    const bottom = usageStatus.length > 0 && width - cwdWidth - usageWidth >= 2
      ? `${this.cwd}${' '.repeat(width - cwdWidth - usageWidth)}${usageStatus}`
      : this.cwd;
    lines.push({ text: bottom, style: '2' });

    const styled = (row: { text: string; style: string }): string =>
      this.paint(fitText(row.text, width), row.style);
    // 会話が始まる前のウェルカム: ロゴ+案内を縦中央に整える。
    // paintMargin は両フェーズ共通(画面全体に対する中央寄せ)。
    const marginStyled = (row: { text: string; style: string }): string => marginPrefix + styled(row);
    let body: string[] = [];
    let editorStartIdx = editorStart;
    if (!this.started) {
      // 旧デザインと同じ: ロゴはコンテンツ幅の中央、タイトルと案内は左端から。
      const widthCenter = (line: string): string => {
        const pad = Math.max(0, Math.floor((width - textWidth(line)) / 2));
        return ' '.repeat(pad) + line;
      };
      const welcome: { text: string; style: string }[] = [
        { text: 'DKH  ·  Coding Harness', style: '1' },
        ...LOGO.map(line => ({ text: widthCenter(line), style: ACCENT })),
        ...this.bootLines.slice(-8).map(line => ({ text: line, style: '' })),
      ];
      // 縦中央寄せは「ロゴと入力欄の間」の余白で行う(ブロックは最下段固定のため、
      // 上端の余白ではグループの位置は動かない)。
      const composerRows = partialCount + liveReasoning.length + optionsLines.length + lines.length;
      const midPad = Math.max(0, Math.floor((rows - welcome.length - composerRows) / 2) - 1);
      body = [
        ...welcome.map(row => marginStyled(row)),
        ...Array.from({ length: midPad }, () => marginPrefix),
        ...(this.partial ? partialLines.map(line => marginPrefix + (this.color ? this.fork().line(line, this.palette) : line)) : []),
        ...liveReasoning.map(row => marginPrefix + this.paint(fitText(row.text, width), row.style)),
        // lines にはコマンドメニュー(optionsLines)が含まれる。二重に展開しない。
        ...lines.map(marginStyled),
      ];
      editorStartIdx = welcome.length + midPad + partialCount + liveReasoning.length + optionsLines.length + 1;
    } else {
      body = [
        ...(this.partial ? partialLines.map(line => marginPrefix + (this.color ? this.fork().line(line, this.palette) : line)) : []),
        ...liveReasoning.map(row => marginPrefix + this.paint(fitText(row.text, width), row.style)),
        // lines にはコマンドメニュー(optionsLines)が含まれる。二重に展開しない。
        ...lines.map(marginStyled),
      ];
    }
    // 最下部ブロックは1行以上の余白を残して画面に収める。はみ出すときは上侧から落とす。
    const overflow = Math.max(0, body.length - (rows - 1));
    if (overflow > 0) {
      body = body.slice(overflow);
      editorStartIdx = Math.max(0, editorStartIdx - overflow);
    }
    const liveCount = body.length;
    // --- 描画。消去は「最終トランスクリプト行の下一行」から下端まで。
    // ライブブロックと空き行だけを消すので、過去の行はスクロールバックに確定したままである。
    // streamRow は未初期化のとき最下段(起動時のシェルプロンプト位置を想定)。
    let out = '';
    // サイズ変更や起動直後は画面を一度消して制御範囲を作り直す(残りを見せない)。
    if (this.clearPending) {
      this.clearPending = false;
      this.streamRow = 1;
      this.cursorRow = 1;
      out += '\x1b[2J\x1b[1;1H';
    }
    const streamRow = this.streamRow >= 1 ? Math.max(1, Math.min(rows, this.streamRow)) : rows;
    // 消去: カーソルは前回フレームの入力位置にある。そこから streamRow まで上がって消す。
    const cursorBase = Math.max(1, Math.min(rows, this.cursorRow >= 1 ? this.cursorRow : rows));
    const eraseUp = Math.max(0, cursorBase - streamRow);
    if (eraseUp > 0) out += `\x1b[${eraseUp}A`;
    out += `\r\x1b[J`;
    // 確定行の出力。ライブブロックの上端を越えそうなら先にスクロールして確定させる。
    const streamBottom = Math.max(1, rows - liveCount);
    let r = streamRow;
    for (const line of stream) {
      if (r > streamBottom) {
        const scrolls = Math.min(r - streamBottom, rows);
        out += `\x1b[${rows};1H` + '\n'.repeat(scrolls);
        r -= scrolls;
      }
      out += `\x1b[${r};1H\x1b[K${marginPrefix}${line}\r\n`;
      r++;
    }
    this.streamRow = Math.max(1, Math.min(rows, r));
    // ライブブロックは常に最下段。入る余白がなければ不足分行をスクロールして空ける。
    const liveStart = Math.max(1, rows - liveCount + 1);
    if (liveStart < this.streamRow) {
      const scrolls = Math.min(rows, this.streamRow - liveStart);
      out += `\x1b[${rows};1H` + '\n'.repeat(scrolls);
      this.streamRow -= scrolls;
    }
    for (let i = 0; i < liveCount; i++) {
      out += `\x1b[${liveStart + i};1H\x1b[K${body[i]}` + (i === liveCount - 1 ? '' : '\r\n');
    }
    const cursorLiveRow = Math.min(rows, liveStart + editorStartIdx + (cursor.row - this.editorScroll));
    const cursorCol = Math.min(this.columns(), paintMargin + 3 + cursor.column);
    out += `\x1b[${cursorLiveRow};${cursorCol}H` + (this.pending ? '\x1b[?25h' : '\x1b[?25l');
    this.cursorRow = cursorLiveRow;
    this.output.write(out);
  };

  /** 未完了行の色分け用に、完成行までの状態を複製する。 */
  private fork(): TranscriptColorizer {
    const clone = new TranscriptColorizer();
    clone.restore(this.colorizerState);
    return clone;
  }

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.clipboardTask?.abort(); this.clipboardTask = undefined;
    this.images = [];
    this.pending?.finish(null);
    this.input.removeListener('keypress', this.keypress);
    this.input.removeListener('end', this.onEnd);
    this.output.removeListener('resize', this.onResize);
    process.removeListener('exit', this.close);
    this.input.setRawMode(this.previousRaw);
    this.input.pause();
    // 入力欄(ライブブロック)を消して、シェルのプロンプトが新しい行に出るようにする。
    const rows = this.rows();
    const eraseRow = Math.min(rows, this.streamRow >= 1 ? this.streamRow : rows);
    const base = Math.max(1, Math.min(rows, this.cursorRow >= 1 ? this.cursorRow : rows));
    const up = base - eraseRow;
    if (up > 0) this.output.write(`\x1b[${up}A`);
    this.output.write('\r\x1b[J');
    this.output.write('\x1b[0m\x1b[?25h\x1b[?2004l\r\n');
  };
}
export function createTerminal(cwd: string): ChatTerminal {
  return process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb' && process.env.DKH_PLAIN !== '1'
    ? new TerminalUI(cwd) : new PlainTerminal();
}
