import { stripVTControlCharacters } from 'node:util';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function chars(text: string): string[] { return [...segments.segment(text)].map(s => s.segment); }
export function clean(text: string): string { return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); }
function cellWidth(char: string): number {
  if (/\p{Extended_Pictographic}/u.test(char)) return 2;
  const cp = char.codePointAt(0)!;
  return cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3
    || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff00 && cp <= 0xff60 || cp >= 0x20000) ? 2 : 1;
}
export function textWidth(text: string): number { return chars(clean(text)).reduce((sum, c) => sum + cellWidth(c), 0); }
export function fitText(text: string, width: number): string {
  let result = '', used = 0;
  for (const c of chars(clean(text))) { const n = cellWidth(c); if (used + n > width) break; result += c; used += n; }
  return result;
}

export interface CursorPosition { row: number; column: number }
/** Each grapheme boundary has a visual position; explicit newlines and soft wraps share one layout. */
export function editorLayout(text: string, width: number): { lines: string[]; positions: CursorPosition[] } {
  const parts = chars(text), lines: string[] = [], positions: CursorPosition[] = [];
  let line = '', column = 0;
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i], n = c === '\n' ? 0 : cellWidth(c);
    if (c !== '\n' && column + n > width) { lines.push(line); line = ''; column = 0; }
    positions[i] = { row: lines.length, column };
    if (c === '\n') { lines.push(line); line = ''; column = 0; }
    else { line += c; column += n; }
  }
  positions[parts.length] = { row: lines.length, column };
  lines.push(line);
  return { lines, positions };
}

export function wrap(text: string, width: number): string[] { return editorLayout(clean(text), width).lines; }

export function verticalCursor(text: string, cursor: number, width: number, delta: number): number {
  const layout = editorLayout(text, width), current = layout.positions[cursor];
  const row = Math.max(0, Math.min(layout.lines.length - 1, current.row + delta));
  if (row === current.row) return cursor;
  let best = cursor, distance = Infinity;
  for (let i = 0; i < layout.positions.length; i++) {
    const position = layout.positions[i];
    if (position.row === row && Math.abs(position.column - current.column) < distance) {
      best = i; distance = Math.abs(position.column - current.column);
    }
  }
  return best;
}

export function lineEdge(text: string, cursor: number, edge: 'start' | 'end'): number {
  const parts = chars(text);
  if (edge === 'start') { while (cursor > 0 && parts[cursor - 1] !== '\n') cursor--; }
  else { while (cursor < parts.length && parts[cursor] !== '\n') cursor++; }
  return cursor;
}
