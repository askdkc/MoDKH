// 行単位の最小 unified diff。外部依存を増やさないために簡易 LCS で実装する。
// 編集対象は小さいことが前提で、O(n*m) の表は実用上十分。

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');
  // 末尾改行による空の最終行を揃える
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();

  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] と b[j..] の LCS 長
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ kind: 'add', text: b[j] }); j++; }
  return out;
}

export function renderDiff(title: string, before: string, after: string): string {
  const lines = diffLines(before, after);
  const parts: string[] = [`--- ${title}`, `+++ ${title}`];
  let k = 0;
  let addCount = 0;
  let delCount = 0;
  for (const l of lines) {
    if (l.kind === 'add') addCount++;
    if (l.kind === 'del') delCount++;
  }
  parts.push(`@@ -${0},+${0} @@ (${addCount} 追加, ${delCount} 削除)`);
  while (k < lines.length) {
    if (lines[k].kind === 'context') { parts.push(`  ${lines[k].text}`); k++; continue; }
    let s = k;
    while (k < lines.length && lines[k].kind !== 'context') k++;
    // 変更ブロックの前後1行を文脈として出す
    const start = Math.max(0, s - 1);
    const end = Math.min(lines.length, k + 1);
    for (let t = start; t < end; t++) {
      const kind = lines[t].kind;
      const prefix = kind === 'add' ? '+ ' : kind === 'del' ? '- ' : '  ';
      parts.push(prefix + lines[t].text);
    }
  }
  return parts.join('\n');
}
