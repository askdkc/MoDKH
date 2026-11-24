import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';
import { configureHttpModelRecording } from '../model/record-fetch.ts';
import { SessionStore } from '../session/store.ts';
import { loadConfig } from './config.ts';
import { loadResumedSession, selectInitialConnection } from './initial-connection.ts';
import { ensureWorkspaceIgnores } from './workspace-ignore.ts';

/**
 * 記録の状態は会話の成否とは別の軸。会話が正常に終わっても記録が欠けていることはあるし、
 * モデル要求の前に閉じた会話は記録が空でも会話としては正常。終了コードだけで両者を
 * 混ぜないよう、実際に起動した記録についてだけこの型で結果を持つ。
 *
 * 記録を起動しなかった場合(明示的な無効化、既に記録器の中、`agenticreplay` が無い)は
 * `recordChat` が `undefined` を返す。それは「記録の状態」ではなく「記録が無い」。
 */
export type RecordingStatus =
  /** 記録は走ったが、モデル要求を1件も観測していない。 */
  | 'no-request'
  /** 記録が途中で欠けた。 */
  | 'incomplete'
  /** 記録は完了した。 */
  | 'complete'
  /** 記録は走ったが、この実行の結果を確認できない。 */
  | 'unverified';

export interface RecordingOutcome {
  status: RecordingStatus;
  runId?: string;
  requests?: number;
  responses?: number;
  /** 記録器が報告した不足の理由(例: no_requests_observed)。秘密値は含まない。 */
  issues?: string[];
  /** 記録器の終了コード。会話側の終了コードとは別に保持する。 */
  recorderExitCode?: number;
}

export interface RecordedChat {
  /** 会話の終了コード。記録の状態によって変えない。 */
  exitCode: number;
  /** 実際に起動した記録の結果。起動していない・無効なら undefined。 */
  recording?: RecordingOutcome;
}

/**
 * 記録器が起動した子から親へ渡す受け取り。ディレクトリは起動時に親が子のためだけに
 * 決めたパスなので、他の実行と取り違えない。「一番新しい run」のような推測をしない。
 */
export interface RecordingReceipt {
  /** 記録器が子にだけ渡す証明書のパス。ここから実行ディレクトリが決まる。 */
  tlsCa?: string;
}

/** 記録器は子の環境にだけ `AGENTICREPLAY_TLS_CA` を渡す。そのパスは `…/runs/<run>/tls/ca.crt`。 */
export function runDirFromTlsCa(caPath: string | undefined): string | undefined {
  if (!caPath) return undefined;
  const dir = path.dirname(path.dirname(path.resolve(caPath)));
  return path.basename(path.dirname(dir)) === 'runs' ? dir : undefined;
}

interface ManifestCapture {
  status?: unknown;
  issues?: unknown;
  requests?: unknown;
  responses?: unknown;
}

/**
 * 記録器のマニフェストから、capture の状態と要求・応答の件数、不足理由、run ID だけを読む。
 * 会話本文やイベント本文は読まない。
 */
