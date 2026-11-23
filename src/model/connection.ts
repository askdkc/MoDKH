import type { Model, ModelEvent } from '../agent/types.ts';
import { FixedModel, type FixedStep } from './fixed.ts';
import { parseModelRef, resolveModel, type ModelSpec } from './factory.ts';
import { planAccessToken } from './chatgpt/login.ts';
import { hasChatGptConnection } from './chatgpt/tokens.ts';
import { ResponsesApiModel } from './chatgpt/responses.ts';
import { fetchModel } from './record-fetch.ts';

/** オフライン検証用の既定スクリプト(読む→編集→テスト実行→完了)。 */
function defaultFixedSteps(): FixedStep[] {
  const delta = (t: string): ModelEvent => ({ type: 'text-delta', text: t });
  return [
    [
      delta('作業ルートの内容を確認します。'),
      { type: 'tool-call', call: { id: 'f-list', name: 'list_files', args: {} } },
      { type: 'finish', stopReason: 'tool-calls' },
    ],
    [
      delta('README.md を読みます。'),
      { type: 'tool-call', call: { id: 'f-read', name: 'read_file', args: { path: 'README.md' } } },
      { type: 'finish', stopReason: 'tool-calls' },
    ],
    [
      delta('ルート外は参照できないことを確認します。'),
      { type: 'tool-call', call: { id: 'f-out', name: 'read_file', args: { path: '../outside.txt' } } },
      { type: 'finish', stopReason: 'tool-calls' },
    ],
    [
      delta('メモを追記します。'),
      { type: 'tool-call', call: { id: 'f-edit', name: 'edit_file', args: { path: 'README.md', old_string: '# modkh サンプル', new_string: '# modkh サンプル\n\n(固定応答モデルによる追記)' } } },
      { type: 'finish', stopReason: 'tool-calls' },
    ],
    [
      delta('実行マーカーを書きます。'),
      { type: 'tool-call', call: { id: 'f-mark', name: 'run_command', args: { command: 'echo 実行マーカー > marker.txt; sleep 2' } } },
      { type: 'finish', stopReason: 'tool-calls' },
    ],
    [
      delta('ノードのバージョンを確認します。'),
      { type: 'tool-call', call: { id: 'f-run', name: 'run_command', args: { command: 'node --version' } } },
      { type: 'finish', stopReason: 'tool-calls' },
    ],
    [
      delta('固定シナリオを終了しました。各操作の成否は上のツール結果を参照してください。ユーザーの依頼は解釈していません。'),
      { type: 'finish', stopReason: 'stop' },
    ],
  ];
}

export interface BuildModelOptions {
  /** 無通信タイムアウト(ms)。config の timeoutMs を渡して調整できる。 */
  timeoutMs?: number;
}

export function buildModelFromRef(ref: string, baseUrl?: string, fixedSkip?: number, apiKey?: string, opts?: BuildModelOptions): Model {
  if (ref.startsWith('fixed/')) {
    return new FixedModel(defaultFixedSteps(), { skip: fixedSkip ?? 0 });
  }
  if (ref.startsWith('chatgpt/')) {
    if (!hasChatGptConnection()) {
      throw new Error('ChatGPTにログインしていない: /connect chatgpt または modkh auth login chatgpt を実行する');
    }
    return new ResponsesApiModel({
      getAccessToken: planAccessToken,
      model: ref.slice('chatgpt/'.length),
      fetchImpl: fetchModel,
    });
  }
  const spec: ModelSpec = { ...parseModelRef(ref), baseUrl, apiKey, ...(opts ? { timeoutMs: opts.timeoutMs } : {}) };
  return resolveModel(spec);
}

