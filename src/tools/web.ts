import { ToolError, type Tool, type ToolContext } from '../agent/types.ts';
import { resolveApiKey } from '../cli/keys.ts';

/**
 * 外部ネットワークへの取得。ワークスペース内に閉じない唯一の読み取り系ツールなので、
 * `outsideWorkspace: true` で承認を求める。既定の `workspace` ポリシーでも `none` でも
 * 毎回確認され、`all` のときだけ設定どおり自動になる(OSレベルの隔離ではない)。
 *
 * ここで行うのは取得だけであり、結果の真偽は保証しない。本文は上限で打ち切り、
 * 打ち切ったことを必ず明示する(黙って切り詰めない)。
 */

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_BYTES_LIMIT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
/** 抽出後の本文としてモデルへ返す上限。超えたら末尾を落として明示する。 */
const TEXT_BUDGET = 32 * 1024;
const SEARCH_TIMEOUT_MS = 20_000;

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_ENV = 'BRAVE_SEARCH_API_KEY';
const BRAVE_PROVIDER = 'brave-search';

export interface WebOptions {
  /** 検索APIのURL(テスト・社内プロキシ用)。既定は Brave。 */
  searchEndpoint?: string;
  /** 本文取得のバイト上限。 */
  maxBytes?: number;
  /** 取得の制限時間(ms)。 */
  timeoutMs?: number;
  /** 検索APIキーの解決。既定は環境変数→保存済みキー。 */
  keyLookup?: (env: NodeJS.ProcessEnv) => string | undefined;
}

function positiveInt(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ToolError('INVALID_ARGS', `${name} は1〜${max}の整数で指定する`);
  return n;
}

/** http/https のみ。資格情報つきURLは承認ログに秘密が載るため拒否する。 */
function parseTarget(input: unknown): URL {
  if (typeof input !== 'string' || input.trim().length === 0 || input.length > 4096) {
    throw new ToolError('INVALID_ARGS', 'url は1〜4096文字の文字列で指定する');
  }
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new ToolError('INVALID_ARGS', `url を解釈できない: ${input}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError('INVALID_ARGS', `http/https のみ取得できる: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ToolError('INVALID_ARGS', 'URLに資格情報を埋め込まない(承認の表示に秘密が載る)');
  }
  return url;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', middot: '·',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** タグを落とし、ブロック境界だけ改行として残す。整形結果の見た目は保証しない。 */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol)\s*>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/t[dh]\s*>/gi, '\t');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clipText(text: string, budget: number): { text: string; clipped: number } {
  if (text.length <= budget) return { text, clipped: 0 };
  return { text: text.slice(0, budget), clipped: text.length - budget };
}

function charsetOf(contentType: string | null): string {
  const match = /charset\s*=\s*"?([^\s;"]+)/i.exec(contentType ?? '');
  return match?.[1] ?? 'utf-8';
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  try { return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(bytes); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
}

function isTextual(contentType: string | null): boolean {
  if (!contentType) return true;
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml'
    || type === 'application/xhtml+xml' || type === 'application/javascript' || type.endsWith('+json') || type.endsWith('+xml');
}

