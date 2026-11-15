#!/usr/bin/env node
// modkh — MoDKH (Mixture of DKH)

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';

const HELP = `modkh ${VERSION} — MoDKH (Mixture of DKH)

使い方:
  modkh [--model <provider>/<model>] [--cwd <dir>] [--resume <id>] [--base-url <url>]
      (サブコマンドなしで起動すると対話ハーネスを開く)
  modkh chat --model <provider>/<model> [--cwd <dir>] [--resume <id>] [--base-url <url>]
  modkh chat --lisp-config agents.lisp --trust-lisp-sha256 SHA256 [--sbcl PATH] [--verification-isolation required|integrity-only]
      [--routing auto] [--lean PATH] [--java PATH --tla-jar PATH]
  modkh auth login chatgpt
  modkh session list
  modkh plugin list | add <directory> | enable <id> | disable <id> | remove <id>
  modkh language status | install [--detected] | retry <id> | update

対話中のコマンド:
  /connect                                     検索できるプロバイダー一覧
  /connect openai                              ChatGPT OAuth / APIキーを選択
  /connect chatgpt                             ブラウザで ChatGPT 認証
  /connect ollama                              Ollama Local のモデル選択
  /connect ollama-cloud                        Ollama Cloud の認証・モデル選択
  /agents                                      子エージェント一覧
  /agents run [ID] [依頼]                       子を選んで限定した仕事を委譲
  /models [検索語]                             名前の部分一致検索・番号でモデル選択
  /reasoning [レベル] [--save]                  推論レベル off/minimal/low/medium/high(既定は前回保存値)
  /connect <provider>/<model> [--base-url <url>]   モデルをその場で接続(AI API / chatgpt / fixed)

接続先:
  fixed/scripted                              固定応答モデル(オフライン検証用)
  openai|anthropic|google|deepseek/<model>    AI SDK アダプター
  opencode|openrouter|infron|ollama|hermes/<model> OpenAI互換アダプター
  ollama-cloud/<model>                        Ollama Cloud (OLLAMA_API_KEY)
  groq|xai|lmstudio/<model>                    既存の互換アダプター
  compatible/<model> --base-url <url>         任意のOpenAI互換URL
  chatgpt/<model>                             Sign in with ChatGPT(/connect で認証可能)

キーは環境変数から読む(例: OPENAI_API_KEY, ANTHROPIC_API_KEY,
GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY, OPENCODE_API_KEY, OPENROUTER_API_KEY,
INFRON_API_KEY, HERMES_API_KEY, OLLAMA_API_KEY, GROQ_API_KEY, XAI_API_KEY)。

TTYではMODKHロゴ・コマンド補完・検索メニューを表示。↑↓/Enterで選択、Escで戻る。
出力は通常のスクリーンバッファに流れるので、端末のスクロール(マウスホイール等)で履歴を辿れる。
各セッションの記録はワークスペースの .modkh/sessions/<id>.md にも保存される(.gitignoreに .modkh/ を追加している)。
timeoutMs(既定600000=10分)は応答の無通信時間の上限。config.json で 5000〜1800000 ms に変更できる。
MODKH_PLAIN=1 modkh で行入力モード(スクリーンリーダー向け)。NO_COLORで色を無効化。
`;

export interface ParsedInvocation {
  cmd: string;
  args: Record<string, string | undefined>;
}

/**
 * 引数を解釈する。最初の非フラグ引数がコマンド。
 * コマンドがない(引数なし、または --cwd 等のフラグのみ)場合は chat を既定とする。
 */
export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const args: Record<string, string | undefined> = {};
  let positional: string[] = [];
  let cmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args['help'] = 'true';
    } else if (a === '--version' || a === '-v') {
      args['version'] = 'true';
    } else if (a?.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[a.slice(2)] = next;
        i++;
      } else {
        args[a.slice(2)] = 'true';
      }
    } else if (cmd === undefined) {
      cmd = a;
    } else {
      positional = [...positional, a];
    }
  }
  args['@positional'] = positional.join(' ');
  return { cmd: cmd ?? 'chat', args };
}

export function main(argv: readonly string[]): void {
  const { cmd, args } = parseInvocation(argv);
  if (args['help'] === 'true') {
    process.stdout.write(HELP);
    return;
  }
  if (args['version'] === 'true') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  void dispatch(cmd, args);
}

async function dispatch(cmd: string, args: Record<string, string | undefined>): Promise<void> {
  try {
    if (cmd === 'chat') {
      const { runChat } = await import('./cli/chat.ts');
      await runChat({ args });
      return;
    }
    if (cmd === 'language') {
      const { runLanguageCommand } = await import('./cli/language.ts');
      await runLanguageCommand(args['@positional'] ?? '', process.cwd());
      return;
    }
    if (cmd === 'plugin') {
      const { runPluginCommand } = await import('./cli/plugins.ts');
      await runPluginCommand(args['@positional'] ?? '');
      return;
    }
    if (cmd === 'auth') {
      if (args['@positional'] !== 'login chatgpt') {
        process.stderr.write('使い方: modkh auth login chatgpt\n');
        process.exit(1);
      }
      const { loginChatGpt } = await import('./model/chatgpt/login.ts');
      const tokens = await loginChatGpt();
      process.stdout.write('ログインしました(トークンはハーネス専用の保存先に保存済み)。\n');
      if (tokens.expiresAt) process.stdout.write(`有効期限: ${tokens.expiresAt}\n`);
      return;
    }
    if (cmd === 'session') {
      const { SessionStore } = await import('./session/store.ts');
      if (args['@positional'] === 'list') {
        const list = new SessionStore().list();
        if (list.length === 0) {
          process.stdout.write('セッションはまだありません。\n');
          return;
        }
        for (const s of list) {
          process.stdout.write(`${s.id}  ${s.status.padEnd(11)}  ${s.createdAt}  ${s.model}  ${s.cwd}\n`);
        }
        return;
      }
      process.stderr.write('使い方: modkh session list\n');
      process.exit(1);
    }
    process.stderr.write(`不明なコマンド: ${cmd}\n\n${HELP}`);
    process.exit(1);
  } catch (e) {
    process.stderr.write(`エラー: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

// 直接起動されたときだけ main を走らせる(import された場合は副作用なし)。
// realpath で比較する(/tmp のようなシンボリックリンク経由の起動に対応)。
const entryArg = process.argv[1];
let isMainModule = false;
if (entryArg !== undefined) {
  try {
    isMainModule = fs.realpathSync(entryArg) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isMainModule = false;
  }
}
if (isMainModule) main(process.argv.slice(2));
