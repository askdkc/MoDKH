import { stripVTControlCharacters } from 'node:util';
import type { Model } from '../agent/types.ts';
import { writeCheck } from './cyber-report.ts';

export const securityHeaders = [
  'content-security-policy', 'x-content-type-options', 'referrer-policy', 'permissions-policy',
  'x-frame-options', 'cross-origin-opener-policy',
] as const;

export function cookieAttributes(cookie: string): Set<string> {
  return new Set(cookie.split(';').slice(1).map(part => part.split('=', 1)[0].trim().toLowerCase()));
}

/** Only fixed field names, booleans and counts can cross the model boundary. */
export function responseEvidence(status: number, https: boolean, fields: readonly [string, string][]) {
  const has = (name: string) => fields.some(([key, value]) => key === name && value.trim() !== '');
  const cookies = fields.filter(([key]) => key === 'set-cookie').map(([, value]) => cookieAttributes(value));
  return {
    httpStatus: status, https,
    presentHeaders: securityHeaders.filter(has),
    missingHeaders: securityHeaders.filter(name => !has(name)),
    cspFrameAncestors: fields.some(([key, value]) =>
      key === 'content-security-policy' && /(?:^|;)\s*frame-ancestors\s+[^;\s]/i.test(value)),
    ...(https ? { hstsPresent: has('strict-transport-security') } : {}),
    setCookieCount: cookies.length,
    cookiesWithoutHttpOnly: cookies.filter(attrs => !attrs.has('httponly')).length,
    cookiesWithoutSameSite: cookies.filter(attrs => !attrs.has('samesite')).length,
    ...(https ? { cookiesWithoutSecure: cookies.filter(attrs => !attrs.has('secure')).length } : {}),
  };
}

export type ResponseEvidence = ReturnType<typeof responseEvidence>;

export async function writeCyberReview(model: Model | null, evidence: ResponseEvidence | undefined, signal: AbortSignal, write: (text: string) => void) {
  if (signal.aborted) return;
  const name = 'AI による設定レビュー';
  if (!model || !evidence) {
    writeCheck(write, { name, status: '未実行', lines: [!model
      ? '/connect で言語モデルを選ぶと、HTTP 設定の所見と修正案を表示します。'
      : 'GET の応答ヘッダーを確認できませんでした。'] });
    return;
  }
  write(`▶ HTTP 設定をレビュー中（${model.id}）\n`);
  const deadline = AbortSignal.timeout(120_000);
  const reviewSignal = AbortSignal.any([signal, deadline]);
  const system = 'あなたはサイト管理者を支援します。JSON は1回の GET 応答の観測です。'
    + 'HTTP ステータスと観測範囲に即し、重要な設定を最大3点、根拠・影響・具体的な修正案の順で簡潔に日本語で説明してください。'
    + 'ヘッダーの存在と設定値の妥当性を区別し、個別の Cookie の用途や実害は推測しないでください。'
    + 'CSP の frame-ancestors は X-Frame-Options の代替になります。未観測の脆弱性を断定せず、追加のスキャンや攻撃手順は提案しないでください。';
  let answer = '';
  let complete = false;
  try {
    for await (const event of model.stream({
      system, messages: [{ role: 'user', content: JSON.stringify(evidence) }], tools: [],
    }, reviewSignal)) {
      if (reviewSignal.aborted || event.type === 'tool-call') break;
      if (event.type === 'text-delta') {
        answer += event.text;
        if (answer.length > 12_000) break;
      }
      if (event.type === 'finish') { complete = event.stopReason === 'stop'; break; }
    }
  } catch { /* Keep the observed report available when the provider fails. */ }
  if (signal.aborted) return;
  const visible = stripVTControlCharacters(answer).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').trim();
  if (!complete || !visible || reviewSignal.aborted) {
    writeCheck(write, { name, status: '失敗', lines: [deadline.aborted ? 'モデルの応答が時間切れになりました。' : 'モデルから所見を取得できませんでした。'] });
    return;
  }
  writeCheck(write, { name, status: '情報', lines: visible.split('\n') });
}