function isHtml(contentType: string | null): boolean {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

interface BodyRead {
  bytes: Uint8Array;
  truncated: boolean;
  total: number;
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<BodyRead> {
  if (!body) return { bytes: new Uint8Array(0), truncated: false, total: 0 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        chunks.push(value.subarray(0, value.byteLength - (total - limit)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  const kept = Math.min(total, limit);
  const joined = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= kept) break;
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, kept - offset));
    joined.set(slice, offset);
    offset += slice.byteLength;
  }
  return { bytes: joined, truncated, total };
}

function signalFor(ctx: ToolContext, timeoutMs: number): { signal: AbortSignal; timedOut: () => boolean } {
  const timeout = AbortSignal.timeout(timeoutMs);
  let timedOut = false;
  timeout.addEventListener('abort', () => { timedOut = true; }, { once: true });
  return {
    signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
    timedOut: () => timedOut && !(ctx.signal?.aborted ?? false),
  };
}

/** 1ホップごとに承認を取る。転送先は人間が承認したURLとは別の場所になり得るため。 */
async function approveFetch(ctx: ToolContext, url: URL, step: string, extra: string): Promise<void> {
  if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため取得しない');
  const ok = await ctx.approval.approve({
    kind: 'command',
    title: `外部取得 (GET ${url.host})`,
    detail: `${step}\nGET ${url.href}\n${extra}\n\n外部への通信であり、応答内容は検証されない。`,
    outsideWorkspace: true,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!ok) throw new ToolError('DENIED', '承認されなかったため取得しない');
  if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため取得しない');
}

function describeFailure(url: URL, error: unknown, signal: AbortSignal, timedOut: () => boolean, timeoutMs: number): ToolError {
  if (signal.aborted) {
    if (timedOut()) return new ToolError('TIMEOUT', `${timeoutMs}ms で応答がないため打ち切った: ${url.href}`);
    // 要求は送信済みかもしれない。再送の判断は呼び出し側に持たせる。
    return new ToolError('RESULT_UNKNOWN', `中断により結果不明(要求は送信済みの可能性がある): ${url.href}`);
  }
  const cause = error instanceof Error ? (error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message) : String(error);
  return new ToolError('FETCH_FAILED', `取得できない: ${url.href} — ${cause}`);
}

export function createFetchUrlTool(options: WebOptions = {}): Tool {
  const maxBytesLimit = options.maxBytes ?? MAX_BYTES_LIMIT;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    readOnly: true,
    name: 'fetch_url',
    operationIdentity: (args) => ({ url: typeof args.url === 'string' ? args.url.trim() : '' }),
    description:
      'http/https のURLを1件取得し、テキストとして返す。ワークスペース外への通信なので毎回承認を求める。'
      + 'HTMLはタグを落として本文だけにする。上限で打ち切った場合は明示する。'
      + '取得結果は事実の保証ではない(内容の検証はしない)。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 4096, description: '取得するURL(http/https)' },
        maxBytes: { type: 'number', description: `本文のバイト上限(既定 ${DEFAULT_MAX_BYTES}、最大 ${MAX_BYTES_LIMIT})` },
        timeoutMs: { type: 'number', description: `制限時間(ms、既定 ${DEFAULT_TIMEOUT_MS}、最大 ${MAX_TIMEOUT_MS})` },
      },
      required: ['url'],
    },
    async execute(args, ctx) {
      const target = parseTarget(args.url);
      const maxBytes = Math.min(positiveInt(args.maxBytes, 'maxBytes', maxBytesLimit) ?? DEFAULT_MAX_BYTES, MAX_BYTES_LIMIT);
      const timeoutMs = positiveInt(args.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS) ?? defaultTimeout;
      const { signal, timedOut } = signalFor(ctx, timeoutMs);

      let url = target;
      const hops: string[] = [];
      for (let hop = 0; ; hop++) {
        await approveFetch(ctx, url, hop === 0 ? '外部URLの取得' : `転送 ${hop} 回目の取得先`, `本文上限 ${maxBytes} バイト / 制限時間 ${timeoutMs}ms`);
        let response: Response;
        try {
          response = await fetch(url, { method: 'GET', redirect: 'manual', signal, headers: { accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' } });
        } catch (e) {
          throw describeFailure(url, e, signal, timedOut, timeoutMs);
        }
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) {
            throw new ToolError('FETCH_FAILED', `転送が ${MAX_REDIRECTS} 回を超えたため打ち切った: ${target.href} → ${url.href}`);
          }
          let next: URL;
          try { next = new URL(location, url); }
          catch { throw new ToolError('FETCH_FAILED', `転送先のURLを解釈できない: ${location}`); }
          // 転送先も同じ規則で検証してから、改めて承認を取る。
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            throw new ToolError('FETCH_FAILED', `転送先が http/https ではない: ${next.protocol}`);
          }
          if (next.username || next.password) throw new ToolError('FETCH_FAILED', '転送先のURLに資格情報が含まれる');
          hops.push(`${response.status} ${url.href} → ${next.href}`);
          url = next;
          continue;
        }
        let read: BodyRead;
        try { read = await readBounded(response.body, maxBytes); }
        catch (e) {
          if (signal.aborted) throw describeFailure(url, e, signal, timedOut, timeoutMs);
          throw new ToolError('RESULT_UNKNOWN', `本文の受信が途中で失敗した(欠けている可能性がある): ${(e as Error).message}`);
        }
        if (signal.aborted) throw describeFailure(url, undefined, signal, timedOut, timeoutMs);
        const contentType = response.headers.get('content-type');
        const head = [
          `GET ${target.href}`,
          `状態: ${response.status} ${response.statusText}`.trimEnd(),
          `content-type: ${contentType ?? '(なし)'}`,
          `受信: ${read.total} バイト${read.truncated ? `(上限 ${maxBytes} バイトで打ち切り)` : ''}`,
          ...(url.href !== target.href ? [`最終URL: ${url.href}`] : []),
          ...(hops.length ? [`転送: ${hops.length} 回`] : []),
        ];
        if (!isTextual(contentType)) {
          return [...head, '', '本文はテキストではないため表示しない(バイナリ)。'].join('\n');
        }
        if (read.bytes.byteLength === 0) return [...head, '', '本文は空。'].join('\n');
        const raw = decodeBody(read.bytes, contentType);
        const bodyText = isHtml(contentType) ? htmlToText(raw) : raw;
        const clipped = clipText(bodyText, TEXT_BUDGET);
        return [
          ...head,
          '',
          isHtml(contentType) ? '本文(HTML→テキスト):' : '本文:',
          clipped.text.length ? clipped.text : '(本文なし)',
          ...(clipped.clipped ? [`…(本文は上限 ${TEXT_BUDGET} 文字で打ち切り。残り ${clipped.clipped} 文字)`] : []),
          ...(read.truncated ? ['…(受信は上記のバイト上限で打ち切り。続きは未取得)'] : []),
        ].join('\n');
      }
    },
  };
}

