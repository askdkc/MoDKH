import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureWorkspaceIgnores } from '../src/cli/workspace-ignore.ts';

const entry = process.env.MODKH_TEST_ENTRY ?? fileURLToPath(new URL('../src/index.ts', import.meta.url));

function root(withGit: boolean): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-ignore-')));
  if (withGit) fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

const read = (dir: string) => fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');

test('a git workspace without .gitignore gains both state directories', () => {
  const dir = root(true);
  try {
    const result = ensureWorkspaceIgnores(dir);
    assert.deepEqual(result?.added, ['.modkh/', '.agenticreplay/']);
    assert.equal(read(dir), '.modkh/\n.agenticreplay/\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('existing rules are kept and only the missing directory is appended', () => {
  const dir = root(true);
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\ndist');
    ensureWorkspaceIgnores(dir);
    assert.equal(read(dir), 'node_modules\ndist\n.modkh/\n.agenticreplay/\n', 'a missing trailing newline is not glued to a new rule');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an already ignored directory is not duplicated, whatever the spelling', () => {
  const dir = root(true);
  try {
    const original = '# workspace state\n/.modkh\nautomation/.agenticreplay/\n';
    fs.writeFileSync(path.join(dir, '.gitignore'), original);
    const result = ensureWorkspaceIgnores(dir);
    // A nested path is a different rule: the workspace-root directory is still ignored.
    assert.deepEqual(result?.added, ['.agenticreplay/']);
    assert.equal(read(dir), `${original}.agenticreplay/\n`);
    assert.deepEqual(ensureWorkspaceIgnores(dir)?.added, [], 'a second run adds nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a fully covered .gitignore is left byte-for-byte untouched', () => {
  const dir = root(true);
  try {
    const original = '.modkh\n.agenticreplay/\n!keep-this\n';
    fs.writeFileSync(path.join(dir, '.gitignore'), original);
    assert.deepEqual(ensureWorkspaceIgnores(dir)?.added, []);
    assert.equal(read(dir), original);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the **/ form covers the workspace root, the */ form does not', () => {
  const dir = root(true);
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '**/.modkh/\n*/.agenticreplay/\n');
    // `**/.modkh/` matches the root copy, so only the other directory is appended.
    assert.deepEqual(ensureWorkspaceIgnores(dir)?.added, ['.agenticreplay/']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a negation is not mistaken for an ignore rule', () => {
  const dir = root(true);
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '!.modkh/\n');
    assert.deepEqual(ensureWorkspaceIgnores(dir)?.added, ['.modkh/', '.agenticreplay/']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CRLF files are extended with CRLF and comments never count as rules', () => {
  const dir = root(true);
  try {
    fs.writeFileSync(path.join(dir, '.gitignore'), '# .modkh/ is documented here\r\n');
    ensureWorkspaceIgnores(dir);
    assert.equal(read(dir), '# .modkh/ is documented here\r\n.modkh/\r\n.agenticreplay/\r\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a workspace without .git is left alone', () => {
  const dir = root(false);
  try {
    assert.equal(ensureWorkspaceIgnores(dir), undefined);
    assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a .git file (worktree or submodule) also counts as a git workspace', () => {
  const dir = root(false);
  try {
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    assert.deepEqual(ensureWorkspaceIgnores(dir)?.added, ['.modkh/', '.agenticreplay/']);
    assert.equal(read(dir), '.modkh/\n.agenticreplay/\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a .gitignore symlinked outside the workspace is reported, never rewritten through', () => {
  const dir = root(true);
  const elsewhere = root(false);
  try {
    const target = path.join(elsewhere, 'shared-ignore');
    fs.writeFileSync(target, 'node_modules\n');
    fs.symlinkSync(target, path.join(dir, '.gitignore'));
    assert.throws(() => ensureWorkspaceIgnores(dir), /ワークスペース外/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'node_modules\n', 'the linked file stays untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('a dotfiles symlink that stays inside the workspace is updated in place', () => {
  const dir = root(true);
  try {
    fs.mkdirSync(path.join(dir, 'dotfiles'));
    const target = path.join(dir, 'dotfiles', 'gitignore');
    fs.writeFileSync(target, 'dist/\n');
    fs.symlinkSync(path.join('dotfiles', 'gitignore'), path.join(dir, '.gitignore'));
    assert.deepEqual(ensureWorkspaceIgnores(dir)?.added, ['.modkh/', '.agenticreplay/']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'dist/\n.modkh/\n.agenticreplay/\n');
    assert.ok(fs.lstatSync(path.join(dir, '.gitignore')).isSymbolicLink(), 'the link itself is kept');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a directory named .gitignore is reported instead of replaced', () => {
  const dir = root(true);
  try {
    fs.mkdirSync(path.join(dir, '.gitignore'));
    assert.throws(() => ensureWorkspaceIgnores(dir), /通常ファイルではありません/);
    assert.ok(fs.lstatSync(path.join(dir, '.gitignore')).isDirectory(), 'the directory is not replaced');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('starting the CLI in a git workspace ignores .modkh and .agenticreplay', { timeout: 30_000 }, () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-ignore-cli-')));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet', home]).status, 0);
    const result = spawnSync(process.execPath, [entry, '--model', 'fixed/scripted'], {
      cwd: home, input: '/exit\n', encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, MODKH_HOME: path.join(home, 'home'), MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = read(home).split('\n');
    assert.ok(lines.includes('.modkh/'), lines.join('|'));
    assert.ok(lines.includes('.agenticreplay/'), lines.join('|'));
    assert.ok(fs.existsSync(path.join(home, '.modkh', 'sessions')), 'the record itself is still written');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
