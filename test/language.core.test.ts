import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { offsetToPosition, positionToOffset, displayPosition } from '../src/language/positions.ts';
import { detectLanguage, detectedLanguages, parseLanguageSettings, DEFAULT_LANGUAGE_SETTINGS } from '../src/language/detect.ts';
import { languageForPath, LANGUAGES } from '../src/language/catalog.ts';
import { availableGrammars, missingGrammars, grammarPaths } from '../src/language/syntax/assets.ts';
import { outline, verifyGrammar } from '../src/language/syntax/parser.ts';
import { copyFileSync } from 'node:fs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-language-')));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

test('positions are UTF-16 units and never normalize CRLF', () => {
  const text = 'const 日本 = 1;\r\nconst b = 2;\n';
  // "const " is 6 units; 日本 occupies 2 UTF-16 units in BMP but 絵文字 uses a surrogate pair.
  assert.deepEqual(offsetToPosition(text, 6), { line: 0, character: 6 });
  assert.deepEqual(offsetToPosition('🙂x', 2), { line: 0, character: 2 });
  assert.equal(positionToOffset(text, { line: 1, character: 0 }), 'const 日本 = 1;\r\n'.length);
  assert.deepEqual(displayPosition('a\nbc', 3), { line: 2, column: 2 });
  assert.equal(offsetToPosition('', 0).line, 0);
});

test('extension detection prefers the specific language and finds a manifest root', () => {
  fs.mkdirSync(path.join(root, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'web', 'src', 'a.ts'), 'export {}\n');
  fs.writeFileSync(path.join(root, 'web', 'src', 'b.tsx'), 'export {}\n');
  fs.writeFileSync(path.join(root, 'web', 'src', 'c.mjs'), 'export {}\n');
  assert.equal(languageForPath('a.TS')?.id, 'typescript');
  assert.equal(languageForPath('a.tsx')?.id, 'tsx');
  assert.equal(languageForPath('a.mjs')?.id, 'javascript');
  assert.equal(languageForPath('a.svelte')?.id, 'svelte');
  assert.equal(languageForPath('noext'), undefined);
  const detection = detectLanguage(path.join(root, 'web', 'src', 'a.ts'), root);
  assert.equal(detection?.language.id, 'typescript');
  assert.equal(detection?.root, path.join(root, 'web'));
  assert.equal(detection?.manifest, 'tsconfig.json');
  // Outside any manifest, the workspace root is the boundary rather than a parent directory.
  assert.equal(detectLanguage(path.join(root, 'loose.ts'), root)?.root, root);
  // A package.json alone does not declare JavaScript; only manifests actually present are reported.
  assert.deepEqual(detectedLanguages(path.join(root, 'web')).map(l => l.id).sort(), ['tsx', 'typescript']);
});

test('language settings reject malformed values instead of trusting them', () => {
  assert.deepEqual(parseLanguageSettings(undefined), DEFAULT_LANGUAGE_SETTINGS);
  assert.deepEqual(parseLanguageSettings([]), DEFAULT_LANGUAGE_SETTINGS);
  const parsed = parseLanguageSettings({
    autoInstall: false,
    disabled: ['typescript', 'not-a-language', 42],
    requestTimeoutMs: -5,
    installTimeoutMs: 99999999999,
    servers: { python: { command: 'pyright-langserver', args: ['--stdio', 7] }, nope: { command: 'x' }, rust: { command: '' } },
  });
  assert.equal(parsed.autoInstall, false);
  assert.deepEqual(parsed.disabled, ['typescript']);
  assert.equal(parsed.requestTimeoutMs, DEFAULT_LANGUAGE_SETTINGS.requestTimeoutMs);
  assert.equal(parsed.installTimeoutMs, DEFAULT_LANGUAGE_SETTINGS.installTimeoutMs);
  assert.deepEqual(parsed.servers.python, { command: 'pyright-langserver', args: ['--stdio'] });
  assert.equal(parsed.servers.rust, undefined);
  assert.equal((parsed.servers as Record<string, unknown>)['nope'], undefined);
});

test('shipped grammar assets cover declared languages and report what is missing', () => {
  const grammars = availableGrammars();
  assert.ok(grammars.includes('typescript'), 'dist の文法を同梱する');
  const declared = LANGUAGES.map(language => language.grammar).filter((g): g is string => Boolean(g));
  const missing = missingGrammars(declared);
  // Svelte and Common Lisp are declared without a shipped WASM; the rest must be present.
  assert.deepEqual(missing.sort(), ['commonlisp', 'svelte']);
  assert.equal(grammarPaths('typescript')?.wasm.endsWith('tree-sitter-typescript.wasm'), true);
  assert.equal(grammarPaths('not-real'), null);
});

test('real WASM grammars produce structure for each shipped language', async () => {
  const cases: [string, string, string][] = [
    ['typescript', 'function greet(name: string) { return name; }\nclass Box { m() {} }\n', 'greet'],
    ['python', 'def greet(name):\n  return name\n', 'greet'],
    ['rust', 'fn greet() -> u8 { 1 }\n', 'greet'],
    ['c', 'int main(void){return 0;}\n', 'main'],
    ['cpp', 'class Box { public: int m(); };\n', 'Box'],
    ['ruby', 'def greet; end\n', 'greet'],
    ['php', '<?php function greet() {}', 'greet'],
    ['swift', 'func greet() {}\n', 'greet'],
    ['html', '<div><span></span></div>', 'div'],
    ['css', '.card { color: red; }', '.card'],
  ];
  for (const [grammar, source, expected] of cases) {
    assert.deepEqual(await verifyGrammar(grammar), { ok: true }, grammar);
    const result = await outline(grammar, source);
    assert.equal(result.status, 'ok', `${grammar}: ${result.detail}`);
    assert.ok(result.nodes?.some(node => node.name === expected), `${grammar} should include ${expected}`);
    assert.equal(result.errorCount, 0, grammar);
  }
});

test('unavailable grammars degrade to a reported reason rather than a clean result', async () => {
  assert.equal((await outline('svelte', '<div/>')).status, 'unsupported');
  assert.equal((await outline('commonlisp', '(defun f ())')).status, 'unsupported');
  const broken = await verifyGrammar('svelte');
  assert.equal(broken.ok, false);
  assert.ok((broken.detail ?? '').length > 0);
});

test('outline keeps unicode line and column positions of the original source', async () => {
  const source = '// 日本\r\nfunction 挨拶() {}\r\n';
  const result = await outline('typescript', source);
  const node = result.nodes?.find(n => n.name === '挨拶');
  assert.ok(node, JSON.stringify(result));
  assert.equal(node.startLine, 2);
});

test('a broken grammar does not break other grammars in the same process', async () => {
  assert.equal((await verifyGrammar('nonexistent-grammar')).ok, false);
  assert.equal((await verifyGrammar('typescript')).ok, true);
});

test('modkh language status reports every declared language without installing anything', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-language-cli-'));
  try {
    const entry = process.env['MODKH_TEST_ENTRY'] ?? new URL('../src/index.ts', import.meta.url).pathname;
    const result = spawnSync(process.execPath, [entry, 'language', 'status'], {
      cwd: root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, MODKH_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    for (const language of LANGUAGES) assert.match(result.stdout, new RegExp(language.id), language.id);
    assert.match(result.stdout, /文法WASM未収録/);
    assert.equal(fs.existsSync(path.join(home, 'language', 'state.json')), false, 'status must not install');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  void copyFileSync;
});