export function readManifest(runDir: string): { runId?: string; capture?: ManifestCapture } | undefined {
  try {
    const file = path.join(runDir, 'manifest.json');
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { run_id?: unknown; capture?: ManifestCapture };
    return {
      ...(typeof manifest.run_id === 'string' ? { runId: manifest.run_id } : {}),
      ...(manifest.capture && typeof manifest.capture === 'object' ? { capture: manifest.capture } : {}),
    };
  } catch {
    return undefined;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function issueList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value.filter((item): item is string => typeof item === 'string' && item.length <= 120);
  return issues.length ? issues : undefined;
}

function counts(capture: ManifestCapture | undefined): Pick<RecordingOutcome, 'requests' | 'responses'> {
  const requests = count(capture?.requests);
  const responses = count(capture?.responses);
  return { ...(requests !== undefined ? { requests } : {}), ...(responses !== undefined ? { responses } : {}) };
}

/**
 * 記録の結果を決める。証拠は、この実行に対応づけられたディレクトリのマニフェストだけ。
 * 読めなければ `unverified` とし、推測で「完了」とは言わない。
 */
export function summarizeRecording(
  runDir: string | undefined, recorderExitCode: number,
): RecordingOutcome {
  const outcome: RecordingOutcome = { status: 'unverified', recorderExitCode };
  let manifest = runDir ? readManifest(runDir) : undefined;
  // AgenticReplay renames a sealed run using the first prompt, retaining the run ID suffix.
  if (!manifest && runDir) {
    const suffix = /^\d{14}-[a-z0-9-]+-([a-f0-9]{6,32})$/.exec(path.basename(runDir))?.[1];
    if (suffix) {
      const parent = path.dirname(runDir);
      try {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.endsWith(`-${suffix}`)) continue;
          const candidate = readManifest(path.join(parent, entry.name));
          if (candidate?.runId === `run_${suffix}`) { manifest = candidate; break; }
        }
      } catch { /* The run is unavailable. */ }
    }
  }
  const capture = manifest?.capture;
  if (!capture) return outcome;
  const issues = issueList(capture.issues);
  const measured: RecordingOutcome = {
    ...outcome,
    ...(manifest?.runId ? { runId: manifest.runId } : {}),
    ...counts(capture),
    ...(issues ? { issues } : {}),
  };
  if (capture.status === 'complete') return { ...measured, status: 'complete' };
  if (capture.status === 'incomplete') {
    // モデル要求を1件も観測していない記録は「欠けた」ではなく「空」。会話の成否とは別。
    const empty = issues?.includes('no_requests_observed') ?? false;
    return { ...measured, status: empty ? 'no-request' : 'incomplete' };
  }
  return measured;
}

/**
 * 記録が欠けた・確認できないときだけ、一度だけ短く知らせる。秘密値・接続先は出さない。
 * 終了コードは会話の結果のまま。
 */
export function formatRecordingDiagnostic(outcome: RecordingOutcome): string | undefined {
  const where = outcome.runId ? ` run ${outcome.runId}` : '';
  const reason = outcome.issues?.length ? ` (${outcome.issues.join(', ')})` : '';
  const note = '会話の終了コードは変えていません';
  if (outcome.status === 'no-request') {
    return `(記録: モデル要求を観測していません${reason}。${where}${where ? ' — ' : ''}${note})\n`;
  }
  if (outcome.status === 'incomplete') {
    const seen = outcome.requests === undefined ? '' : ` [要求${outcome.requests}/応答${outcome.responses ?? 0}]`;
    return `(記録: 不完全${reason}${seen}。${where}${where ? ' — ' : ''}${note})\n`;
  }
  if (outcome.status === 'unverified') {
    return `(記録: 未検証 — この実行の記録結果を確認できませんでした。${where ? `${where.trim()} ` : ''}終了コードは会話の結果です)\n`;
  }
  return undefined;
}

/**
 * 起動時に記録対象として渡したホスト。子はこの一覧と接続先を照合するだけで、
 * 記録器の既定一覧を推測しない。`+host` の加算指定なので「既定 ∪ ここ」が対象。
 */
export interface RecordingScope {
  /** 起動時に `--tls-hosts +host` で足したホスト。 */
  added: string[];
  /** 記録器が既定で傍受するホスト(記録器の stderr から取得できた場合のみ)。 */
  defaults: string[];
  /** この実行の記録を起動したか。false なら照合しない。 */
  active: boolean;
}

/**
 * 子は自分の記録対象を、自分の実行ディレクトリの events.jsonl から読む。記録器は起動時に
 * `tls_intercept` の note をそこへ書くので、記録器の内部既定一覧を推測せずに済む。
 * 読めない・まだ書かれていない場合は「判定不能」として警告しない。
 */
