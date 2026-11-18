import { Lexer, type Token } from 'marked';
import type { Palette } from './color.ts';

function paint(text: string, style: string): string {
  return text && style ? `\x1b[${style}m${text}\x1b[0m` : text;
}

function inline(tokens: Token[], palette: Palette, styles: string[]): string {
  return tokens.map(token => {
    switch (token.type) {
      case 'strong': return inline(token.tokens ?? [], palette, [...styles, '1']);
      case 'em': return inline(token.tokens ?? [], palette, [...styles, '3']);
      case 'del': return inline(token.tokens ?? [], palette, [...styles, '9']);
      case 'link': {
        const label = inline(token.tokens ?? [], palette, [...styles, '4']);
        return token.href && token.href !== token.text ? `${label} (${token.href})` : label;
      }
      case 'codespan': return paint(token.text, [...styles, palette.codeKeyword].join(';'));
      case 'escape': return paint(token.text, styles.join(';'));
      default: return paint(token.raw, styles.join(';'));
    }
  }).join('');
}

/** Parse before soft wrapping so delimiters and graphemes use independent coordinates. */
export function answerMarkdown(line: string, palette: Palette): string {
  if (/^( {4}|\t)/.test(line)) return line;
  const heading = /^ {0,3}#{1,6}(?:\s+|$)/.exec(line);
  const body = heading ? line.slice(heading[0].length).replace(/\s+#+\s*$/, '')
    : line.replace(/^(\s*)[-+*] (?=\S)/, '$1• ');
  return inline(Lexer.lexInline(body), palette, heading ? [palette.heading] : []);
}