interface BraveResult { title?: unknown; url?: unknown; description?: unknown }
interface BraveBody { web?: { results?: unknown } }

/** Brave の応答から必要な3項目だけを取り出す。形が違う場合は失敗として返す。 */
export function parseBraveResults(body: unknown, limit: number): { title: string; url: string; description: string }[] {
  const results = (body as BraveBody)?.web?.results;
  if (!Array.isArray(results)) return [];
  const out: { title: string; url: string; description: string }[] = [];
  for (const row of results as BraveResult[]) {
    if (out.length >= limit) break;
    if (typeof row?.url !== 'string' || !row.url.startsWith('http')) continue;
    out.push({
      title: htmlToText(typeof row.title === 'string' ? row.title : ''),
      url: row.url,
      description: htmlToText(typeof row.description === 'string' ? row.description : ''),
    });
  }
  return out;
}

export function createWebSearchTool(options: WebOptions = {}): Tool {
  const endpoint = options.searchEndpoint ?? BRAVE_ENDPOINT;
  const lookup = options.keyLookup ?? ((env: NodeJS.ProcessEnv) => resolveApiKey(BRAVE_PROVIDER, env, BRAVE_ENV));
  return {
    readOnly: true,
    name: 'web_search',
    description:
      'Web検索を1回行い、タイトル・URL・要約だけを返す(本文は fetch_url で取る)。'
      + `ワークスペース外への通信なので毎回承認を求める。キーは環境変数 ${BRAVE_ENV} か保存済みキー(${BRAVE_PROVIDER})を使う。`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 400, description: '検索語(1〜400文字)' },
        count: { type: 'number', description: '件数(1〜10、既定5)' },
      },
      required: ['query'],
    },
    operationIdentity: (args) => ({ query: typeof args.query === 'string' ? args.query.trim() : '', count: args.count ?? 5 }),
    async execute(args, ctx) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 400 || /[\r\n\0]/.test(query)) {
        throw new ToolError('INVALID_ARGS', 'query は1〜400文字で改行を含まない文字列で指定する');
      }
      const count = positiveInt(args.count, 'count', 10) ?? 5;
      const key = lookup(process.env);
      if (!key) {
        throw new ToolError('NO_KEY', `検索にはAPIキーが必要(環境変数 ${BRAVE_ENV} か、/keys の保存先に ${BRAVE_PROVIDER} を登録する)`);
      }
      const url = new URL(endpoint);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));
      if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため実行しない');
      const ok = await ctx.approval.approve({
        kind: 'command',
        title: `Web検索 (${url.host})`,
        detail: `GET ${url.href}\nクエリ: ${query}\n件数: ${count} 件まで\n\n検索語と利用状況が外部サービスへ送られる。`,
        outsideWorkspace: true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!ok) throw new ToolError('DENIED', '承認されなかったため実行しない');
      if (ctx.signal?.aborted) throw new ToolError('NOT_EXECUTED', '中断済みのため実行しない');

      const { signal, timedOut } = signalFor(ctx, options.timeoutMs ?? SEARCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'error',
          signal,
          headers: { accept: 'application/json', 'x-subscription-token': key },
        });
      } catch (e) {
        throw describeFailure(url, e, signal, timedOut, options.timeoutMs ?? SEARCH_TIMEOUT_MS);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // キーは応答にも要求にも出さない。状態だけを返す。
        throw new ToolError('SEARCH_FAILED', `検索APIが失敗した: ${response.status} ${response.statusText}`.trimEnd());
      }
      let body: unknown;
      try { body = await response.json(); }
      catch { throw new ToolError('RESULT_UNKNOWN', '検索結果をJSONとして読めなかった(結果不明)'); }
      const hits = parseBraveResults(body, count);
      if (hits.length === 0) return `検索 "${query}": 0 件。結果の形が想定と違うか、該当なし。`;
      const lines = hits.map((hit, i) => `${i + 1}. ${hit.title || '(無題)'}\n   ${hit.url}${hit.description ? `\n   ${hit.description}` : ''}`);
      return [`検索 "${query}": ${hits.length} 件(上限 ${count} 件)`, ...lines].join('\n');
    },
  };
}

export const fetchUrlTool: Tool = createFetchUrlTool();
export const webSearchTool: Tool = createWebSearchTool();
export const webTools: Tool[] = [fetchUrlTool, webSearchTool];
