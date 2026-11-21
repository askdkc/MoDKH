import { emitKeypressEvents, type Key } from 'node:readline';
import { activeFileMention, fileCandidates, formatFileMention, type FileCandidate, type FileMention } from './file-mentions.ts';
import { isPdfPathPrefix } from './pdf.ts';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { TerminalMouseInput, type MouseReport } from './terminal-mouse.ts';
import { reflowTranscript, selectedTranscript, transcriptLine, transcriptLines, type DragSelection, type TranscriptScreenLine } from './transcript-selection.ts';
import { EMPTY_USAGE, USAGE_HEADING, usageFooter, usageBadgeLine, usageBreakdownLines, type UsageTotals } from './usage.ts';
import { chars, clean, fitText, textWidth, wrap, wrapText, editorLayout, verticalCursor, lineEdge } from './editor.ts';
export { textWidth, fitText } from './editor.ts';
import { readClipboardImage, writeClipboardText, type ClipboardReader } from './clipboard.ts';
import { MAX_CLIPBOARD_IMAGES, parseImage, type ImageAttachment } from '../agent/images.ts';
import type { ReadStream, WriteStream } from 'node:tty';
import { LineSource } from './lines.ts';
import { WHALE_FRAME_MS, whaleRow } from './waiting-whales.ts';
import type { SubagentActivity } from '../subagents/service.ts';
import type { RunningServer } from '../language/lsp/pool.ts';
import {
  TranscriptColorizer,
  classifyBackground,
  parseOscBackground,
  paletteFor,
  READABLE_TEXT_STYLE,
  type ColorizerState,
  type Palette,
  type TranscriptKind,
} from './color.ts';

/** `pinned` rows stay on top and are never filtered away; they are actions, not selections. */
export interface Choice { value: string; label: string; detail?: string; pinned?: boolean }
export interface FollowupDraft { text: string; images: ImageAttachment[] }
type FollowupSubmit = (text: string, images: ImageAttachment[]) => string | null;
export interface ChatTerminal {
  readonly interactive: boolean;
  readonly imageCount?: number;
  takeImages?(): ImageAttachment[];
  write(text: string, kind?: TranscriptKind): void;
  next(signal?: AbortSignal): Promise<string | null>;
  unread(line: string): void;
  /** Restore a failed submission as editable text, without resubmitting it. */
  restoreDraft?(text: string): void;
  /** Offer text via Up without populating the empty composer. */
  rememberInput?(text: string): void;
  ask(title: string, signal?: AbortSignal, secret?: boolean): Promise<string | null>;
  confirm(title: string, signal?: AbortSignal): Promise<string | null>;
  choose(title: string, choices: readonly Choice[], query?: string): Promise<string | null>;
  /** Show a read-only page, returning when it is dismissed (or printed in line mode). */
  showPage(title: string, text: string): Promise<void>;
  setModel(model: string | null): void;
  setActivity?(activity: string | null, placement?: 'hint'): void;
  setTurnToolCount?(count: number): void;
  setAnimation?(enabled: boolean): void;
  /** Return an error to keep the draft, or null to accept it. */
  beginFollowups?(submit: FollowupSubmit): (unsent: FollowupDraft[]) => void;
  setSubagent?(activity: SubagentActivity | null, delegationCount: number): void;
  setUsage?(usage: UsageTotals): void;
  /** Running language servers; shown in the side pane next to usage and subagent status. */
  setServers?(servers: readonly RunningServer[]): void;
  setMcpServers?(ids: readonly string[]): void;
  /** Whether a browse call is driving the browser right now; shown in the same pane. */
  setBrowse?(active: boolean): void;
  /** Live reasoning text; `null` flushes it into the transcript. Display only, never a message. */
  setReasoning?(delta: string | null): void;
  close(): void;
}
const APPROVAL_CHOICES: readonly Choice[] = [{ value: 'n', label: '拒否' }, { value: 'y', label: '承認' }];

export const COMMANDS: readonly Choice[] = [
  { value: '/connect', label: '/connect', detail: 'プロバイダーに接続' },
  { value: '/models', label: '/models', detail: 'モデルを選択' },
  { value: '/reasoning', label: '/reasoning', detail: '推論レベル (off/minimal/low/medium/high/max)' },
  { value: '/annimation', label: '/annimation', detail: '待機アニメーション (on/off)' },
  { value: '/agents', label: '/agents', detail: '子の一覧・委譲・同時実行数' },
  { value: '/usage', label: '/usage', detail: 'トークン使用量の内訳' },
  { value: '/pdf', label: '/pdf', detail: 'PDFの本文と画像を送る · /pdf パス | 依頼文' },
  { value: '/tools', label: '/tools', detail: 'ツール履歴 · /tools <番号> で全文' },
  { value: '/allow', label: '/allow', detail: '承認ポリシー (all / workspace / none)' },
  { value: '/keys', label: '/keys', detail: '保存済みAPIキー' },
  { value: '/help', label: '/help', detail: '操作ガイド' },
  { value: '/exit', label: '/exit', detail: '終了' },
];

function isChatCommand(text: string): boolean {
  if (text.includes('\n')) return false;
  const command = text.trim().split(/\s+/, 1)[0];
  return command === '/quit' || command === '/head' || COMMANDS.some(choice => choice.value === command);
}

const LOGO = [
  '███╗   ███╗        ██████╗  ██╗  ██╗ ██╗  ██╗',
  '████╗ ████║        ██╔══██╗ ██║ ██╔╝ ██║  ██║',
  '██╔████╔██║ ████╗  ██║  ██║ █████╔╝  ███████║',
  '██║╚██╔╝██║██╔═██╗ ██║  ██║ ██╔═██╗  ██╔══██║',
  '██║ ╚═╝ ██║╚████╔╝ ██████╔╝ ██║  ██╗ ██║  ██║',
  '╚═╝     ╚═╝ ╚═══╝  ╚═════╝  ╚═╝  ╚═╝ ╚═╝  ╚═╝',
];
const logoForWidth = (width: number): readonly string[] =>
  width >= Math.max(...LOGO.map(textWidth)) ? LOGO : ['MoDKH'];
const ACCENT = '34'; // Use the terminal theme's blue; NO_COLOR is respected by paint().
/** The composer sits on a painted panel, so the theme blue can sink into it (dark) or glare (light). */
const PANEL_ACCENT: Record<'dark' | 'light', string> = { dark: '38;5;117', light: '38;5;25' };
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
  showPage(title: string, text: string): Promise<void> {
    this.write(`${title}\n\n${text}\n`);
    return Promise.resolve();
  }
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
  /** Line mode has no pane, so only a start is announced; the same id is never repeated. */
  private announcedServers = new Set<string>();
  setServers(servers: readonly RunningServer[]): void {
    for (const server of servers) {
      if (this.announcedServers.has(server.id)) continue;
      this.announcedServers.add(server.id);
      this.write(`\n(言語サーバー: ${server.id} 起動)\n`);
    }
  }
  private browseAnnounced = false;
  /** Line mode has no pane; announce each transition so piped runs stay observable. */
  setBrowse(active: boolean): void {
    if (this.browseAnnounced === active) return;
    this.browseAnnounced = active;
    this.write(active ? `\n(${BROWSE_ACTIVE_LABEL})\n` : '\n(browse 終了)\n');
  }
  close(): void { this.lines.close(); }
  ask(title: string, signal?: AbortSignal): Promise<string | null> { this.write(`${title}\n`); return this.next(signal); }
  confirm(title: string, signal?: AbortSignal): Promise<string | null> { return this.ask(title + ' [y/N]', signal); }
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
export interface TerminalOptions {
  readClipboardImage?: ClipboardReader;
  writeClipboardText?: typeof writeClipboardText;
}
const MAX_INPUT_BYTES = 128 * 1024;
const SIDEBAR_WIDTH = 36;

