import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { saveChatGptTokens, loadChatGptTokens, type ChatGptTokens } from './tokens.ts';

export interface LoginConfig { issuer: string; clientId: string; redirectPort: number }
export const DEFAULT_LOGIN: LoginConfig = {
  issuer: 'https://auth.openai.com', clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', redirectPort: 1455,
};
export interface PkcePair { verifier: string; challenge: string }
export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
export interface AuthorizeOptions {
  issuer: string; clientId: string; redirectUri: string; verifier: string; state: string;
}
export function buildAuthorizeUrl(o: AuthorizeOptions): string {
  const u = new URL('/oauth/authorize', o.issuer);
  u.search = new URLSearchParams({ response_type: 'code', client_id: o.clientId,
    redirect_uri: o.redirectUri, scope: 'openid profile email offline_access', state: o.state,
    code_challenge: crypto.createHash('sha256').update(o.verifier).digest('base64url'),
    code_challenge_method: 'S256', id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true',
  }).toString();
  return u.toString();
}
function jwtExpiry(token: string): string | undefined {
  try {
    const exp: unknown = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000).toISOString() : undefined;
  } catch { return undefined; }
}
export type TokenResponse = ChatGptTokens;
export interface ExchangeOptions {
  issuer: string; clientId: string; code: string; verifier: string; redirectUri: string;
  fetchImpl?: typeof fetch; signal?: AbortSignal;
}

/** Read account routing metadata, not an authorization decision. The server validates the token. */
function tokenAccount(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  try {
    const body = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const account: unknown = body['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof account === 'string' ? account : undefined;
  } catch { return undefined; }
}
async function requestTokens(config: Pick<LoginConfig, 'issuer' | 'clientId'>, fields: Record<string, string>,
  signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ChatGptTokens> {
  const res = await fetchImpl(new URL('/oauth/token', config.issuer), {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...fields }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  // Never print token endpoint bodies: they may include credentials or the submitted code.
  if (!res.ok) throw new Error(`トークン交換に失敗した: HTTP ${res.status}。/connect chatgpt で再認証してください`);
  const body = await res.json() as Record<string, unknown>;
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('トークン応答に access_token がない');
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: typeof body.expires_in === 'number' && body.expires_in > 0
      ? new Date(Date.now() + body.expires_in * 1000).toISOString() : jwtExpiry(body.access_token),
    accountId: typeof body.account_id === 'string' ? body.account_id
      : tokenAccount(body.id_token) ?? tokenAccount(body.access_token),
  };
}
export function exchangeCode(o: ExchangeOptions): Promise<TokenResponse> {
  return requestTokens(o, { grant_type: 'authorization_code', code: o.code,
    redirect_uri: o.redirectUri, code_verifier: o.verifier }, o.signal, o.fetchImpl);
}

/** Refresh only before sending a new model request; never replay a failed model request. */
export async function currentChatGptTokens(signal?: AbortSignal): Promise<ChatGptTokens> {
  const tokens = loadChatGptTokens();
  if (!tokens) throw new Error('ChatGPTにログインしていない: /connect chatgpt で認証してください');
  const expiry = tokens.expiresAt ?? jwtExpiry(tokens.accessToken);
  if (!expiry || Date.parse(expiry) > Date.now() + 60_000) return tokens;
  if (!tokens.refreshToken) throw new Error('ChatGPTの認証期限が切れています。/connect chatgpt で再認証してください');
  const renewed = await requestTokens(DEFAULT_LOGIN, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken }, signal);
  signal?.throwIfAborted();
  const result = { ...renewed, refreshToken: renewed.refreshToken ?? tokens.refreshToken, accountId: renewed.accountId ?? tokens.accountId };
  saveChatGptTokens(result);
  return result;
}

export interface LoginOptions {
  config?: LoginConfig;
  openUrl?: (url: string) => void | Promise<void>;
  write?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('ブラウザ起動がタイムアウトしました')); }, 5000);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ブラウザを開けません')); });
  });
}

/** Own the listener from bind through exchange/save; the browser reports success only after saving. */
export async function loginChatGpt(opts: LoginOptions = {}): Promise<ChatGptTokens> {
  const cfg = opts.config ?? DEFAULT_LOGIN;
  const write = opts.write ?? ((text: string) => process.stdout.write(text));
  const ac = new AbortController();
  const signal = AbortSignal.any([ac.signal, ...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.timeoutMs ?? 300_000)]);
  signal.throwIfAborted();
  const onSigint = () => ac.abort(new Error('認証を中止しました'));
  process.on('SIGINT', onSigint);
  const { verifier } = createPkcePair();
  const state = crypto.randomBytes(24).toString('hex');
  let redirectUri = '';
  let claimed = false;
  let resolveResult!: (tokens: ChatGptTokens) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<ChatGptTokens>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Attach a handler immediately; bind/browser failures can happen before the caller awaits result.
  void result.catch(() => {});
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const reply = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }); res.end(text);
    };
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { reply(404, 'Not found'); return; }
    if (url.searchParams.get('state') !== state) { reply(400, '不正な認証stateです。元の認証画面からやり直してください。'); return; }
    if (claimed) { reply(409, '認証処理中です。端末を確認してください。'); return; }
    const code = url.searchParams.get('code');
    if (url.searchParams.has('error') || !code) {
      reply(400, '認証は完了しませんでした。MODKHで再試行してください。');
      rejectResult(new Error('認証が拒否されたか、認可コードがありません。/connect chatgpt で再試行してください'));
      return;
    }
    claimed = true;
    write('認可を受信しました。トークンを交換しています…\n');
    void exchangeCode({ ...cfg, code, verifier, redirectUri, signal }).then((tokens) => {
      signal.throwIfAborted();
      saveChatGptTokens(tokens);
      reply(200, 'MODKH: 認証情報を保存しました。このタブを閉じて端末へ戻ってください。');
      resolveResult(tokens);
    }).catch((error: Error) => { reply(500, 'MODKH: 認証を保存できませんでした。端末の案内を確認してください。'); rejectResult(error); });
  });
  const onAbort = () => rejectResult(new Error(signal.reason?.name === 'TimeoutError'
    ? '認証がタイムアウトしました。/connect chatgpt で再試行してください' : '認証を中止しました'));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.redirectPort, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', rejectResult);
    signal.throwIfAborted();
    const port = (server.address() as AddressInfo).port;
    redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const url = buildAuthorizeUrl({ ...cfg, redirectUri, verifier, state });
    if (opts.openUrl) await opts.openUrl(url);
    else {
      write(`ChatGPTのブラウザ認証を開きます。開かない場合は次のURLを使用してください:\n${url}\n待機中… Ctrl+C で中止\n`);
      await openBrowser(url).catch(() => write('ブラウザを自動起動できませんでした。上のURLを手動で開いてください。\n'));
    }
    return await result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`認証ポート ${cfg.redirectPort} は使用中です。他のログイン処理を終了してから /connect chatgpt で再試行してください`);
    }
    throw error;
  } finally {
    ac.abort();
    signal.removeEventListener('abort', onAbort);
    process.removeListener('SIGINT', onSigint);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
