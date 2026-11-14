import fs from 'node:fs';
import path from 'node:path';

/**
 * LSP positions are UTF-16 code units. Files are decoded as UTF-8, so a JavaScript string index
 * already counts UTF-16 units; CRLF is preserved so line/character stay consistent with the server.
 * These helpers never re-encode and never normalize the caller's text.
 */
export function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  const limit = Math.max(0, Math.min(offset, text.length));
  let line = 0, lineStart = 0;
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  }
  return { line, character: limit - lineStart };
}

export function positionToOffset(text: string, position: { line: number; character: number }): number {
  const line = Math.max(0, Math.floor(position.line));
  const character = Math.max(0, Math.floor(position.character));
  let offset = 0;
  for (let current = 0; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(text.length, offset + character);
}

/** 1-based line and column display for humans and model output. */
export function displayPosition(text: string, offset: number): { line: number; column: number } {
  const { line, character } = offsetToPosition(text, offset);
  return { line: line + 1, column: character + 1 };
}

export function fileExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function directoryOf(file: string): string {
  return path.dirname(file);
}
