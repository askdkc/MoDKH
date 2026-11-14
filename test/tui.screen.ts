import { stripVTControlCharacters } from 'node:util';

/**
 * dkh の新しい描画契約(絶対行配置 + 行単位の消去)を再生し、現在の画面を再現する。
 * - `\x1b[<r>;<c>H` 絶対配置 / `\x1b[<n>A` 上へ / `\x1b[K` 行末まで消去 / `\x1b[J` 下端まで消去
 * - 改行は1行下へ。最下段では1行スクロール(先頭行が落ちる)
 * dkh は必ず「配置→消去→行全体の書き込み」で書くため、テキストは行全体で置き換える。
 */
export function screenFrom(raw: string, rows = 40): string[] {
  const grid: string[] = Array.from({ length: rows }, () => '');
  let crow = rows; // TUI起動時のカーソルはシェルの最終行想定
  let clearOnWrite = false;
  let i = 0;
  const writeText = (text: string): void => {
    grid[crow - 1] = clearOnWrite ? text : text;
    clearOnWrite = false;
  };
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\x1b') {
      const rest = raw.slice(i);
      let m: RegExpExecArray | null;
      if ((m = /^\x1b\[([0-9]*)K/.exec(rest)) !== null) { grid[crow - 1] = ''; clearOnWrite = true; i += m[0].length; continue; }
      if ((m = /^\x1b\[J/.exec(rest)) !== null) { for (let r = crow; r <= rows; r++) grid[r - 1] = ''; i += m[0].length; continue; }
      if ((m = /^\x1b\[2J/.exec(rest)) !== null) { for (let r = 1; r <= rows; r++) grid[r - 1] = ''; i += m[0].length; continue; }
      if ((m = /^\x1b\[(\d+)A/.exec(rest)) !== null) { crow = Math.max(1, crow - Number(m[1])); i += m[0].length; continue; }
      if ((m = /^\x1b\[(\d+);(\d+)H/.exec(rest)) !== null) {
        crow = Math.max(1, Math.min(rows, Number(m[1])));
        clearOnWrite = Number(m[2]) === 1;
        i += m[0].length;
        continue;
      }
      if ((m = /^\x1b\[1;1H/.exec(rest)) !== null) { crow = 1; clearOnWrite = true; i += m[0].length; continue; }
      if ((m = /^\x1b(\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/.exec(rest)) !== null) { i += m[0].length; continue; }
      i += 1;
      continue;
    }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') {
      if (clearOnWrite) grid[crow - 1] = '';
      clearOnWrite = false;
      if (crow >= rows) { grid.shift(); grid.push(''); }
      else crow++;
      i += 1;
      continue;
    }
    let end = i;
    while (end < raw.length && raw[end] !== '\x1b' && raw[end] !== '\n' && raw[end] !== '\r') end++;
    writeText(stripVTControlCharacters(raw.slice(i, end)));
    i = end;
  }
  return grid;
}

export function screenText(rows: string[]): string { return rows.join('\n'); }
