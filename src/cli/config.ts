import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface MemoryConfig {
  enabled: boolean;
  command: string;
  args: string[];
}

export interface LiteConfig {
  memory: MemoryConfig;
  /** Validated per plugin by the subagent boundary; malformed entries fail closed. */
  subagents?: unknown;
  subagentLimit?: unknown;
  /** Validated by parseLanguageSettings; malformed values fall back to defaults. */
  language?: unknown;
  /** all | workspace | none. Validated by parsePermissionPolicy; malformed values fall back. */
  permissions?: unknown;
  /** Tool round-trip limit for one turn. Validated by parseMaxTurns; malformed values fall back. */
  maxTurns?: unknown;
  /** 前回接続したモデル(--base-url の情報は modelBaseUrl に残す)。起動時の復元に使う。 */
  model?: unknown;
  modelBaseUrl?: unknown;
  /** 前回の /reasoning レベル。起動時に復元する。 */
  reasoning?: unknown;
  /** モデル応答の無通信タイムアウト(ms)。1〜上限で検証し、不正値は使わない。 */
  timeoutMs?: unknown;
  /** 圧縮で生のまま残す直近ターン数。parseKeepTurns で検証する。 */
  compactionKeepTurns?: unknown;
  /**
   * 会話本文がこのサイズ(推定UTF-8バイト)に達したら自動で圧縮する。既定では入力トークン数を使う、0で無効。
   * トークン数やプロバイダーのコンテキスト上限とは別の目安。
   */
  compactionAutoBytes?: unknown;
  modelContextWindows?: Record<string, unknown>;
  diagnostics?: string[];
}

export const DEFAULT_CONFIG: LiteConfig = {
  memory: {
    enabled: false,
    command: 'kiokuko',
    args: ['mcp', '--profile', 'chatgpt-memory'],
  },
};

/** タイムアウトは 5秒〜30分の整数で受ける。それ以外は無効値として扱う。 */
export const TIMEOUT_MS_MIN = 5000;
export const TIMEOUT_MS_MAX = 1_800_000;

export function parseTimeoutMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
  if (value < TIMEOUT_MS_MIN || value > TIMEOUT_MS_MAX) return null;
  return value;
}

export function configDir(): string {
  if (process.env['MODKH_HOME']) return process.env['MODKH_HOME'];
  const configBase = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(configBase, 'modkh');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

/** 既定値は毎回コピーして返す(呼び出し元が書き換えても共有しない)。 */
export function defaultConfig(): LiteConfig {
  return { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory } };
}

/** 書き込み時に意味を持つ既知のキー。これ以外は利用者の手書き設定として保持する。 */
const KNOWN_KEYS = new Set(['memory', 'subagents', 'subagentLimit', 'language', 'permissions', 'maxTurns', 'model', 'modelBaseUrl', 'reasoning', 'timeoutMs']);

function readRawConfig(): string | undefined {
  try { return fs.readFileSync(configPath(), 'utf8'); } catch { return undefined; }
}

function parseRawObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch { return undefined; }
}

function toLiteConfig(parsed: Record<string, unknown>): LiteConfig {
  const memory = parsed.memory as Partial<MemoryConfig> | undefined;
  const diagnostics = Array.isArray(parsed.diagnostics)
    ? parsed.diagnostics.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  return {
    subagents: parsed.subagents,
    subagentLimit: parsed.subagentLimit,
    language: parsed.language,
    permissions: parsed.permissions,
    maxTurns: parsed.maxTurns,
    model: parsed.model,
    modelBaseUrl: parsed.modelBaseUrl,
    reasoning: parsed.reasoning,
    timeoutMs: parsed.timeoutMs,
    compactionKeepTurns: parsed.compactionKeepTurns,
    compactionAutoBytes: parsed.compactionAutoBytes,
    modelContextWindows: parsed.modelContextWindows as LiteConfig['modelContextWindows'],
    memory: {
      enabled: memory?.enabled === true,
      command: memory?.command ?? DEFAULT_CONFIG.memory.command,
      args: memory?.args ?? DEFAULT_CONFIG.memory.args,
    },
    ...(diagnostics ? { diagnostics } : {}),
  };
}

