import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createChatGPT, type CredentialEncryption } from './devkit/index.ts';
import { chatGptAuthPath, markChatGptConnected } from './tokens.ts';
import { spawn } from 'node:child_process';

export interface LoginOptions {
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

function keyringEncryption(directory: string): CredentialEncryption {
  const account = createHash('sha256').update(directory).digest('hex');
  async function entry() {
    const { default: keyring } = await import('@napi-rs/keyring');
    return new keyring.AsyncEntry('MoDKH Sign in with ChatGPT', account, { linux: { store: 'secret-service' } });
  }
  return {
    id: 'modkh-os-keyring-aes256gcm-v1',
    async isAvailable() { await (await entry()).getSecret(); return true; },
    async encrypt(text) {
      // The DevKit holds its per-directory interprocess lock during encryption.
      const store = await entry();
      const saved = await store.getSecret();
      const key = saved ? Buffer.from(saved) : randomBytes(32);
      if (!saved) await store.setSecret(key);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    async decrypt(bytes) {
      const key = await (await entry()).getSecret();
      if (!key) throw new Error('ChatGPT の保存鍵が見つかりません');
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

function client(openBrowser?: LoginOptions['openUrl']) {
  const storageDir = path.resolve(path.dirname(chatGptAuthPath()), 'siwc');
  return createChatGPT({ appName: 'MoDKH', appId: 'modkh', redirectPort: 0, sendHostId: true,
    storageDir, openBrowser, credentialEncryption: keyringEncryption(storageDir) });
}

export async function planAccessToken(signal?: AbortSignal): Promise<string> {
  return client().planAccessToken(signal);
}

export async function loginChatGpt(opts: LoginOptions = {}): Promise<void> {
  const write = opts.write ?? ((message: string) => process.stdout.write(message));
  const sdk = client(opts.openUrl ?? (async url => {
    write(`ChatGPT の認証画面を開きます。手動で開く場合は次の URL を使用してください。\n${url}\nCtrl+C で中止\n`);
    await openBrowser(url).catch(() => write('ブラウザで上の URL を開いてください。\n'));
  }));
  const ac = new AbortController();
  const cancel = () => ac.abort();
  process.on('SIGINT', cancel);
  try {
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(opts.timeoutMs ?? 300_000), ...(opts.signal ? [opts.signal] : [])]);
    const current = await sdk.getSession();
    const pending = current.profileId ? undefined : (await sdk.listProfiles()).find(profile => profile.pending);
    const session = await sdk.signIn({ signal, reconsent: true, profileId: pending?.id });
    if (!session.sharing) throw new Error('モデルを使うには ChatGPT プラン利用の許可が必要です。/connect chatgpt で再接続してください');
    markChatGptConnected();
  } finally { process.removeListener('SIGINT', cancel); }
}