export function readRecordingScope(): RecordingScope | undefined {
  const caPath = process.env.AGENTICREPLAY_TLS_CA;
  const runDir = runDirFromTlsCa(caPath);
  if (!runDir) return undefined;
  try {
    const events = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8');
    for (const line of events.split('\n')) {
      if (!line.includes('tls_intercept')) continue;
      const event = JSON.parse(line) as { attrs?: { rule?: unknown; hosts?: unknown } };
      if (event.attrs?.rule !== 'tls_intercept' || typeof event.attrs.hosts !== 'string') continue;
      const hosts = event.attrs.hosts.split(',').map(host => host.trim()).filter(Boolean);
      return { added: [], defaults: hosts, active: hosts.length > 0 };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 記録器の `tls.intercepting hosts="…"` 行から既定の対象ホストを読む。 */
export function parseInterceptedHosts(stderr: string): string[] {
  for (const line of stderr.split('\n')) {
    const match = /tls\.intercepting hosts="([^"]*)"/.exec(line);
    if (!match) continue;
    return match[1].split(',').map(host => host.trim()).filter(host => host.length > 0);
  }
  return [];
}

/**
 * 接続先が記録対象に入っているか。events.jsonl の `tls_intercept` は展開後の一覧なので、
 * ここでは完全一致と `*.` の1段以上のサブドメイン一致だけを扱う。
 */
export function classifyHost(host: string | undefined, scope: RecordingScope): 'recorded' | 'not-recorded' | 'unknown' {
  if (!scope.active || !host) return 'unknown';
  const name = host.toLowerCase();
  const matches = (pattern: string): boolean => {
    const rule = pattern.toLowerCase();
    if (rule === name) return true;
    // `*.example.com` はサブドメインにだけ一致する(apex を含まない)。
    return rule.startsWith('*.') && name.endsWith(rule.slice(1)) && name.length > rule.length - 1;
  };
  return [...scope.defaults, ...scope.added].some(matches) ? 'recorded' : 'not-recorded';
}

/**
 * 記録対象外へ切り替えたことを一度だけ伝える。接続自体は止めない。
 * 秘密値(URL のパス・クエリ・認証情報)は出さず、ホスト名だけを扱う。
 */
export function formatHostCoverageNotice(host: string, scope: RecordingScope): string | undefined {
  if (classifyHost(host, scope) !== 'not-recorded') return undefined;
  const safe = /^[a-z0-9.:[\]-]{1,253}$/i.test(host) ? host : 'この接続先';
  return `(記録: ${safe} は記録対象外です。この接続先の通信は残りません。記録するなら起動時に指定してください)\n`;
}

/**
 * 記録器から起動された子は、自分が記録されている実行を親へ知らせる。
 * パスは親がこの子のためだけに渡すので、他の実行と取り違えない。
 */
function reportReceipt(caPath: string | undefined): void {
  const file = process.env.MODKH_AGENTICREPLAY_RECEIPT;
  if (!file) return;
  delete process.env.MODKH_AGENTICREPLAY_RECEIPT;
  try { writeFileSync(file, JSON.stringify({ ...(caPath ? { tlsCa: caPath } : {}) } satisfies RecordingReceipt), { mode: 0o600 }); }
  catch { /* 書けなくても会話は続く。記録の状態は未検証になるだけ */ }
}

function readReceipt(file: string): RecordingReceipt | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as RecordingReceipt;
    return typeof raw === 'object' && raw !== null ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** stderr が閉じていても診断の失敗で会話を落とさない。 */
function writeStderr(text: string): void {
  try { process.stderr.write(text); } catch { /* 表示先がないだけ */ }
}

export async function recordChat(
  entry: string, argv: readonly string[], args: Readonly<Record<string, string | undefined>>,
): Promise<RecordedChat | undefined> {
  const launchCwd = process.env.MODKH_AGENTICREPLAY_LAUNCH_CWD;
  if (launchCwd && process.env.AGENTICREPLAY_TLS_CA) {
    // The recorder starts in the workspace, while chat resolves CLI paths from the launch directory.
    process.chdir(launchCwd);
    delete process.env.MODKH_AGENTICREPLAY_LAUNCH_CWD;
    reportReceipt(process.env.AGENTICREPLAY_TLS_CA);
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    // AgenticReplay uses the negotiated protocol upstream too. Some model APIs only offer HTTP/1.1.
    setGlobalDispatcher(new EnvHttpProxyAgent({ requestTls: { allowH2: false } }));
    configureHttpModelRecording(process.env.HTTPS_PROXY);
    return undefined;
  }
  if (process.env.MODKH_AGENTICREPLAY === '0' ||
      process.env.AGENTICREPLAY_TLS_CA || process.env.AGENTICREPLAY_PROXY_URL) return undefined;

  const cwd = path.resolve(args.cwd ?? process.cwd());
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const probe = spawnSync('agenticreplay', ['version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 4096,
  });
  if (probe.status !== 0 || !probe.stdout?.trim()) return undefined;

  const config = loadConfig();
  const session = args.resume ? loadResumedSession(new SessionStore(), args.resume, cwd) : undefined;
  const { model, baseUrl } = selectInitialConnection(args, config, session);
  const provider = model?.match(/^([^/]+)\/.+/)?.[1];
  const { modelBaseUrl } = await import('../model/factory.ts');
  const target = provider ? URL.parse(modelBaseUrl(provider, baseUrl) ?? '') : null;
  // AgenticReplay interprets commas and wildcards as policy syntax.
  const tlsHosts = target?.protocol === 'https:' && !/[,\x2a]/.test(target.hostname)
    ? ['--tls-hosts', `+${target.hostname}`] : [];
  // 受け取りはこの子のためだけのパス。stderr も TUI と共有しているので読まずに転送する。
  // 作業ルートには書かない(記録対象でも会話の成果物でもない)。
  // 記録器はワークスペースの .agenticreplay/ を先に作るので、その前に .gitignore を揃えておく。
  // 失敗の報告は、直後に起動して同じ処理を行う会話側(runChat)に任せ、二重に出さない。
  try {
    ensureWorkspaceIgnores(cwd);
  } catch { /* 会話側が改めて試し、失敗すればそこで報告する */ }
  const receipt = path.join(tmpdir(), `modkh-receipt-${process.pid}-${Date.now().toString(36)}.json`);
  try {
    const child = spawn('agenticreplay', [
      'record', 'exec', '--tls-intercept', ...tlsHosts, '--no-fs', '--no-shell', '--no-agent-spans', '--',
      process.execPath, ...process.execArgv, entry, ...argv,
    ], { cwd, stdio: 'inherit', env: {
      ...process.env, AGENTICREPLAY_CONTINUE_ON_STORAGE_LIMIT: '1', MODKH_AGENTICREPLAY_LAUNCH_CWD: process.cwd(), MODKH_AGENTICREPLAY_RECEIPT: receipt,
    } });

    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTermination = () => child.kill('SIGTERM');
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTermination);
    try {
      return await new Promise<RecordedChat | undefined>(resolve => {
        child.once('error', error => {
          // 記録できないだけで会話は続けられる。起動失敗は1回だけ伝え、記録なしで走る。
          writeStderr(`AgenticReplay を起動できませんでした: ${error.message}\n`);
          resolve(undefined);
        });
        child.once('close', (code, signal) => {
          // AgenticReplay exits 2 for an incomplete recording after a successful chat,
          // including sessions closed before the first model request. The conversation's
          // exit code therefore never depends on the recording's completeness.
          const recorderExitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
          const exitCode = code === 2 ? 0 : recorderExitCode;
          const runDir = runDirFromTlsCa(readReceipt(receipt)?.tlsCa);
          resolve({ exitCode, recording: summarizeRecording(runDir, recorderExitCode) });
        });
      });
    } finally {
      process.off('SIGINT', forwardInterrupt);
      process.off('SIGTERM', forwardTermination);
    }
  } finally {
    rmSync(receipt, { force: true });
  }
}