/**
 * 壊れたファイルからでも、次回起動の復元に必要な値だけは拾う。
 * ここで model を諦めると「一度決めたモデルが次回は未接続」になるため、文字列だけは救出する。
 */
function salvage(parsed: LiteConfig, text: string): void {
  const stringField = (name: string): string | undefined => {
    try {
      const match = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
      return match?.[1];
    } catch { return undefined; }
  };
  if (parsed.model === undefined) parsed.model = stringField('model');
  if (parsed.modelBaseUrl === undefined) parsed.modelBaseUrl = stringField('modelBaseUrl');
  if (parsed.reasoning === undefined) parsed.reasoning = stringField('reasoning');
  if (parsed.timeoutMs === undefined) {
    const number = /"timeoutMs"\s*:\s*(\d+)/.exec(text)?.[1];
    if (number !== undefined) parsed.timeoutMs = Number(number);
  }
}

/** 壊れた内容を上書きで失わないよう、直近の1件だけ退避する。 */
function quarantineBrokenConfig(text: string): void {
  try {
    const backup = `${configPath()}.broken`;
    let previous: string | undefined;
    try { previous = fs.readFileSync(backup, 'utf8'); } catch { previous = undefined; }
    if (previous === text) return;
    fs.writeFileSync(backup, text, { encoding: 'utf8', mode: 0o600 });
  } catch { /* 退避できなくても読み込みは続ける */ }
}

/** 一時ファイルに書いてrenameする。中断されても config.json が途中まで書かれた状態を残さない。 */
export function saveConfig(config: LiteConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = configPath();
  // 手書きの未知キーを落とさない(設定ファイル全体を書き直すため)。
  const unknown: Record<string, unknown> = {};
  const raw = readRawConfig();
  const existing = raw === undefined ? undefined : parseRawObject(raw);
  if (existing) {
    for (const [key, value] of Object.entries(existing)) if (!KNOWN_KEYS.has(key)) unknown[key] = value;
  }
  const { diagnostics: _derived, ...known } = config;
  const body = { ...unknown, ...known };
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  // 既存ファイルの権限を引き継ぐ(利用者が絞っていれば広げない)。
  let mode = 0o600;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* 新規作成時は 0600 */ }
  const fd = fs.openSync(temporary, 'w', mode);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(fd); // 電源断・強制終了でもrename前の内容が欠けない
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, target);
  } catch (e) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* 後始末の失敗は元のエラーを隠さない */ }
    throw e;
  }
  try { fs.chmodSync(target, mode); } catch { /* 権限変更に失敗しても保存自体は成立させる */ }
}

export function loadConfig(): LiteConfig {
  const raw = readRawConfig();
  if (raw === undefined) return defaultConfig();
  const parsed = parseRawObject(raw);
  if (parsed) return toLiteConfig(parsed);
  // 壊れていても、復元に必要な model 等は救出して「次回も同じモデル」を保つ。
  const recovered = defaultConfig();
  salvage(recovered, raw);
  quarantineBrokenConfig(raw);
  return { ...recovered, subagents: null, diagnostics: ['設定を読めません。子の起動は無効: 設定のJSONが不正。壊れた内容は config.json.broken に退避した'] };
}

/**
 * 起動時に読んだ設定を壊さず1フィールドだけ更新する。書き込み前に実ファイルから
 * 読み直すので、並行する別セッションの保存を失わない。
 */
export function updateConfig(apply: (config: LiteConfig) => void): void {
  const current = loadConfig();
  apply(current);
  // 壊れたファイルを読んだ直後でも、救出した model を含めて書き戻す(値を失わない)。
  delete current.diagnostics;
  saveConfig(current);
}
