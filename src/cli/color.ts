/**
 * トランスクリプトの行単位の色分け。外部依存なし。
 * - 推論はグレー、回答の本文は端末の前景色で太字
 * - diff(+/-/@@/---/+++)は追加=緑・削除=赤
 * - ``` コードブロック内は簡易トークナイザー(文字列・コメント・キーワード・数値)
 * ライト/ダーク両方で読みやすいよう背景判定ごとにパレットを替える。
 */
import { stripVTControlCharacters } from 'node:util';

export type Background = 'dark' | 'light';

export interface Palette {
  reasoning: string;
  user: string;
  tool: string;
  result: string;
  system: string;
  heading: string;
  accent: string;
  diffAdd: string;
  diffDel: string;
  diffMeta: string;
  codeComment: string;
  codeString: string;
  codeNumber: string;
  codeKeyword: string;
}

/** ダーク背景は明るい標準色、ライト背景は256色パレットの暗い色。 */
export function paletteFor(background: Background): Palette {
  return background === 'dark'
    ? {
      reasoning: '90', result: '90', system: '90',
      user: '1', heading: '1', accent: '36', tool: '94',
      diffAdd: '92', diffDel: '91', diffMeta: '96',
      codeComment: '90', codeString: '33',
      codeNumber: '95', codeKeyword: '94',
    }
    : {
      reasoning: '90', result: '90', system: '90',
      user: '1', heading: '1', accent: '36', tool: '38;5;26',
      diffAdd: '38;5;28', diffDel: '38;5;160', diffMeta: '38;5;30',
      codeComment: '38;5;242', codeString: '38;5;130',
      codeNumber: '38;5;52', codeKeyword: '38;5;19',
    };
}

/** `rgb:rrrr/gggg/bbbb` または `color:0/9` 形式の OSC 11 応答を解析する。 */
export function parseOscBackground(text: string): string | null {
  const match = /\x1b]11;([^\x07\x1b]*)/.exec(text);
  if (match === null) return null;
  return stripVTControlCharacters(match[1]).trim() || null;
}

/** 0〜65535 の16進3成分から輝度を0..1で出す。 */
export function backgroundLuminance(osc: string): number | null {
  const rgb = /rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(osc)
    ?? /rgba?:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(osc);
  if (rgb !== null) {
    const components = [rgb[1], rgb[2], rgb[3]].map((c) => parseInt(c, 16) / (16 ** c.length - 1));
    if (components.some((n) => !Number.isFinite(n))) return null;
    return 0.2126 * components[0] + 0.7152 * components[1] + 0.0722 * components[2];
  }
  const gray = /^(\d+)$/.exec(osc.trim());
  if (gray !== null) {
    const n = Number(gray[1]);
    return Number.isFinite(n) ? n / 255 : null;
  }
  return null;
}

/** OSC応答または COLORFGBG 環境変数から背景を分類する。根拠がなければ null。 */
export function classifyBackground(oscReply: string | null, env?: NodeJS.ProcessEnv): 'dark' | 'light' | null {
  if (oscReply !== null) {
    const l = backgroundLuminance(oscReply);
    if (l !== null) return l < 0.5 ? 'dark' : 'light';
  }
  const fgbg = env?.['COLORFGBG'];
  if (typeof fgbg === 'string' && /;/.test(fgbg)) {
    const bg = Number(fgbg.split(';').at(-1));
    // 0-6 暗い色、7/8-15 明るい色(xterm系の慣習)。15以上は256色拡張。
    if (Number.isFinite(bg)) {
      if (bg <= 6) return 'dark';
      if (bg >= 8 && bg <= 15) return 'light';
      if (bg >= 16) return bg >= 238 ? 'dark' : 'light';
    }
  }
  return null;
}

/** 汎用キーワード群(C/JS/TS/Python/Rust/Go/Ruby/Shell など)。誤着色より無着色を避ける単純リスト。 */
const KEYWORDS = [
  'function', 'const', 'let', 'var', 'return', 'if', 'else', 'elif', 'for', 'while', 'class', 'import', 'export',
  'from', 'def', 'async', 'await', 'type', 'interface', 'extends', 'implements', 'new', 'try', 'catch', 'finally',
  'throw', 'switch', 'case', 'break', 'continue', 'do', 'in', 'of', 'null', 'true', 'false', 'void', 'static',
  'public', 'private', 'protected', 'this', 'super', 'yield', 'match', 'struct', 'impl', 'trait', 'fn', 'pub',
  'use', 'mod', 'self', 'None', 'Some', 'end', 'local', 'require', 'lambda', 'package', 'func', 'range',
  'select', 'defer', 'go', 'with', 'unless', 'until', 'nil', 'then', 'fi', 'esac', 'echo', 'done', 'set',
];

