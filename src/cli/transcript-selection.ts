import { cellWidth, chars, wrapText } from './editor.ts';

export interface TranscriptLine { text: string; newline: boolean }
export interface TranscriptScreenLine extends TranscriptLine { painted: string }
/** 折り返した1行と、その行の先頭が文書のどこに当たるか。 */
export interface DisplayLine extends TranscriptScreenLine {
  /** 文書の行番号。 */
  row: number;
  /** その行の先頭からの文字位置。 */
  offset: number;
}

export function transcriptLine(text: string, width: number, newline: boolean): TranscriptLine[] {
  const wrapped = wrapText(text, width);
  return wrapped.map((text, row) => ({ text, newline: newline && row === wrapped.length - 1 }));
}

export function transcriptLines(text: string, width: number): TranscriptLine[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => transcriptLine(line, width, index < lines.length - 1));
}

/**
 * 文書の1点。`row` は行番号、`char` はその行の先頭からの文字位置(コード単位)。
 * 画面の行番号ではないので、履歴を送っても折り返し幅が変わっても同じ文字を指す。
 */
export interface DocPoint { row: number; char: number }

/**
 * Rewrap plain text and carry the renderer's self-contained SGR spans across soft breaks.
 * 各表示行は由来する行番号と行内位置を持つので、画面上の位置を文書の位置へ戻せる。
 */
export function reflowDisplay(rows: readonly TranscriptScreenLine[], width: number): DisplayLine[] {
  const lines: DisplayLine[] = [];
  let text = '';
  let spans: { start: number; end: number; style: string }[] = [];
  /** この論理行に属する元の行と、その開始位置。 */
  let group: { row: number; start: number }[] = [];
  for (const [index, row] of rows.entries()) {
    let position = 0;
    for (const match of row.painted.matchAll(/\x1b\[([0-9;]+)m([^\x1b]*)\x1b\[0m|([^\x1b]+)/g)) {
      const end = Math.min(row.text.length, position + (match[2] ?? match[3]).length);
      if (match[1] && end > position) spans.push({ start: text.length + position, end: text.length + end, style: match[1] });
      position = end;
    }
    group.push({ row: index, start: text.length });
    text += row.text;
    if (!row.newline && index < rows.length - 1) continue;
    let start = 0;
    let spanIndex = 0;
    let member = 0;
    for (const line of transcriptLine(text, width, row.newline)) {
      const end = start + line.text.length;
      while (member + 1 < group.length && group[member + 1].start <= start) member++;
      let cursor = start;
      let painted = '';
      for (; spanIndex < spans.length && spans[spanIndex].start < end; spanIndex++) {
        const span = spans[spanIndex];
        const spanStart = Math.max(start, span.start);
        painted += text.slice(cursor, spanStart);
        cursor = Math.min(end, span.end);
        painted += `\x1b[${span.style}m${text.slice(spanStart, cursor)}\x1b[0m`;
        if (span.end > end) break;
      }
      lines.push({
        ...line,
        painted: painted + text.slice(cursor, end),
        row: group[member].row,
        offset: start - group[member].start,
      });
      start = end;
    }
    text = '';
    spans = [];
    group = [];
  }
  return lines;
}

export function reflowTranscript(rows: readonly TranscriptScreenLine[], width: number): TranscriptScreenLine[] {
  return reflowDisplay(rows, width);
}

/** 表示行の `column`(1始まり、セル幅)を文書の位置へ直す。 */
export function docPointAt(line: DisplayLine, column: number): DocPoint {
  let used = 1;
  let offset = 0;
  for (const char of chars(line.text)) {
    const next = used + cellWidth(char, used - 1);
    if (next > Math.max(1, column)) return { row: line.row, char: line.offset + offset };
    used = next;
    offset += char.length;
  }
  return { row: line.row, char: line.offset + line.text.length };
}

function ordered(a: DocPoint, b: DocPoint): [DocPoint, DocPoint] {
  return a.row < b.row || (a.row === b.row && a.char <= b.char) ? [a, b] : [b, a];
}

/**
 * 選択範囲をコピー用の文字列にする。折り返しで分かれた行はつなげ、論理行の改行だけを残す。
 * 範囲の両端は、その文字を含む。
 */
export function selectionText(rows: readonly TranscriptLine[], anchor: DocPoint, focus: DocPoint): string {
  const [first, last] = ordered(anchor, focus);
  let result = '';
  for (let row = Math.max(0, first.row); row <= last.row && row < rows.length; row++) {
    const parts = chars(rows[row].text);
    const from = row === first.row ? Math.max(0, Math.min(first.char, parts.length)) : 0;
    const to = row === last.row ? Math.min(parts.length, last.char + 1) : parts.length;
    if (to > from) result += parts.slice(from, to).join('');
    if (row < last.row && rows[row].newline) result += '\n';
  }
  return result;
}

/**
 * 表示行のうち選択範囲に入る部分。折り返した行が複数の文書行にまたがっていても、
 * 選択の内側だけを1つの連続した範囲として返す。
 */
export function highlightAtLine(rows: readonly TranscriptLine[], line: DisplayLine,
  anchor: DocPoint, focus: DocPoint): { column: number; text: string } | null {
  const [first, last] = ordered(anchor, focus);
  let consumed = 0;
  let remaining = line.text.length;
  let row = line.row;
  let offset = line.offset;
  let head = -1;
  let tail = -1;
  while (remaining > 0 && row < rows.length) {
    const length = rows[row].text.length;
    const take = Math.min(remaining, Math.max(0, length - offset));
    if (take > 0 && row >= first.row && row <= last.row) {
      const from = row === first.row ? Math.max(offset, first.char) : offset;
      const to = row === last.row ? Math.min(offset + take, last.char + 1) : offset + take;
      if (to > from) {
        const start = consumed + (from - offset);
        const end = consumed + (to - offset);
        if (head < 0) head = start;
        tail = end;
      }
    }
    consumed += take;
    remaining -= take;
    row += 1;
    offset = 0;
  }
  if (head < 0 || tail <= head) return null;
  let column = 1;
  for (const char of chars(line.text.slice(0, head))) column += cellWidth(char, column - 1);
  return { column, text: line.text.slice(head, tail) };
}
