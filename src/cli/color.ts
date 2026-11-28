/**
 * トランスクリプトの行単位の色分け。外部依存なし。
 * - 推論はグレー、回答は Markdown の強調やコードを端末のスタイルで表示
 * - diff(+/-/@@/---/+++)は追加=緑・削除=赤
 * - ``` コードブロック内は簡易トークナイザー(文字列・コメント・キーワード・数値)
 * ライト/ダーク両方で読みやすいよう端末テーマの標準色を使う。
 */
import { answerMarkdown } from './answer-markdown.ts';
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

/** ANSI palette entries follow the terminal profile even after text has entered scrollback. */
export const terminalPalette: Readonly<Palette> = {
  reasoning: '90', result: '90', system: '90',
  user: '1', heading: '1', accent: '36', tool: '94',
  diffAdd: '92', diffDel: '91', diffMeta: '96',
  codeComment: '90', codeString: '33',
  codeNumber: '95', codeKeyword: '94',
};

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

/**
 * Tool output quoting source, as produced by `search_files` (`path:line: body`) and
 * `read_file` (`line: body`). Output without a source prefix stays plain: highlighting
 * a JSON body or a log line as code would claim more context than the text carries.
 */
export function sourceLine(raw: string): { body: string } | null {
  const hit = /^\s{0,2}([^\s:]+):(\d+)(?::(\d+))?: (.*)$/.exec(raw)
    ?? /^\s{0,2}(\d+): (.*)$/.exec(raw);
  if (hit === null) return null;
  const numbered = hit.length === 4 ? hit[2] : hit[1];
  if (Number(numbered) < 1) return null;
  const body = hit[hit.length - 1];
  return body.trim().length === 0 ? null : { body };
}

export type TranscriptKind = 'system' | 'user' | 'answer' | 'reasoning';
export type ColorMode = 'text' | 'code';

export interface ColorizerState { answerFence?: string; mode: ColorMode; inDiff: boolean; inToolOutput: boolean }

/** Tool output lines that never quote source: they carry their own meaning. */
const TOOL_OUTPUT_META = /^\s*(?:\(結果[.:]|… 残り|検索 |対象: |作業場所: |\[exit code|\(エラー)/;

/** コードブロックとdiffの状態を行間で引き継いで色を付ける。 */
export class TranscriptColorizer {
  private answerFence?: string;
  private mode: ColorMode = 'text';
  private inDiff = false;
  /** Set while drawing the body of one tool result, cleared by the next `▶` line or blank line. */
  private inToolOutput = false;

  /** 完成行までの状態を保存しておき、未完了行(ライブ表示)の色分けに複製する。 */
  state(): ColorizerState { return { answerFence: this.answerFence, mode: this.mode, inDiff: this.inDiff, inToolOutput: this.inToolOutput }; }
  restore(state: ColorizerState): void {
    this.answerFence = state.answerFence;
    this.mode = state.mode;
    this.inDiff = state.inDiff;
    this.inToolOutput = state.inToolOutput;
  }

  line(raw: string, palette: Palette, kind: TranscriptKind = 'system'): string {
    if (kind === 'answer') {
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
      if (this.answerFence) {
        if (fence?.[1].startsWith(this.answerFence) && !fence[2].trim()) {
          this.answerFence = undefined;
          return '';
        }
        return highlightCodeLine(raw, palette);
      }
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        this.answerFence = fence[1];
        return '';
      }
      return answerMarkdown(raw, palette);
    }
    this.answerFence = undefined;
    if (kind === 'user') return raw;
    const trimmed = raw.trim();
    const blank = trimmed.length === 0;
    if (kind === 'reasoning') return blank ? raw : `\x1b[${palette.reasoning}m${raw}\x1b[0m`;
    // Shell cards are terminal output, not Markdown or source code. Keep their body literal.
    if (kind === 'system' && /^(╭ |│ |╰ )/.test(raw)) {
      this.inToolOutput = false;
      this.inDiff = false;
      this.mode = 'text';
      if (raw.startsWith('╭ ')) return `\x1b[${palette.tool}m${raw}\x1b[0m`;
      if (raw.startsWith('╰ ')) return `\x1b[${palette.result}m${raw}\x1b[0m`;
      return `\x1b[${palette.reasoning}m│\x1b[0m${raw.slice(1)}`;
    }
    if (this.mode === 'code') {
      if (/^(\s*)(```|~~~)/.test(raw)) { this.mode = 'text'; return `\x1b[${palette.reasoning}m${raw}\x1b[0m`; }
      return highlightCodeLine(raw, palette);
    }
    if (blank) { this.inToolOutput = false; return raw; }
    if (/^(\s*)(```|~~~)/.test(raw)) {
      this.mode = 'code';
      return `\x1b[${palette.reasoning}m${raw}\x1b[0m`;
    }
    const diff = this.diffLine(trimmed, raw, palette);
    if (diff !== null) return diff;
    // A tool result body may quote source, so grep/read hits stay readable where they appear.
    // The state ends with the result, so ordinary prose after it is never treated as code.
    if (this.inToolOutput) {
      // Meta lines are summarized in the result color but do not end the body: search
      // output puts `対象: …` between the header and the hits it describes.
      if (TOOL_OUTPUT_META.test(raw)) return `\x1b[${palette.result}m${raw}\x1b[0m`;
      const source = sourceLine(raw);
      if (source !== null) return this.prefix(raw, source.body, highlightCodeLine(source.body, palette));
    }
    if (/^#{1,6} /.test(trimmed)) return `\x1b[${palette.heading}m${raw}\x1b[0m`;
    if (/^▶ You:/.test(raw)) return `\x1b[${palette.user}m${raw}\x1b[0m`;
    if (/^▶ /.test(raw)) { this.inToolOutput = false; return `\x1b[${palette.tool}m${raw}\x1b[0m`; }
    if (/^\(承認\)|^\(拒否\)|^\(中断|^\(接続|^\(モデル|^\(推論/.test(trimmed)
      || /^ {0,2}\(結果\./.test(trimmed) || /^ {0,2}\(結果:/.test(raw) || /^ {0,2}\(エラー/.test(trimmed)) {
      this.inDiff = false;
      this.inToolOutput = /^ {0,2}\(結果:/.test(raw);
      return `\x1b[${palette.result}m${raw}\x1b[0m`;
    }
    if (/^\[exit code/.test(trimmed)) return `\x1b[${palette.result}m${raw}\x1b[0m`;
    return raw;
  }

  /** Rebuild a line from its untouched prefix (`path:12: `) and its highlighted body. */
  private prefix(raw: string, body: string, painted: string): string {
    const index = raw.indexOf(body);
    return index <= 0 || raw.slice(index, index + body.length) !== body ? painted : raw.slice(0, index) + painted;
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