function serverRow(server: RunningServer, workspace: string): string {
  const relative = path.relative(workspace, server.root);
  const outside = path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
  const root = clean(outside ? server.root : relative || path.basename(server.root) || server.root).replace(/[\r\n\t]/g, ' ');
  const label = `${server.id} · `;
  const room = SIDEBAR_WIDTH - 4 - textWidth(label);
  if (textWidth(root) <= room) return label + root;
  // Keep the distinguishing end of long roots visible within the sidebar.
  let suffix = '';
  for (const char of chars(root).reverse()) {
    if (textWidth(char + suffix) >= room) break;
    suffix = char + suffix;
  }
  return `${label}…${suffix}`;
}
/** At most this many language servers are listed; the rest are counted, never silently dropped. */
const SIDEBAR_SERVER_ROWS = 3;
const SERVERS_HEADING = '言語サーバー';
/** 右欄に出す browse 実行中の表示。行全体がこの文字列になる。 */
const BROWSE_ACTIVE_LABEL = 'browse in use';
const SUBAGENTS_HEADING = 'サブエージェント';
const TRANSCRIPT_HISTORY_ROWS = 4000;
/**
 * メインスクリーンに流し込むストリーミングUI。
 * - 完成したトランスクリプト行は一度だけ出力し、その後は端末のスクロールバックへ流れる
 * - 起動時はロゴと入力欄を中央にまとめ、会話開始後は入力欄を最下部に描画する
 * 通常はメインスクリーンを使う。マウス操作で履歴を開く間だけ別画面に切り替える。
 */
