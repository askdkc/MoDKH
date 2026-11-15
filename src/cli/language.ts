import { LANGUAGES, languageById } from '../language/catalog.ts';
import { clearFailure, ensureInstalled, resolveServer, statusReport } from '../language/install.ts';
import { detectedLanguages, parseLanguageSettings } from '../language/detect.ts';
import { availableGrammars, missingGrammars } from '../language/syntax/assets.ts';
import { verifyGrammar } from '../language/syntax/parser.ts';
import { loadConfig } from './config.ts';

const USAGE = `使い方:
  modkh language status                検出・導入状態と文法を表示
  modkh language install [--detected]  検出した言語(またはすべて)のサーバーを導入
  modkh language retry <id>            失敗記録を消して再試行
  modkh language update                既存の導入を検証し直す
`;

export async function runLanguageCommand(positional: string, cwd = process.cwd()): Promise<void> {
  const [action, ...rest] = positional.trim().split(/\s+/).filter(Boolean);
  const settings = parseLanguageSettings((loadConfig() as { language?: unknown }).language);
  if (!action || action === 'status') return status(cwd, settings);
  if (action === 'install') return install(cwd, settings, rest.includes('--detected'));
  if (action === 'retry') {
    const id = rest[0];
    if (!id || !languageById(id)) { process.stderr.write(`言語IDが必要です。対象: ${LANGUAGES.map(l => l.id).join(', ')}\n`); process.exit(1); }
    clearFailure(id);
    process.stdout.write(`${id} の失敗記録を消しました。次の利用で再試行します。\n`);
    return;
  }
  if (action === 'update') return update(settings);
  process.stderr.write(USAGE);
  process.exit(1);
}

async function status(cwd: string, settings: ReturnType<typeof parseLanguageSettings>): Promise<void> {
  const detected = new Set(detectedLanguages(cwd).map(language => language.id));
  const grammarSet = new Set(availableGrammars());
  const installed = new Map(statusReport().map(entry => [entry.id, entry]));
  process.stdout.write('ID            検出  サーバー        文法      状態\n');
  for (const language of LANGUAGES) {
    const resolved = resolveServer(language, { disabled: settings.disabled.includes(language.id) });
    const grammar = language.grammar ? (grammarSet.has(language.grammar) ? '同梱' : 'なし') : '—';
    const entry = installed.get(language.id);
    const detail = resolved.status === 'ready'
      ? `${entry?.version ?? '導入済み'}${settings.servers[language.id] ? '(設定)' : ''}`
      : resolved.detail ?? '未導入';
    process.stdout.write(`${language.id.padEnd(13)} ${(detected.has(language.id) ? 'yes' : '-').padEnd(4)} `
      + `${resolved.status.padEnd(14)} ${grammar.padEnd(8)} ${detail}\n`);
  }
  const missing = missingGrammars(LANGUAGES.map(language => language.grammar).filter((g): g is string => Boolean(g)));
  if (missing.length) process.stdout.write(`\n文法WASM未収録（その言語は構文解析を縮退）: ${missing.join(', ')}\n`);
  if (!settings.autoInstall) process.stdout.write('\n自動導入は無効（config.json の language.autoInstall）。\n');
}

async function install(cwd: string, settings: ReturnType<typeof parseLanguageSettings>, detectedOnly: boolean): Promise<void> {
  const targets = detectedOnly ? detectedLanguages(cwd) : LANGUAGES;
  if (targets.length === 0) { process.stdout.write('対象言語を検出できませんでした。\n'); return; }
  let failures = 0;
  for (const language of targets) {
    const before = resolveServer(language, { disabled: settings.disabled.includes(language.id) });
    if (before.status === 'ready') { process.stdout.write(`${language.id}: 導入済み\n`); continue; }
    if (before.status === 'disabled') { process.stdout.write(`${language.id}: 無効\n`); continue; }
    process.stdout.write(`${language.id}: 導入中…\n`);
    const outcome = await ensureInstalled(language, {
      autoInstall: settings.autoInstall,
      ...(settings.servers[language.id] ? { server: settings.servers[language.id]! } : {}),
    });
    process.stdout.write(`${language.id}: ${outcome.status === 'ready' ? '完了' : `未導入 — ${outcome.detail ?? ''}`}\n`);
    if (outcome.status !== 'ready') failures++;
  }
  if (failures) process.exitCode = 1;
}

async function update(settings: ReturnType<typeof parseLanguageSettings>): Promise<void> {
  const report = statusReport();
  if (report.length === 0) { process.stdout.write('管理下のサーバーはありません。\n'); return; }
  for (const entry of report) {
    const language = languageById(entry.id);
    if (!language) continue;
    const resolved = resolveServer(language, {});
    if (resolved.status !== 'ready') { process.stdout.write(`${entry.id}: 見つかりません（retry で再導入）\n`); continue; }
    const grammar = language.grammar;
    const grammarCheck = grammar ? await verifyGrammar(grammar) : { ok: true as const };
    process.stdout.write(`${entry.id}: サーバー ${resolved.installed ? '確認済み' : '設定済み'}`
      + `${grammar ? ` / 文法 ${grammarCheck.ok ? 'ロード成功' : `失敗 — ${'detail' in grammarCheck ? grammarCheck.detail : ''}`}` : ''}\n`);
  }
}
