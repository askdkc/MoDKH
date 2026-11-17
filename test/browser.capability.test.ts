import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';

test('command-capable agents discover installed browse without requiring a local playwright package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-'));
  const previous = process.env.PATH;
  try {
    process.env.PATH = dir;
    const file = path.join(dir, process.platform === 'win32' ? 'browse.exe' : 'browse');
    fs.writeFileSync(file, 'not executed during discovery', { mode: 0o755 });
    const description = new ToolRegistry(defaultTools()).specs().find(t => t.name === 'run_command')!.description;
    assert.match(description, /browse status --json/);
    assert.match(description, /browse execute/);
    assert.match(description, /Playwright.*不要/);
    assert.match(description, /接続.*未確認/);
    fs.rmSync(file);
    const missing = new ToolRegistry(defaultTools()).specs().find(t => t.name === 'run_command')!.description;
    assert.doesNotMatch(missing, /browse CLI.*検出/);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-executable files named browse are not advertised as an installed browser tool', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-mode-'));
  const previous = process.env.PATH;
  try {
    process.env.PATH = dir;
    fs.writeFileSync(path.join(dir, 'browse'), '', { mode: 0o644 });
    assert.doesNotMatch(new ToolRegistry(defaultTools()).specs().find(t => t.name === 'run_command')!.description, /browse CLI.*検出/);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
