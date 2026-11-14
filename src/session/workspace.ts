import fs from 'node:fs';
import path from 'node:path';
import type { AgentMessage } from '../agent/types.ts';

/** 1メッセージあたりの記録上限。超過は末尾を省いて切る(全文はJSONLに残る)。 */
const MAX_OUTPUT_CHARS = 4000;
const MAX_RECORD_FILES = 50;

export interface RecordableSession {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  status: string;
  messages: AgentMessage[];
}

/** ワークスペースに置く実行記録の保存先(.dkh/sessions/<id>.md)。 */
export function workspaceRecordDir(root: string): string {
  return path.join(root, '.dkh', 'sessions');
}

export function workspaceRecordPath(root: string, id: string): string {
  return path.join(workspaceRecordDir(root), `${id}.md`);
}

function clip(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…(省略 ${text.length - limit} 文字。全文はセッションJSONLを参照)`;
}

/** 人間が読める実行記録(逐次の会話・ツール実行)。内部の推論は含めない。 */
export function renderSessionRecord(session: RecordableSession, unknownToolNames: string[] = []): string {
  const lines: string[] = [
    `# dkh セッション ${session.id}`,
    '',
    `- 作成: ${session.createdAt}`,
    `- モデル: ${session.model}`,
    `- 状態: ${session.status}`,
    ...(unknownToolNames.length ? [`- 注意: 結果不明のツール: ${unknownToolNames.join(', ')}`] : []),
    '',
  ];
  for (const message of session.messages) {
    if (message.role === 'user') {
      lines.push('## You', '', clip(message.content), '');
    } else if (message.role === 'assistant') {
      if (message.content.length > 0) lines.push('## Assistant', '', clip(message.content), '');
      for (const call of message.toolCalls ?? []) {
        lines.push(`### ツール ${call.name}`, '', clip(JSON.stringify(call.args)), '');
      }
    } else {
      for (const result of message.results) {
        lines.push(`### 結果 ${result.name} (${result.status})`, '', clip(result.output), '');
      }
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * セッションをワークスペースに記録する(.dkh/sessions/<id>.md)。
 * 失敗する理由(書き込み不可・ディスク満杯)は呼び出し元へ伝える。上書きは同一セッションのみが対象。
 */
export function recordSessionRecord(root: string, session: RecordableSession, unknownToolNames: string[] = []): string {
  const file = workspaceRecordPath(root, session.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 同一セッションの追記/再書き込みは許し、他セッションの記録を消さない。
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.writeFileSync(file, renderSessionRecord(session, unknownToolNames), { encoding: 'utf8' });
  pruneOldRecords(path.dirname(file));
  return file;
}

function pruneOldRecords(dir: string): void {
  const entries = fs.readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => ({ n, stat: fs.statSync(path.join(dir, n)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  // 新しい50件を残す(既定のワークスペース記録の上限)。削除は .dkh 配下だけを対象にする。
  for (const entry of entries.slice(MAX_RECORD_FILES)) {
    const target = path.join(dir, entry.n);
    if (path.dirname(target) === dir) fs.unlinkSync(target);
  }
}