const TOKEN_PATTERN = new RegExp(
  [
    '(\\/\\/[^\\n]*|--[^\\n]*)', // 行コメント(/ / --)
    '(#[^\\n]*)', // # コメント(shell/ruby/python風)
    '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
    '\\b(\\d+(?:\\.\\d+)*)\\b',
    `\\b(${KEYWORDS.join('|')})\\b`,
  ].join('|'),
  'g',
);

/** コード fenced block 内の1行を簡易ハイライトする。 */
export function highlightCodeLine(line: string, palette: Palette): string {
  return line.replace(TOKEN_PATTERN, (match, lineComment, hashComment, str, num, keyword) => {
    const code = lineComment !== undefined || hashComment !== undefined ? palette.codeComment
      : str !== undefined ? palette.codeString
      : num !== undefined ? palette.codeNumber
      : palette.codeKeyword;
    return `\x1b[${code}m${match}\x1b[0m`;
  });
}

export const READABLE_TEXT_STYLE = '1;39';
export type TranscriptKind = 'system' | 'user' | 'answer' | 'reasoning';
export type ColorMode = 'text' | 'code';

export interface ColorizerState { mode: ColorMode; inDiff: boolean }

/** コードブロックとdiffの状態を行間で引き継いで色を付ける。 */
export class TranscriptColorizer {
  private mode: ColorMode = 'text';
  private inDiff = false;

  /** 完成行までの状態を保存しておき、未完了行(ライブ表示)の色分けに複製する。 */
  state(): ColorizerState { return { mode: this.mode, inDiff: this.inDiff }; }
  restore(state: ColorizerState): void { this.mode = state.mode; this.inDiff = state.inDiff; }

  line(raw: string, palette: Palette, kind: TranscriptKind = 'system'): string {
    const trimmed = raw.trim();
    const blank = trimmed.length === 0;
    if (kind === 'reasoning') return blank ? raw : `\x1b[${palette.reasoning}m${raw}\x1b[0m`;
    if (this.mode === 'code') {
      if (/^(\s*)(```|~~~)/.test(raw)) { this.mode = 'text'; return `\x1b[${palette.reasoning}m${raw}\x1b[0m`; }
      return highlightCodeLine(raw, palette);
    }
    if (blank) return raw;
    if (/^(\s*)(```|~~~)/.test(raw)) {
      this.mode = 'code';
      return `\x1b[${palette.reasoning}m${raw}\x1b[0m`;
    }
    const diff = this.diffLine(trimmed, raw, palette);
    if (diff !== null) return diff;
    if (kind === 'answer') return `\x1b[${READABLE_TEXT_STYLE}m${raw}\x1b[0m`;
    if (/^#{1,6} /.test(trimmed)) return `\x1b[${palette.heading}m${raw}\x1b[0m`;
    if (/^▶ You:/.test(raw)) return `\x1b[${palette.user}m${raw}\x1b[0m`;
    if (/^▶ /.test(raw)) return `\x1b[${palette.tool}m${raw}\x1b[0m`;
    if (/^\(承認\)|^\(拒否\)|^\(中断|^\(接続|^\(モデル|^\(推論/.test(trimmed)
      || /^ {0,2}\(結果\./.test(trimmed) || /^ {0,2}\(結果:/.test(raw) || /^ {0,2}\(エラー/.test(trimmed)) {
      this.inDiff = false;
      return `\x1b[${palette.result}m${raw}\x1b[0m`;
    }
    if (/^\[exit code/.test(trimmed)) return `\x1b[${palette.result}m${raw}\x1b[0m`;
    return raw;
  }

  private diffLine(trimmed: string, raw: string, palette: Palette): string | null {
    if (/^--- 承認要求/.test(raw)) { this.inDiff = false; return `\x1b[${palette.system}m${raw}\x1b[0m`; }
    if (/^--- /.test(raw) && !this.inDiff) {
      this.inDiff = true;
      return `\x1b[${palette.diffMeta}m${raw}\x1b[0m`;
    }
    if (!this.inDiff) return null;
    if (/^\+\+\+ /.test(raw)) return `\x1b[${palette.diffMeta}m${raw}\x1b[0m`;
    if (/^@@/.test(raw)) return `\x1b[${palette.diffMeta}m${raw}\x1b[0m`;
    if (/^\+ /.test(raw)) return `\x1b[${palette.diffAdd}m${raw}\x1b[0m`;
    if (/^- /.test(raw)) return `\x1b[${palette.diffDel}m${raw}\x1b[0m`;
    if (/^ {2}/.test(raw)) return raw; // 文脈行
    this.inDiff = false;
    return null;
  }
}
