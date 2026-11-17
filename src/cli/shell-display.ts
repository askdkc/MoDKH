/** Display-only shell presentation. Model results and session records keep their full evidence. */
export function shellCall(args: Record<string, unknown>): string {
  const title = typeof args.description === 'string' ? args.description.replace(/\s+/g, ' ').trim() : '';
  const command = typeof args.command === 'string' ? args.command : '';
  const lines = command.split('\n');
  return `\n╭ ${title || 'コマンド実行'}\n${lines.map((line, i) => `│ ${i === 0 ? '$ ' : '  '}${line}`).join('\n')}\n`;
}

export function shellOutput(result: { status: string; output: string }): string {
  const lines = result.output.split('\n');
  // Only the protocol header introduces stdout/stderr. Do not reinterpret arbitrary text
  // from tools without a shell result (approval denial, background promotion, etc.).
  const header = lines.findIndex(line => /^\[exit code: [^\]]+\](?: \[signal: [^\]]+\])?$/.test(line));
  const exit = header < 0 ? undefined : lines[header].match(/^\[exit code: ([^\]]+)\](.*)$/);
  const body = lines.filter((_line, index) => index !== header).map((line, index) => {
    if (header >= 0 && index >= header) {
      if (line === '--- stdout ---') return null;
      if (line === '--- stderr ---') return '標準エラー';
    }
    return line;
  }).filter((line): line is string => line !== null);
  while (body[0] === '') body.shift();
  while (body.at(-1) === '') body.pop();
  const visible = body.length > 20
    ? [...body.slice(0, 8), `… ${body.length - 20}行省略（全文はセッション記録）`, ...body.slice(-12)] : body;
  const status = result.status === 'ok'
    ? exit ? exit[1] === '0' ? '終了' : '失敗' : '受付'
    : result.status === 'unknown' ? '中断・結果不明'
    : result.status === 'not-executed' ? '未実行' : '実行エラー';
  const footer = `${status}${exit ? ` · exit ${exit[1]}${exit[2]}` : ''}`;
  return `${visible.map(line => `│ ${line}`).join('\n')}${visible.length ? '\n' : ''}╰ ${footer}\n\n`;
}
