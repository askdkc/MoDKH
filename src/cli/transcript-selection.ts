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