export class TerminalUI implements ChatTerminal {
  readonly interactive = true;
  private text = '';
  private cursor = 0;
  private selection = 0;
  private pending?: Pending;
  private queued: string[] = [];
  /** 描画を待っている、折り返し前の論理行。 */
  private queue: { text: string; kind: TranscriptKind }[] = [];
  private transcriptRows = new Map<number, TranscriptScreenLine>();
  private liveTranscriptRows = new Map<number, TranscriptScreenLine>();
  private drag?: DragSelection;
  private selectionRows: number[] = [];
  private readonly mouseInput?: TerminalMouseInput;
  private readonly keyInput?: PassThrough;
  private readonly copyText: typeof writeClipboardText;
  private copyQueue = Promise.resolve();
  private historyRows: TranscriptScreenLine[] = [];
  private history?: { source: TranscriptScreenLine[]; width: number; lines: TranscriptScreenLine[]; offset: number; rows: Map<number, TranscriptScreenLine> };
  private page?: { title: string; text: string; width: number; lines: string[]; top: number; pasting: boolean; resolve: () => void };
  /** まだ改行が来ていない最終行。ライブブロックの一部として再描画する。 */
  private partial = '';
  private partialKind: TranscriptKind = 'system';
  private started = false;
  private usageVisible = false;
  private delegationCount = 0;
  private sidebarPainted = false;
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
  private activityPlacement?: 'hint';
  private followup?: FollowupSubmit;
  private subagent: SubagentActivity | null = null;
  private subagentStarted = 0;
  private activityStarted = 0;
  private progressTimer?: NodeJS.Timeout;
  private usage: UsageTotals | null = null;
  /** Running language servers, refreshed by the owner; null means nothing is running. */
  private servers: readonly RunningServer[] = [];
  private mcpRows: string[] = [];
  setMcpServers(ids: readonly string[]): void {
    const rows = ids.length ? [`MCP ${ids.length}接続中`, ...ids.slice(0, SIDEBAR_SERVER_ROWS).map(id => id.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?'))] : [];
    if (ids.length > SIDEBAR_SERVER_ROWS) rows.push(`ほか${ids.length - SIDEBAR_SERVER_ROWS}件`);
    if (this.closed || (rows.length === this.mcpRows.length && rows.every((row, i) => row === this.mcpRows[i]))) return;
    this.mcpRows = rows;
    this.render();
  }
  /** True while a browse call is driving the browser. Display only. */
  private browse = false;
  private closed = false;
  private paste = false;
  private pasteBuffer = '';
  private pasteBytes = 0;
  private previousInput = '';
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
  private colorizerState: ColorizerState = { mode: 'text', inDiff: false, inToolOutput: false };
  private palette: Palette = paletteFor('dark');
  private panelStyle = '48;5;235';
  /** Foreground for text drawn on `panelStyle`; keeps the status line readable on both themes. */
  private panelAccent = PANEL_ACCENT.dark;
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
    this.copyText = options.writeClipboardText ?? writeClipboardText;
    this.cwd = cwd; this.input = input; this.output = output;
    this.previousRaw = input.isRaw; this.color = process.env.NO_COLOR === undefined;
    // 背景プローブの data 購読を readline より先に付ける。返信チャンクからだけ
    // キー入力を落とし、ユーザーの打鍵はいつでも通常通り処理する。
    if (this.color && (input as unknown as { isTTY?: boolean }).isTTY === true) this.probeBackground();
    if (options.writeClipboardText || (process.platform === 'darwin' && input.isTTY && output.isTTY)) {
      const keyInput = this.keyInput = new PassThrough();
      this.mouseInput = new TerminalMouseInput(
        text => { if (text) keyInput.write(text); },
        this.mouseReport,
        () => this.paste || this.replySilenced,
      );
      emitKeypressEvents(keyInput);
      keyInput.on('keypress', this.keypress);
      input.on('data', this.mouseInput.write);
    } else emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', this.keypress);
    input.on('end', this.onEnd);
    output.on('resize', this.onResize);
    process.on('exit', this.close);
    input.resume();
    output.write('\x1b[?2004h' + (this.mouseInput ? '\x1b[?1002h\x1b[?1006h' : ''));
    // 起動時は一度だけ画面を消す(前回実行の残りを見せない)。
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
      if (classified !== null) {
        this.palette = paletteFor(classified);
        this.panelStyle = classified === 'light' ? '48;5;255' : '48;5;235';
        this.panelAccent = PANEL_ACCENT[classified];
        this.render();
      }
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
    this.cancelDrag();
    this.clearPending = true;
    this.streamRow = 1;
    this.cursorRow = 1;
    if (this.page) this.renderPage();
    else if (this.history) this.renderHistory();
    else this.render();
  };

  private columns(): number { return Math.max(12, this.output.columns || 80); }
  private rows(): number { return Math.max(6, this.output.rows || 24); }

  /** 会話中は左ペイン、起動時は中央寄せ用に80列まで。 */
  private width(): number {
    const columns = this.columns();
    if (!this.started) return Math.max(8, Math.min(columns - 2, 80));
    return this.hasUsagePane() ? columns - SIDEBAR_WIDTH - 2 : columns;
  }

  write(text: string, kind: TranscriptKind = 'system'): void { this.appendTranscript(text, kind); this.render(); }
  setModel(model: string | null): void { this.model = model; this.render(); }
  setActivity(activity: string | null, placement?: 'hint'): void {
    if (this.closed || (this.activity === activity && this.activityPlacement === placement)) return;
    this.activity = activity;
    this.activityPlacement = placement;
    this.activityStarted = performance.now();
    this.updateProgressTimer();
    this.render();
  }

  private activityLabel(): string | null {
    if (!this.activity) return null;
    const seconds = Math.floor((performance.now() - this.activityStarted) / 1000);
    return `${this.activity} · ${seconds}秒`;
  }

  private animationEnabled = process.env.MODKH_NO_ANIMATION !== '1';
  setAnimation(enabled: boolean): void { this.animationEnabled = enabled; this.render(); }

  private updateProgressTimer(): void {
    clearInterval(this.progressTimer);
    this.progressTimer = this.activity || this.subagent ? setInterval(() => this.render(), 1000).unref() : undefined;
  }
  beginFollowups(submit: FollowupSubmit): (unsent: FollowupDraft[]) => void {
    this.followup = submit;
    this.render();
    return unsent => {
      if (this.followup !== submit) return;
      this.followup = undefined;
      this.clipboardTask?.abort(); this.clipboardTask = undefined;
      if (unsent.length) {
        this.images = [...unsent.flatMap(item => item.images), ...this.images];
        this.text = [...unsent.map(item => item.text), this.text].filter(Boolean).join('\n\n');
        this.cursor = chars(this.text).length;
        this.write('\n(送信待ちだった追加の依頼を入力欄に戻しました)\n');
      }
      this.render();
    };
  }

  private sendFollowup(): void {
    if ((!this.text.trim() && !this.images.length) || !this.followup) return;
    const error = isChatCommand(this.text) ? 'スラッシュコマンドは応答完了後に使えます' : this.followup(this.text, this.images.slice());
    this.inputNotice = error ?? '追加の依頼を受け付けました';
    if (error === null) {
      this.images = [];
      this.previousInput = this.text;
      this.text = ''; this.cursor = 0; this.editorScroll = 0;
    }
  }

  private hasUsagePane(): boolean {
    return this.usageVisible && this.columns() >= 80 && this.rows() >= 9;
  }

  private controlMargin(): number {
    return this.started ? 0 : Math.floor((this.columns() - this.width()) / 2);
  }

  private controlWidth(): number {
    return this.width();
  }

  private editorWidth(): number {
    return Math.max(5, this.controlWidth() - 3);
  }

  setSubagent(activity: SubagentActivity | null, delegationCount: number): void {
    if (this.closed || (this.delegationCount === delegationCount && this.subagent?.phase === activity?.phase &&
      this.subagent?.pluginId === activity?.pluginId && this.subagent?.task === activity?.task)) return;
    this.delegationCount = delegationCount;
    if (activity && !this.subagent) {
      this.subagentStarted = performance.now();
    }
    this.subagent = activity;
    this.updateProgressTimer();
    this.render();
  }
  setUsage(usage: UsageTotals): void { this.usage = usage; this.render(); }
  /** Browse activity is display state; the browser itself is never started from here. */
  setBrowse(active: boolean): void {
    if (this.closed || this.browse === active) return;
    this.browse = active;
    this.render();
  }
  /** Re-render only when the list actually changed; the owner polls this during analysis. */
  setServers(servers: readonly RunningServer[]): void {
    const same = this.servers.length === servers.length &&
      this.servers.every((server, index) => server.id === servers[index]?.id && server.root === servers[index]?.root);
    if (same) return;
    this.servers = servers;
    this.render();
  }
  /** Accumulate one reasoning delta, or flush the finished block into the transcript with `null`. */
  setReasoning(delta: string | null): void {
    if (delta !== null) { this.reasoning = (this.reasoning + delta).slice(-20_000); this.render(); return; }
    const text = this.reasoning.trimEnd();
    this.reasoning = '';
    if (text) this.appendTranscript(`\n(推論)\n${text}\n`, 'reasoning');
    this.render();
  }
  unread(line: string): void { this.queued.unshift(line); }
  rememberInput(text: string): void { this.previousInput = text; }
  restoreDraft(text: string): void {
    this.text = text;
    this.cursor = chars(text).length;
    this.render();
  }
  get imageCount(): number { return this.images.length; }
  takeImages(): ImageAttachment[] { const images = this.images; this.images = []; this.render(); return images; }
  next(signal?: AbortSignal): Promise<string | null> { return this.wait('何を調べますか？ / でコマンド', undefined, '', signal, false, true); }
  ask(title: string, signal?: AbortSignal, secret = false): Promise<string | null> { return this.wait(title, undefined, '', signal, secret); }
  confirm(title: string, signal?: AbortSignal): Promise<string | null> { return this.wait(title, APPROVAL_CHOICES, '', signal); }
  choose(title: string, choices: readonly Choice[], query = ''): Promise<string | null> { return this.wait(title, choices, query); }
  showPage(title: string, text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.page || this.pending || this.followup) throw new Error('端末の入力待ちは同時に1件だけです');
    this.leaveHistory(false);
    this.cancelDrag();
    return new Promise(resolve => {
      this.page = { title, text, top: 0, width: 0, lines: [], pasting: false, resolve };
      this.output.write('\x1b[?1049h\x1b[?25l');
      this.renderPage();
    });
  }

