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

test('installed browse runs structured actions without command approval', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-bin-'));
  const previous = process.env.PATH;
  try {
    fs.writeFileSync(path.join(bin, 'browse'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    process.env.PATH = bin;
    const registry = new ToolRegistry(defaultTools());
    const ctx = { root: process.cwd(), approval: { approve: async () => assert.fail('unexpected prompt') } };
    const run = (args: Record<string, unknown>) => registry.executeOne({ id: '1', name: 'browse', args }, ctx);
    const text = 'a; $(echo not-a-shell)';
    const result = await run({ action: 'fill', tab: '12', ref: 'e1', text });
    assert.equal(result.status, 'ok');
    assert.equal(result.output, `fill\n--json\n${JSON.stringify({ tab: 12, ref: 'e1', value: text })}\n`);
    assert.equal((await run({ action: 'execute' })).status, 'error');
    assert.equal((await run({ action: 'navigate', url: 'file:///etc/passwd' })).status, 'error');
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('browse reports its running state to the pane while the CLI call is in flight', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-watch-'));
  const previous = process.env.PATH;
  try {
    // Sleep keeps the call in flight so the observer can see the running state.
    fs.writeFileSync(path.join(bin, 'browse'), '#!/bin/sh\nsleep 0.2\nprintf "done\\n"\n', { mode: 0o755 });
    process.env.PATH = bin;
    const { browseTools, watchBrowseActivity, browseActiveCalls } = await import('../src/tools/browse.ts');
    const observed: boolean[] = [];
    const stop = watchBrowseActivity(active => observed.push(active));
    assert.deepEqual(observed, [false], 'the observer learns the current state immediately');
    const registry = new ToolRegistry(browseTools());
    const ctx = { root: process.cwd(), approval: { approve: async () => true } };
    const running = registry.executeOne({ id: '1', name: 'browse', args: { action: 'status' } }, ctx);
    assert.equal(browseActiveCalls(), 1, 'a call in flight counts as active');
    assert.equal((await running).status, 'ok');
    assert.equal(browseActiveCalls(), 0, 'the count returns to zero when the call ends');
    stop();
    assert.deepEqual(observed, [false, true, false]);
    watchBrowseActivity(active => observed.push(active))();
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('a failing browse call still clears the running state', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-fail-'));
  const previous = process.env.PATH;
  try {
    fs.writeFileSync(path.join(bin, 'browse'), '#!/bin/sh\necho "relay unreachable" >&2\nexit 3\n', { mode: 0o755 });
    process.env.PATH = bin;
    const { browseTools, browseActiveCalls } = await import('../src/tools/browse.ts');
    const registry = new ToolRegistry(browseTools());
    const result = await registry.executeOne({ id: '1', name: 'browse', args: { action: 'snapshot', tab: 1 } },
      { root: process.cwd(), approval: { approve: async () => true } });
    assert.equal(result.status, 'error', 'a failed snapshot is reported as error');
    assert.match(result.output, /relay unreachable/);
    assert.equal(browseActiveCalls(), 0, 'the running state is cleared on failure');
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
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
