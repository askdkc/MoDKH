import { stripVTControlCharacters } from 'node:util';
import type { AgentMessage, ToolCall, ToolResult } from '../agent/types.ts';
import { fitText, textWidth } from './editor.ts';
import { shellOutput } from './shell-display.ts';

function brief(value: string, width = 76): string {
  const text = stripVTControlCharacters(value).replace(/[\r\n\t]+/g, ' ').trim();
  return textWidth(text) > width ? `${fitText(text, width - 1)}…` : text;
}
const LABELS: Record<string, string> = {
  view_image: '画像を確認', read_file: '読む', create_file: '作成', edit_file: '編集', list_files: 'ファイル一覧', search_files: '検索',
  run_command: 'コマンド', read_skill: '手順を確認', list_skills: '手順一覧',
  list_subagents: '担当一覧', start_subagent: '子の起動を要求', run_subagent: '子を実行',
  subagent_output: '子の結果', list_subagent_runs: '子の状態',
};
function title(call: ToolCall): string {
  const args = call.args;
  const target = [args.path, args.pattern, args.query, args.name, args.pluginId, args.description]
    .find(value => typeof value === 'string');
  return `${LABELS[call.name] ?? call.name}${target ? ` · ${brief(String(target), 60)}` : ''}`;
}

/** Display a bounded summary only. Exact inputs and outputs remain available through details. */
function resultSummary(result: ToolResult): string[] {
  if (result.name === 'run_command') {
    const lines = shellOutput(result).trim().split('\n');
    return lines.length > 7 ? [...lines.slice(0, 2), '│ …', ...lines.slice(-4)] : lines;
  }
  const lines = result.output.trim().split('\n');
  const status = { ok: '完了', error: 'エラー', unknown: '結果不明', 'not-executed': '未実行' }[result.status];
  if (result.status !== 'ok') return [`${status} · ${lines[0]}`, ...lines.slice(1, 3), ...(lines.length > 3 ? [lines.at(-1)!] : [])];
  if (result.name === 'read_skill') return [`${status} · ${lines.length}行の手順を取得`];
  try {
    const data: unknown = JSON.parse(result.output);
    if (Array.isArray(data)) return [`${status} · ${data.length}件`];
    if (data && typeof data === 'object') {
      const fields = data as Record<string, unknown>;
      const description = [fields.status, fields.summary, fields.message].filter(v => typeof v === 'string').join(' · ');
      return [`${status}${description ? ` · ${description}` : ' · 詳細あり'}`];
    }
  } catch { /* Text output has no structured summary. */ }
  const diagnostics = lines.find(line => line.startsWith('解析:'));
  return [`${status} · ${lines[0] || '出力なし'}`, ...(diagnostics ? [diagnostics] : [])];
}

interface Entry { call: ToolCall; result?: ToolResult }
/** View state only; never feeds truncated output back to the model or session journal. */
export class ToolDisplay {
  private entries: Entry[] = [];
  constructor(messages: readonly AgentMessage[] = []) {
    for (const message of messages) {
      if (message.role === 'assistant') for (const call of message.toolCalls ?? []) this.call(call);
      if (message.role === 'tool') for (const result of message.results) this.result(result);
    }
  }
  call(call: ToolCall): string {
    this.entries.push({ call });
    const command = call.name === 'run_command' && typeof call.args.command === 'string' ? `  $ ${brief(call.args.command)}\n` : '';
    return `\n▶ ${title(call)}\n${command}`;
  }
  result(result: ToolResult): string {
    let index = this.entries.findLastIndex(entry => entry.call.id === result.callId && !entry.result);
    if (index < 0) { this.entries.push({ call: { id: result.callId, name: result.name, args: {} } }); index = this.entries.length - 1; }
    this.entries[index].result = result;
    return resultSummary(result).map(line => `  ${brief(line)}`).join('\n') + `\n  詳細: /tools ${index + 1}\n`;
  }
  details(argument: string): string {
    if (!argument) {
      if (!this.entries.length) return 'ツール履歴はありません。\n';
      return this.entries.slice(-20).map((entry, i) => `${Math.max(0, this.entries.length - 20) + i + 1}. ${title(entry.call)} · ${entry.result?.status ?? '結果未確認'}`).join('\n')
        + '\n/tools <番号>: 引数と結果の全文（直近20件を表示）\n';
    }
    if (!/^[1-9]\d*$/.test(argument)) return '使い方: /tools または /tools <番号>\n';
    const entry = this.entries[Number(argument) - 1];
    if (!entry) return 'その番号のツール履歴はありません。/tools で一覧を確認してください。\n';
    return stripVTControlCharacters(`\nツール詳細 #${argument} · ${entry.call.name}\n引数:\n${JSON.stringify(entry.call.args, null, 2)}\n結果: ${entry.result?.status ?? '未確認'}\n${entry.result?.output ?? '結果はまだありません。'}\n`);
  }
}
