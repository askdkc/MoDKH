import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { saveChatGptTokens, type ChatGptTokens } from './tokens.ts';

export interface LoginConfig {
  issuer: string;
  clientId: string;
  redirectPort: number;
}

/** 既定は公式の Sign in with ChatGPT の発行者とCodex相当のクライアント。 */
export const DEFAULT_LOGIN: LoginConfig = {
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoioEEEJzSuZ1pPfKS5baDe',
  redirectPort: 1455,
};

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface AuthorizeOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
  state: string;
}

export function buildAuthorizeUrl(o: AuthorizeOptions): string {
  const u = new URL('/authorize', o.issuer);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('scope', 'openid profile email');
  u.searchParams.set('state', o.state);
  u.searchParams.set('code_challenge', crypto.createHash('sha256').update(o.verifier).digest('base64url'));
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
}

export interface ExchangeOptions {
  issuer: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

/** 認可コードをアクセストークンへ交換する(PKCE code_verifier を送る)。 */
export async function exchangeCode(o: ExchangeOptions): Promise<TokenResponse> {
  const doFetch = o.fetchImpl ?? fetch;
  const res = await doFetch(new URL('/token', o.issuer), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: o.code,
      client_id: o.clientId,
      redirect_uri: o.redirectUri,
      code_verifier: o.verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`トークン交換に失敗した: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    account_id?: string;
  };
  if (!body.access_token) {
    throw new Error('トークン応答に access_token がない');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_in
      ? new Date(Date.now() + body.expires_in * 1000).toISOString()
      : undefined,
    accountId: body.account_id,
  };
}

export interface CallbackResult {
  code: string;
}

/** ローカルHTTPサーバで認可リダイレクトを1回だけ受け取る。 */
export function waitForCallback(port: number, state: string, timeoutMs = 300_000): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('認可の待ち受けがタイムアウトした'));
    }, timeoutMs);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const err = url.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`ログインは承認されなかった: ${err}`);
        clearTimeout(timer);
        server.close();
        reject(new Error(`認可でエラー: ${err}`));
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (!code || returnedState !== state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('不正なリダイレクト');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ログインしました。このタブは閉じてください。');
      clearTimeout(timer);
      server.close(() => resolve({ code }));
    });
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.listen(port, '127.0.0.1');
  });
}

export interface LoginOptions {
  config?: LoginConfig;
  /** ブラウザを開く代わりのフック(検証・CI用)。 */
  openUrl?: (url: string) => void | Promise<void>;
}

/**
 * `dkh auth login chatgpt` の本体。
 * 1) PKCEを用意 2) ブラウザで認可 3) ローカル受信 4) トークン交換 5) 専用保存先へ保存。
 */
export async function loginChatGpt(opts: LoginOptions = {}): Promise<ChatGptTokens> {
  const cfg = opts.config ?? DEFAULT_LOGIN;
  const { verifier } = createPkcePair();
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `http://127.0.0.1:${cfg.redirectPort}/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    redirectUri,
    verifier,
    state,
  });

  const wait = waitForCallback(cfg.redirectPort, state);
  if (opts.openUrl) {
    await opts.openUrl(authorizeUrl);
  } else {
    process.stdout.write(
      `次のURLをブラウザで開いてChatGPTアカウントで承認してください:\n${authorizeUrl}\n待っています... (Ctrl+C で中止)\n`,
    );
  }
  const { code } = await wait;
  const tokens = await exchangeCode({
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    code,
    verifier,
    redirectUri,
  });
  saveChatGptTokens(tokens);
  return tokens;
}