  private wait(title: string, choices?: readonly Choice[], query = '', signal?: AbortSignal, secret = false, composer = false): Promise<string | null> {
    if (signal?.aborted || this.closed) return Promise.resolve(null);
    if (this.page || this.pending) throw new Error('端末の入力待ちは同時に1件だけです');
    if (choices !== APPROVAL_CHOICES && this.queued.length) return Promise.resolve(this.queued.shift()!);
    if (!composer) this.leaveHistory();
    const draft = !composer && this.text
      ? { text: this.text, cursor: this.cursor, scroll: this.editorScroll, notice: this.inputNotice } : undefined;
    this.text = composer ? this.text : query;
    this.cursor = composer ? this.cursor : chars(query).length;
    this.selection = 0; this.hiddenCompletion = false;
    this.editorScroll = 0; this.inputNotice = '';
    return new Promise(resolve => {
      const abort = () => finish(null);
      const finish = (value: string | null) => {
        signal?.removeEventListener('abort', abort);
        this.clipboardTask?.abort(); this.clipboardTask = undefined;
        this.paste = false; this.pasteBuffer = ''; this.pasteBytes = 0;
        if (composer && (value?.trim() || (value !== null && this.images.length))) {
          this.started = true; // Leave the welcome screen before submission validation writes feedback.
          if (value?.trim() && !isChatCommand(value)) this.previousInput = value;
        }
        if (value === null && composer) this.images = [];
        this.pending = undefined;
        this.text = draft?.text ?? ''; this.cursor = draft?.cursor ?? 0;
        this.editorScroll = draft?.scroll ?? 0; this.inputNotice = draft?.notice ?? '';
        this.render(); resolve(value);
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
    if (this.pending && !this.hiddenCompletion && this.text.startsWith('/') && !(/\s/.test(this.text))) return matching(COMMANDS, this.text);
    return undefined;
  }
  private fileMenu?: { text: string; cursor: number; mention: FileMention; candidates: FileCandidate[]; selected: number; dismissed: boolean };

  private fileOptions() {
    if (!(this.pending ? this.pending.composer && !this.pending.secret : this.followup)) {
      this.fileMenu = undefined;
      return undefined;
    }
    if (this.fileMenu?.text !== this.text || this.fileMenu.cursor !== this.cursor) {
      const mention = activeFileMention(this.text, chars(this.text).slice(0, this.cursor).join('').length);
      const pdfPath = mention && !this.text.includes('\n') && isPdfPathPrefix(this.text.slice(0, mention.start));
      this.fileMenu = mention ? { text: this.text, cursor: this.cursor, mention,
        candidates: fileCandidates(this.cwd, mention.query, pdfPath ? name => /\.pdf$/i.test(name) : undefined),
        selected: 0, dismissed: false } : undefined;
    }
    return this.fileMenu?.dismissed ? undefined : this.fileMenu;
  }

  private completeFile(mention: FileMention, candidate: FileCandidate): void {
    const reference = formatFileMention(candidate.path);
    const rest = this.text.slice(mention.end);
    const separator = !candidate.directory && !/^\s/u.test(rest) ? ' ' : '';
    const prefix = this.text.slice(0, mention.start) + reference + separator;
    if (Buffer.byteLength(prefix + rest) > MAX_INPUT_BYTES) { this.inputNotice = '入力は128 KiB以内にしてください'; return; }
    this.text = prefix + rest;
    this.cursor = chars(prefix).length - (candidate.directory && reference.startsWith('@"') ? 1 : 0);
    this.fileMenu = undefined;
    this.inputNotice = '';
  }

  private insertText(value: string): void {
    if (this.pending?.choices === APPROVAL_CHOICES || this.replySilenced) return; // OSC 返信の取り込みを入力にしない
    const normalized = clean(value.replace(/\r\n?/g, '\n').replace(/\t/g, '  '));
    const added = chars((this.pending?.composer || (!this.pending && this.followup)) ? normalized : normalized.replace(/\n/g, ' '));
    const parts = chars(this.text);
    const next = parts.slice(0, this.cursor).concat(added, parts.slice(this.cursor)).join('');
    if (Buffer.byteLength(next) > MAX_INPUT_BYTES) { this.inputNotice = '入力は128 KiB以内にしてください'; return; }
    this.text = next; this.cursor += added.length;
    this.selection = 0; this.hiddenCompletion = false; this.inputNotice = '';
  }
  private async pasteImage(): Promise<void> {
    const pending = this.pending;
    if ((pending ? !pending.composer || pending.secret : !this.followup) || this.clipboardTask) return;
    if (this.images.length >= MAX_CLIPBOARD_IMAGES) { this.inputNotice = `添付画像は最大${MAX_CLIPBOARD_IMAGES}枚です`; this.render(); return; }
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
  private mouseReport = ({ button, released, ...point }: MouseReport): void => {
    if (this.pending?.secret) return;
    if (!released && (button === 64 || button === 65)) {
      const delta = button === 64 ? -3 : 3;
      if (this.page) this.renderPage(delta);
      else this.scrollHistory(-delta);
      return;
    }
    if (this.page) return;
    if (point.row < 1 || point.row > this.rows() || point.column < 1) return;
    const rows = this.visibleTranscript();
    if (!released && button === 0) {
      // Some terminals repeat the press immediately before the release.
      if (!this.drag && rows.has(point.row) && point.column <= this.width()) {
        this.drag = { anchor: point, end: point };
      }
      return;
    }
    const drag = this.drag;
    if (!drag || (released ? button !== 0 : button !== 32)) return;
    drag.end = point;
    if (!released) {
      this.output.write(this.clearDragHighlight() + this.drawDragHighlight());
      return;
    }
    const moved = drag.anchor.row !== point.row || drag.anchor.column !== point.column;
    const text = moved ? selectedTranscript(rows, drag).map(line => line.text + (line.newline ? '\n' : '')).join('') : '';
    this.cancelDrag();
    this.render();
    if (text.trim()) this.copyQueue = this.copyQueue.then(() => this.copySelection(text));
  };

  private visibleTranscript(): Map<number, TranscriptScreenLine> {
    return this.history?.rows ?? new Map([...this.transcriptRows, ...this.liveTranscriptRows]);
  }

  private drawDragHighlight(): string {
    if (!this.drag) return '';
    const lines = selectedTranscript(this.visibleTranscript(), this.drag).filter(line => line.text);
    this.selectionRows = lines.map(line => line.row);
    return lines.length ? '\x1b7' + lines.map(line => `\x1b[${line.row};${line.column}H\x1b[7m${line.text}\x1b[0m`).join('') + '\x1b8' : '';
  }

  private clearDragHighlight(): string {
    if (!this.selectionRows.length) return '';
    const rows = this.visibleTranscript();
    const restore = this.selectionRows.map(row => `\x1b[${row};1H${rows.get(row)?.painted ?? ''}`).join('');
    this.selectionRows = [];
    return '\x1b7' + restore + '\x1b8';
  }

  private cancelDrag(): void {
    const restore = this.clearDragHighlight();
    if (restore) this.output.write(restore);
    this.drag = undefined;
  }

  private async copySelection(text: string): Promise<void> {
    if (this.closed) return;
    try {
      await this.copyText(text);
      this.inputNotice = '選択範囲をコピーしました';
    } catch {
      this.inputNotice = '選択範囲をコピーできませんでした';
    } finally {
      if (this.history) this.renderHistory();
      else this.render();
    }
  }

  private scrollTranscriptRows(count: number): void {
    this.drag = undefined;
    const visible = new Map<number, TranscriptScreenLine>();
    for (const [row, line] of this.transcriptRows) {
      if (row > count) visible.set(row - count, line);
      else if (this.mouseInput) this.historyRows.push(line);
    }
    this.transcriptRows = visible;
    if (this.historyRows.length > TRANSCRIPT_HISTORY_ROWS) {
      this.historyRows.splice(0, this.historyRows.length - TRANSCRIPT_HISTORY_ROWS);
    }
  }

  private scrollHistory(delta: number): void {
    if (!this.started) return;
    this.cancelDrag();
    if (!this.history) {
      if (delta < 0 || !this.historyRows.length) return;
      const source = [...this.historyRows, ...this.visibleTranscript().values()];
      this.history = { source, width: 0, lines: [], offset: 0, rows: new Map() };
      this.inputNotice = '';
      this.output.write('\x1b[?1049h\x1b[?25l');
    }
    this.history.offset = Math.max(0, this.history.offset + delta);
    if (this.history.offset) this.renderHistory();
    else this.leaveHistory();
  }

  private renderHistory(): void {
    const history = this.history;
    if (!history) return;
    const rows = this.rows();
    const width = this.width();
    if (history.width !== width) {
      history.width = width;
      history.lines = reflowTranscript(history.source, width);
    }
    const transcript = history.lines;
    const bodyRows = rows - 1;
    history.offset = Math.min(history.offset, Math.max(1, transcript.length - bodyRows));
    const end = Math.max(0, transcript.length - history.offset);
    const visible = transcript.slice(Math.max(0, end - bodyRows), end);
    let out = this.clearDragHighlight() + '\x1b[H\x1b[J';
    history.rows.clear();
    visible.forEach((line, index) => {
      history.rows.set(index + 1, line);
      out += `\x1b[${index + 1};1H${line.painted}`;
    });
    const hint = 'MoDKH · 会話履歴 · Esc 戻る';
    const details = this.inputNotice || this.activityLabel() || 'ホイール / PgUp / PgDn';
    const footer = fitText(`${hint} · ${details}`, width);
    out += `\x1b[${rows};1H${this.paint(footer, `${this.panelStyle};${this.panelAccent}`)}`;
    if (this.hasUsagePane()) {
      const usage = usageBreakdownLines(this.usage ?? EMPTY_USAGE, SIDEBAR_WIDTH - 4);
      out += this.drawSidebar(rows, this.columns(), this.sidebarLines(rows, usage));
    }
    this.output.write(out + this.drawDragHighlight());
  }

  private leaveHistory(redraw = true): void {
    if (!this.history) return;
    this.cancelDrag();
    this.history = undefined;
    this.output.write('\x1b[?1049l');
    if (redraw) this.render();
  }

  private renderPage(delta = 0): void {
    const page = this.page;
    if (!page) return;
    const rows = this.rows();
    const width = this.columns() - 1; // Avoid autowrap at the right margin.
    if (page.width !== width) {
      page.width = width;
      page.lines = wrapText(page.text, width);
    }
    const bodyRows = rows - 3;
    page.top = Math.max(0, Math.min(page.top + delta, page.lines.length - bodyRows));
    const visible = page.lines.slice(page.top, page.top + bodyRows);
    const heading = this.paint(fitText(page.title, width), '1');
    const hints = fitText('Esc/q 戻る  ↑↓ 行  PgUp/PgDn ページ', width);
    const position = fitText(`${page.top + 1}–${page.top + visible.length} / ${page.lines.length}`, width);
    this.output.write(`\x1b[H\x1b[J${heading}` +
      visible.map((line, i) => `\x1b[${i + 2};1H${line}`).join('') +
      `\x1b[${rows - 1};1H${position}\x1b[${rows};1H${hints}`);
  }

  private dismissPage(): void {
    const page = this.page;
    if (!page) return;
    this.page = undefined;
    this.output.write('\x1b[?1049l\x1b[?25h');
    page.resolve();
  }

  private pageKey(key: Key): void {
    const page = this.page;
    if (!page || this.replySilenced) return;
    if (key.name === 'paste-start' || key.name === 'paste-end') {
      page.pasting = key.name === 'paste-start';
      return;
    }
    if (page.pasting) return;
    if (key.name === 'escape' || (key.name === 'q' && !key.ctrl && !key.meta) || (key.ctrl && key.name === 'c')) {
      this.dismissPage();
      return;
    }
    const step = this.rows() - 4; // Leave one line of context between pages.
    switch (key.name) {
      case 'up': this.renderPage(-1); break;
      case 'down': this.renderPage(1); break;
      case 'pageup': this.renderPage(-step); break;
      case 'pagedown': case 'space': this.renderPage(step); break;
      case 'home': this.renderPage(-page.top); break;
      case 'end': this.renderPage(page.lines.length); break;
    }
  }

  private onEnd = (): void => { this.pending?.finish(null); this.close(); };
  private keypress = (value: string | undefined, key: Key): void => {
    if (this.page) { this.pageKey(key); return; }
    if (this.drag) {
      this.cancelDrag();
      this.render();
    }
    if (this.mouseInput && !this.paste && !this.replySilenced && !this.pending?.secret &&
        (key.name === 'pageup' || key.name === 'pagedown')) {
      this.scrollHistory((this.rows() - 2) * (key.name === 'pageup' ? 1 : -1));
      return;
    }
    if (this.history) {
      this.leaveHistory();
      if (key.name === 'escape') return;
    }
    if (key.name === 'paste-start') { this.paste = true; this.pasteBuffer = ''; this.pasteBytes = 0; return; }
    if (key.name === 'paste-end') {
      this.paste = false;
      if ((this.pending || this.followup) && this.pasteBytes <= MAX_INPUT_BYTES) this.insertText(this.pasteBuffer);
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
    const pending = this.pending;
    if (!pending && !this.followup) return;
    const composer = pending ? pending.composer : true;
    if (key.ctrl && key.name === 'v') { void this.pasteImage(); return; }
    if (key.ctrl && key.name === 'x' && composer) {
      this.clipboardTask?.abort(); this.clipboardTask = undefined;
      this.images.pop(); this.inputNotice = ''; this.render(); return;
    }
    const options = this.options();
    const files = this.fileOptions();
    if (key.name === 'escape' || key.ctrl && key.name === 'd') {
      if (pending?.choices) pending.finish(null);
      else if (files && key.name === 'escape') { files.dismissed = true; this.render(); }
      else if (options?.length && key.name === 'escape') { this.hiddenCompletion = true; this.render(); }
      else if (!this.text && key.ctrl) pending?.finish(null);
      return;
    }
    const newline = composer && (value === '\n' || key.ctrl && key.name === 'j' || (key.name === 'return' || key.name === 'enter') && (key.shift || key.meta));
    if (newline) this.insertText('\n');
    else if (options && (key.name === 'up' || key.name === 'down')) {
      this.selection = options.length ? (this.selection + (key.name === 'down' ? 1 : -1) + options.length) % options.length : 0;
    } else if (files?.candidates.length && (key.name === 'up' || key.name === 'down')) {
      const count = files.candidates.length;
      files.selected = (files.selected + (key.name === 'down' ? 1 : -1) + count) % count;
    } else if (composer && key.name === 'up' && !this.text && this.previousInput) {
      this.text = this.previousInput;
      this.cursor = chars(this.text).length;
      this.hiddenCompletion = true;
      this.inputNotice = '';
    } else if (composer && (key.name === 'up' || key.name === 'down')) {
      this.cursor = verticalCursor(this.text, this.cursor, this.editorWidth(), key.name === 'up' ? -1 : 1);
    } else if (key.name === 'return' || key.name === 'enter' || key.name === 'tab') {
      if (this.clipboardTask) { this.inputNotice = '画像の読込中です。完了後にEnterで送信'; this.render(); return; }
      const selected = options?.[this.selection];
      if (key.name === 'tab') {
        const candidate = files?.candidates[files.selected];
        if (files && candidate) this.completeFile(files.mention, candidate);
        else if (selected && !pending?.choices) { this.text = selected.value; this.cursor = chars(this.text).length; }
      } else if (pending?.choices) { if (selected) pending.finish(selected.value); }
      else if (pending) pending.finish(selected?.value ?? this.text);
      else this.sendFollowup();
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
   * トランスクリプトへ追記する。完成行を出力待ちキューへ。装飾と折り返しは描画時に行う。
   * 会話の始まり(`▶`)を検出したら、それ以降の行を広めの幅で折り返す。
   */
  private appendTranscript(text: string, kind: TranscriptKind): void {
    let source = (this.partial + text).replace(/\r\n?/g, '\n');
    let lineKind = this.partial ? this.partialKind : kind;
    if (kind === 'user') this.usageVisible = true;
    if (kind === 'user' || /(^|\n)▶/.test(text) || /https:\/\//.test(text)) this.started = true;
    for (;;) {
      const at = source.indexOf('\n');
      if (at < 0) {
        this.partial = source;
        this.partialKind = lineKind;
        break;
      }
      const logicalLine = source.slice(0, at);
      source = source.slice(at + 1);
      // 会話が始まる前の案内行はウェルカムブロックへ(会話開始時に一括で出力する)。
      if (!this.started) this.bootLines.push(logicalLine);
      else this.queue.push({ text: logicalLine, kind: lineKind });
      lineKind = kind;
    }
  }

  private renderTranscriptLine(raw: string, kind: TranscriptKind, width: number, newline: boolean,
    colorizer: TranscriptColorizer): TranscriptScreenLine[] {
    const source = clean(raw);
    const colored = colorizer.line(source, this.palette, kind);
    const text = clean(colored);
    if (kind === 'answer' && source && !text) return [];
    if (kind === 'user') {
      return transcriptLine(text, width, newline).map(line => {
        const padded = line.text.padEnd(line.text.length + width - textWidth(line.text));
        const painted = this.color && line.text ? this.paint(padded, `${this.panelStyle};${this.palette.user}`) : line.text;
        return { ...line, painted };
      });
    }
    return reflowTranscript([{ text, painted: this.color ? colored : text, newline }], width);
  }

  private paint(text: string, code: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }

  /**
   * 1フレームの描画。
   * 1) 前回のライブブロック(最下部)を消去。伸びた分は先にスクロールして確定させる
   * 2) 確定したトランスクリプト行を出力(はみ出した行はスクロールバックへ確定)
   * 3) ライブブロックを、起動時は縦中央、会話中は最下段に再描画
   * 再描画は最下部ブロックに限るため、過去の履歴が端末のスクロールバックに蓄積する。
   */
  private render = (): void => {
    // Keep mouse coordinates stable while a response is still streaming under the drag.
    if (this.closed || this.page || this.history || this.drag) return;
    const rows = this.rows();
    const columns = this.columns();
    const width = this.started ? this.width() : Math.max(8, Math.min(columns - 4, 80));
    // 会話開始前だけ中央寄せを残す。会話中は余白を付けず、画面上の位置とコピー結果を一致させる。
    const marginPrefix = this.started ? '' : ' '.repeat(Math.max(0, Math.floor((columns - width) / 2)));
    const stream = this.queue.splice(0).flatMap(line =>
      this.renderTranscriptLine(line.text, line.kind, width, true, this.colorizer));
    this.colorizerState = this.colorizer.state();
    // 起動時の案内だけを履歴に残す。ロゴはウェルカム画面の一部。
    if (this.started && !this.bootFlushed) {
      this.bootFlushed = true;
      stream.unshift(...this.bootLines.flatMap(line => {
        const wrapped = wrap(line, width);
        return wrapped.map((text, index) => ({ text, painted: text, newline: index === wrapped.length - 1 }));
      }));
      this.bootLines = [];
    }

    // --- ライブブロック(最下部)を構成する ---
    const displayText = this.pending?.secret ? '•'.repeat(chars(this.text).length) : this.text;
    const composer = !this.pending || this.pending.composer;
    const editor = editorLayout(displayText, this.editorWidth());
    const cursor = editor.positions[Math.min(this.cursor, editor.positions.length - 1)];
    const showUsage = this.hasUsagePane();
    const stackUsage = this.usageVisible && !showUsage && columns >= SIDEBAR_WIDTH && rows >= 14;
    const usageRows = showUsage || stackUsage
      ? usageBreakdownLines(this.usage ?? EMPTY_USAGE, SIDEBAR_WIDTH - 4) : [];
    const stackedHeight = stackUsage ? usageRows.length : 0;
    const files = this.fileOptions();
    const fileRows = files ? Math.max(1, Math.min(files.candidates.length, 4, Math.floor(rows / 6))) : 0;
    const options = this.options();
    const editingFollowup = !this.pending && !!this.followup;
    const inputRows = Math.min(Math.max(1, rows - 8 - Number(composer && !!this.images.length) - stackedHeight - fileRows), Math.max(composer ? 3 : 1, editor.lines.length));
    const controlWidth = this.controlWidth();
    const controlMargin = this.controlMargin();

    const partialRows = this.partial
      ? this.renderTranscriptLine(this.partial, this.partialKind, width, false, this.fork()) : [];
    const partialLines = partialRows.map(line => line.painted);
    const partialCount = partialLines.length;
    // ライブの推論は見出し含めて表示。はみ出すときは古い行(先頭)から落とす。
    const reasoningText = this.reasoning.trimEnd() === '' ? [] :
      transcriptLines(`(推論)\n${this.reasoning.trimEnd()}`, width);
    const reservedForBody = Number(composer && !!this.images.length) + 1 /* divider */ + inputRows + fileRows + 4 /* status/hints/cwd+footer */ + (options ? 2 : 0) + partialCount + stackedHeight;
    const maxReasoning = Math.max(0, Math.min(rows - reservedForBody - 1, 24));
    const liveReasoning = reasoningText.length === 0 ? [] :
      reasoningText.slice(Math.max(0, reasoningText.length - maxReasoning))
        .map(line => ({ ...line, painted: this.paint(fitText(line.text, width), this.palette.reasoning) }));

    const optionsLines: { text: string; style: string }[] = [];
    if (options) {
      const maxOptions = this.pending?.choices ? 8 : COMMANDS.length;
      const height = Math.max(1, Math.min(options.length || 1, Math.max(2, rows - (partialCount + liveReasoning.length) - 6 - stackedHeight), maxOptions));
      const start = Math.max(0, Math.min(this.selection - height + 1, options.length - height));
      optionsLines.push({ text: this.pending?.choices ? this.pending.title : 'Commands', style: READABLE_TEXT_STYLE });
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
    const lines = [...optionsLines, {
      text: this.started && !showUsage ? '─'.repeat(width) : '', style: ACCENT,
    }];
    const editorStart = partialCount + liveReasoning.length + lines.length;
    // 入力欄が表示行数を超えたら、カーソルが常に窓内に来るようにスクロールする。
    if (cursor.row < this.editorScroll) this.editorScroll = cursor.row;
    if (cursor.row >= this.editorScroll + inputRows) this.editorScroll = cursor.row - inputRows + 1;
    this.editorScroll = Math.max(0, Math.min(this.editorScroll, Math.max(0, editor.lines.length - inputRows)));
    for (let i = 0; i < inputRows; i++) {
      const line = editor.lines[this.editorScroll + i] ?? '';
      const placeholder = i === 0 && !this.text && this.pending && this.pending.choices !== APPROVAL_CHOICES
        ? (this.pending.choices ? 'Search…' : this.pending.title) : '';
      lines.push({ text: `│ ${line || placeholder}`, style: placeholder ? READABLE_TEXT_STYLE : '' });
    }
    if (files) {
      const start = Math.max(0, Math.min(files.selected - fileRows + 1, files.candidates.length - fileRows));
      if (!files.candidates.length) lines.push({ text: 'ファイル候補なし', style: '2' });
      files.candidates.slice(start, start + fileRows).forEach((candidate, i) => {
        const active = start + i === files.selected;
        lines.push({ text: `${active ? '›' : ' '} ${candidate.path}`, style: active ? '97;44' : '' });
      });
    }
    const attachments = composer && this.images.length ? `画像${this.images.length}枚 (Ctrl+Xで削除)` : '';
    const status = this.inputNotice && !this.pending?.secret ? this.inputNotice : `MoDKH  ·  ${this.model ?? '未接続 — /connect'}`;
    if (attachments) lines.push({ text: `│ ${attachments}`, style: this.panelAccent });
    const modelStatus = `│ ${status}`;
    // A notice is transient feedback, so it is emphasized beyond the standing status line.
    lines.push({ text: modelStatus, style: this.inputNotice && !this.pending?.secret ? `${this.panelAccent};1` : this.panelAccent });
    const busyHint = (this.activityPlacement === 'hint' && this.activityLabel()) || 'Ctrl+C 中止（入力は応答完了後）';
    const hints = editingFollowup ? 'Enter 追加の依頼を送信  Ctrl+V 画像  Ctrl+C 中止'
      : !this.pending ? busyHint : this.pending.choices ? '↑↓ 選択  Enter 決定  Esc 戻る'
      : composer ? 'Enter 送信  Ctrl+J 改行  Ctrl+V 画像  Cmd+V テキスト' + (this.mouseInput ? '  ドラッグでコピー' : '') : 'Enter 決定  Ctrl+C 中止';
    const recallHint = (this.pending?.composer || editingFollowup) && !this.text && this.previousInput ? '↑ 前回の入力  ' : '';
    const fileHint = files ? '↑↓ ファイル選択  Tab 補完  Esc 閉じる' : '';
    lines.push({ text: fileHint || recallHint + hints, style: '2' });
    // 右側の内訳を置けない端末では、最下段に使用量の要約を残す。
    const badgeRoom = controlWidth - textWidth(this.cwd) - 2;
    const usageStatus = !this.usageVisible || usageRows.length ? '' : this.usage?.responses
      ? usageBadgeLine(this.usage, controlWidth) : '計 — tok';
    const usageWidth = textWidth(usageStatus);
    const cwdWidth = textWidth(this.cwd);
    const bottom = usageStatus && badgeRoom >= usageWidth
      ? `${this.cwd}${' '.repeat(controlWidth - cwdWidth - usageWidth)}${usageStatus}`
      : usageStatus ? usageStatus.padStart(controlWidth - usageWidth + usageStatus.length) : this.cwd;
    lines.push({ text: bottom, style: '2' });

    const styled = (row: { text: string; style: string }, maxWidth = width): string => {
      const fitted = fitText(row.text, maxWidth);
      if (row.text.startsWith('│ ')) {
        const padded = fitted + ' '.repeat(Math.max(0, maxWidth - textWidth(fitted)));
        return this.paint('│', this.panelAccent) + this.paint(padded.slice(1), `${this.panelStyle}${row.style ? `;${row.style}` : ''}`);
      }
      return this.paint(fitted, row.style);
    };
    const rightStart = columns - SIDEBAR_WIDTH;
    const controls = lines.map(row => ' '.repeat(controlMargin) + styled(row, controlWidth));
    if (stackUsage) {
      controls.splice(controls.length - 2, 0, ...usageRows.map(row => ' '.repeat(rightStart) + this.paintSidebarRow(row)));
    }
    // 会話が始まる前のウェルカム: ロゴ+案内を中央に整える。
    const marginStyled = (row: { text: string; style: string }): string => marginPrefix + styled(row);
    let body: string[] = [];
    let editorStartIdx = editorStart;
    if (!this.started) {
      // タイトルとロゴをコンテンツ幅の中央に揃える。
      const widthCenter = (line: string): string => {
        const pad = Math.max(0, Math.floor((width - textWidth(line)) / 2));
        return ' '.repeat(pad) + line;
      };
      const welcome: { text: string; style: string }[] = [
        { text: widthCenter('MoDKH  ·  Coding Harness'), style: '1' },
        ...logoForWidth(width).map(line => ({ text: widthCenter(line), style: ACCENT })),
        ...this.bootLines.slice(-8).flatMap(line => wrap(line, width).map(text => ({ text, style: '' }))),
      ];
      // ロゴと入力欄は一つのまとまり。余白を両者の間に入れない。
      const midPad = 1;
      body = [
        ...welcome.map(row => marginStyled(row)),
        ...Array.from({ length: midPad }, () => marginPrefix),
        ...partialLines,
        ...liveReasoning.map(row => marginPrefix + row.painted),
        // lines にはコマンドメニュー(optionsLines)が含まれる。二重に展開しない。
        ...controls,
      ];
      editorStartIdx += welcome.length + midPad;
    } else {
      // 会話中は余白を付けない: 画面上の位置とコピーした文字列を一致させる。
      body = [
        ...partialLines,
        ...liveReasoning.map(row => row.painted),
        // lines にはコマンドメニュー(optionsLines)が含まれる。二重に展開しない。
        ...controls,
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
      this.scrollTranscriptRows(rows);
      this.streamRow = 1;
      this.cursorRow = 1;
      out += '\x1b[2J\x1b[1;1H';
    } else if (this.sidebarPainted) {
      // 右欄を履歴に巻き込む前に消し、左側を描いた後で元の位置へ戻す。
      out += this.eraseSidebar(rows, rightStart + 1);
    }
    const streamRow = this.streamRow >= 1 ? Math.max(1, Math.min(rows, this.streamRow)) : rows;
    out += `\x1b[${streamRow};1H\x1b[J`;
    // 確定行の出力。ライブブロックの上端を越えそうなら先にスクロールして確定させる。
    const streamBottom = Math.max(1, rows - liveCount);
    let r = streamRow;
    for (const line of stream) {
      if (r > streamBottom) {
        const scrolls = Math.min(r - streamBottom, rows);
        out += `\x1b[${rows};1H` + '\n'.repeat(scrolls);
        r -= scrolls;
        this.scrollTranscriptRows(scrolls);
      }
      out += `\x1b[${r};1H\x1b[K${line.painted}\r\n`;
      this.transcriptRows.set(r, line);
      r++;
    }
    this.streamRow = Math.max(1, Math.min(rows, r));
    // 起動時はグループ全体を縦中央へ。会話中は最下段に必要な余白を空ける。
    const liveStart = this.started ? Math.max(1, rows - liveCount + 1)
      : Math.max(1, Math.floor((rows - liveCount) / 2) + 1);
    if (liveStart < this.streamRow) {
      const scrolls = Math.min(rows, this.streamRow - liveStart);
      out += `\x1b[${rows};1H` + '\n'.repeat(scrolls);
      this.streamRow -= scrolls;
      this.scrollTranscriptRows(scrolls);
    }
    this.liveTranscriptRows.clear();
    if (this.started) {
      const liveTranscript = [...partialRows, ...liveReasoning];
      for (let i = overflow; i < liveTranscript.length; i++) {
        this.liveTranscriptRows.set(liveStart + i - overflow, liveTranscript[i]);
      }
    }
    for (let i = 0; i < liveCount; i++) {
      out += `\x1b[${liveStart + i};1H\x1b[K${body[i]}` + (i === liveCount - 1 ? '' : '\r\n');
    }
    if (showUsage) out += this.drawSidebar(rows, columns, this.sidebarLines(rows, usageRows));
    this.sidebarPainted = showUsage;
    const cursorLiveRow = Math.min(rows, liveStart + editorStartIdx + (cursor.row - this.editorScroll));
    const cursorCol = Math.min(columns, controlMargin + 3 + cursor.column);
    out += `\x1b[${cursorLiveRow};${cursorCol}H` + (this.pending || editingFollowup ? '\x1b[?25h' : '\x1b[?25l');
    this.cursorRow = cursorLiveRow;
    this.output.write(out);
  };

  private sidebarSubagent(rows: number, usageHeight: number): SubagentActivity | null {
    const reserved = Number(this.browse) + this.mcpRows.length;
    return this.started && !this.pending && rows - usageHeight - 3 - reserved >= 3 + Number(this.servers.length > 0)
      ? this.subagent : null;
  }

  private sidebarLines(rows: number, usageRows: string[]): string[] {
    const pane = this.sidebarSubagent(rows, usageRows.length);
    const browseRow = this.browse ? BROWSE_ACTIVE_LABEL : null;
    const serverRoom = rows - usageRows.length - 3 - Number(!!browseRow) - this.mcpRows.length - (pane ? 3 : 0);
    const servers = this.servers.slice(0, Math.max(0, Math.min(SIDEBAR_SERVER_ROWS, serverRoom)));
    const serverRows = servers.map(server => serverRow(server, this.cwd));
    const rest = this.servers.length - servers.length;
    if (rest > 0 && serverRoom > servers.length) serverRows.push(`ほか${rest}件`);
    const separatorRoom = serverRoom - serverRows.length;
    const rule = '─'.repeat(SIDEBAR_WIDTH - 4);
    const divider = separatorRoom >= 6 ? [' ', rule, ' '] : separatorRoom >= 2 ? [rule] : [];
    const topPadding = separatorRoom < 0 ? [] : [''];
    const sidebar = [...topPadding, ...usageRows, ...(browseRow ? [browseRow] : []), ...divider,
      `${SUBAGENTS_HEADING} ${this.subagent?.runningCount ?? (this.subagent ? 1 : 0)}稼働 / 累計${this.delegationCount}`];
    if (pane) sidebar.push(`${pane.phase} · ${Math.floor((performance.now() - this.subagentStarted) / 1000)}秒`,
      pane.task.split(/\r?\n/, 1)[0], pane.pluginId);
    sidebar.push(...divider, `${SERVERS_HEADING} ${this.servers.length}稼働`, ...serverRows, ...this.mcpRows);
    if (this.activity && !this.pending && this.color && this.animationEnabled && rows - sidebar.length >= 4) {
      sidebar.push(' ', rule, ' ', whaleRow(Math.floor((performance.now() - this.activityStarted) / WHALE_FRAME_MS), SIDEBAR_WIDTH - 4));
    }
    return sidebar;
  }

  private paintSidebarRow(content: string): string {
    const right = fitText(content, SIDEBAR_WIDTH - 4);
    const border = this.paint('│', ACCENT);
    const heading = content.startsWith(USAGE_HEADING) || content.startsWith(SUBAGENTS_HEADING)
      || content.startsWith(SERVERS_HEADING) || content === BROWSE_ACTIVE_LABEL;
    const style = heading ? `${this.panelStyle};1` : this.panelStyle;
    const padding = ' '.repeat(SIDEBAR_WIDTH - 3 - textWidth(right));
    const panel = this.paint(` ${right}${padding}`, style);
    return border + panel + border;
  }

  private drawSidebar(rows: number, columns: number, sidebar: string[]): string {
    const empty = this.paint(' '.repeat(SIDEBAR_WIDTH), this.panelStyle);
    let out = '';
    for (let i = 0; i < rows; i++) {
      const content = sidebar[i];
      const panel = content ? this.paintSidebarRow(content) : this.color ? empty : '';
      if (panel) out += `\x1b[${i + 1};${columns - SIDEBAR_WIDTH + 1}H${panel}`;
    }
    return out;
  }

  private eraseSidebar(rows: number, column: number): string {
    return Array.from({ length: rows }, (_, i) => `\x1b[${i + 1};${column}H\x1b[K`).join('');
  }

  /** 未完了行の色分け用に、完成行までの状態を複製する。 */
  private fork(): TranscriptColorizer {
    const clone = new TranscriptColorizer();
    clone.restore(this.colorizerState);
    return clone;
  }

  close = (): void => {
    if (this.closed) return;
    this.dismissPage();
    this.leaveHistory(false);
    this.cancelDrag();
    this.closed = true;
    if (this.mouseInput) {
      this.input.off('data', this.mouseInput.write);
      this.mouseInput.close();
      this.keyInput?.destroy();
      this.output.write('\x1b[?1006l\x1b[?1002l');
    }
    clearInterval(this.progressTimer);
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
    if (this.sidebarPainted) {
      this.output.write(this.eraseSidebar(rows, this.columns() - SIDEBAR_WIDTH + 1) + `\x1b[${base};1H`);
    }
    const up = base - eraseRow;
    if (up > 0) this.output.write(`\x1b[${up}A`);
    this.output.write('\r\x1b[J');
    this.output.write('\x1b[0m\x1b[?25h\x1b[?2004l\r\n');
  };
}
export function createTerminal(cwd: string): ChatTerminal {
  return process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb' && process.env.MODKH_PLAIN !== '1'
    ? new TerminalUI(cwd) : new PlainTerminal();
}
