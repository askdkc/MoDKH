import { cellWidth, chars, wrapText } from './editor.ts';
import type { ScreenPoint } from './terminal-mouse.ts';

export interface TranscriptLine { text: string; newline: boolean }
export interface TranscriptScreenLine extends TranscriptLine { painted: string }

export function transcriptLine(text: string, width: number, newline: boolean): TranscriptLine[] {
  const wrapped = wrapText(text, width);
  return wrapped.map((text, row) => ({ text, newline: newline && row === wrapped.length - 1 }));
}

export function transcriptLines(text: string, width: number): TranscriptLine[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => transcriptLine(line, width, index < lines.length - 1));
}

/** Rewrap plain text and carry the renderer's self-contained SGR spans across soft breaks. */
export function reflowTranscript(rows: readonly TranscriptScreenLine[], width: number): TranscriptScreenLine[] {
  const result: TranscriptScreenLine[] = [];
  let text = '';
  let spans: { start: number; end: number; style: string }[] = [];
  for (const [index, row] of rows.entries()) {
    let position = 0;
    for (const match of row.painted.matchAll(/\x1b\[([0-9;]+)m([^\x1b]*)\x1b\[0m|([^\x1b]+)/g)) {
      const end = Math.min(row.text.length, position + (match[2] ?? match[3]).length);
      if (match[1] && end > position) spans.push({ start: text.length + position, end: text.length + end, style: match[1] });
      position = end;
    }
    text += row.text;
    if (!row.newline && index < rows.length - 1) continue;
    let start = 0;
    let spanIndex = 0;
    for (const line of transcriptLine(text, width, row.newline)) {
      const end = start + line.text.length;
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
      result.push({ ...line, painted: painted + text.slice(cursor, end) });
      start = end;
    }
    text = '';
    spans = [];
  }
  return result;
}

export interface DragSelection { anchor: ScreenPoint; end: ScreenPoint }

export function selectedTranscript(rows: ReadonlyMap<number, TranscriptScreenLine>, selection: DragSelection) {
  const { anchor, end } = selection;
  const forward = anchor.row < end.row || (anchor.row === end.row && anchor.column <= end.column);
  const [first, last] = forward ? [anchor, end] : [end, anchor];
  const result = [];
  for (let row = first.row; row <= last.row; row++) {
    const line = rows.get(row);
    if (!line) continue;
    const start = row === first.row ? first.column : 1;
    const stop = row === last.row ? last.column : Infinity;
    let column = 1;
    let text = '';
    let selectedColumn = 0;
    for (const char of chars(line.text)) {
      const next = column + cellWidth(char, column - 1);
      if (next > start && column <= stop) {
        if (!selectedColumn) selectedColumn = column;
        text += char;
      }
      column = next;
    }
    result.push({ row, column: selectedColumn, text, newline: row < last.row && line.newline });
  }
  return result;
}
