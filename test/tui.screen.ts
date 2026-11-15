import { stripVTControlCharacters } from 'node:util';

/**
 * modkh の新しい描画契約(絶対行配置 + 行単位の消去)を再生し、現在の画面を再現する。
 * - `\x1b[<r>;<c>H` 絶対配置(列1なら行をクリアして書き直す) / `\x1b[<n>A` 上へ / `\x1b[K` 行末まで消去 / `\x1b[J` 下端まで消去
 * - 改行は1行下へ。最下段では1行スクロール(先頭行が落ちる)
 * - 同じ行に後続のテキスト(`\x1b[34m…` などの着色分割)は現在列に追記する
 */
export function screenFrom(raw: string, rows = 40): string[] {
  const grid: string[] = Array.from({ length: rows }, () => '');
  let crow = rows; // TUI起動時のカーソルはシェルの最終行想定
  let col = 1; // 次に書く列(1始まり)
  let clearPending = false; // クリア済み(次の書き込みで行全体を置き換える)
  let i = 0;
  const writeText = (text: string): void => {
    if (clearPending) { grid[crow - 1] = text; clearPending = false; }
    else {
      const start = col - 1;
      const row = grid[crow - 1];
      grid[crow - 1] = row.slice(0, start) + text;
    }
    col += text.length;
  };
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\x1b') {
      const rest = raw.slice(i);
      let m: RegExpExecArray | null = null;
      if ((m = /^\x1b\[([0-9]*)K/.exec(rest)) !== null) { grid[crow - 1] = ''; col = 1; clearPending = true; i += m[0].length; continue; }
      if ((m = /^\x1b\[J/.exec(rest)) !== null) { for (let r = crow; r <= rows; r++) grid[r - 1] = ''; i += m[0].length; continue; }
      if ((m = /^\x1b\[2J/.exec(rest)) !== null) { for (let r = 1; r <= rows; r++) grid[r - 1] = ''; i += m[0].length; continue; }
      if ((m = /^\x1b\[(\d+)A/.exec(rest)) !== null) { crow = Math.max(1, crow - Number(m[1])); i += m[0].length; continue; }
      if ((m = /^\x1b\[(\d+);(\d+)H/.exec(rest)) !== null) {
        crow = Math.max(1, Math.min(rows, Number(m[1])));
        col = Number(m[2]);
        clearPending = col === 1;
        i += m[0].length;
        continue;
      }
      if ((m = /^\x1b\[1;1H/.exec(rest)) !== null) { crow = 1; col = 1; clearPending = true; i += m[0].length; continue; }
      if ((m = /^\x1b(\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/.exec(rest)) !== null) { i += m[0].length; continue; }
      i += 1;
      continue;
    }
    if (c === '\r') { col = 1; i += 1; continue; }
    if (c === '\n') {
      if (crow >= rows) { grid.shift(); grid.push(''); }
      else crow++;
      col = 1;
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
