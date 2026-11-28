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
    const ordinary = await run({ action: 'click', tab: 12, ref: 'e2' });
    assert.equal(ordinary.output, `click\n--json\n${JSON.stringify({ tab: 12, ref: 'e2' })}\n`);
    const moving = await run({ action: 'click', tab: 12, ref: 'e2', force: true });
    assert.equal(moving.output, `click\n--json\n${JSON.stringify({ tab: 12, ref: 'e2', force: true })}\n`);
    assert.equal((await run({ action: 'execute' })).status, 'error');
    const local = await run({ action: 'navigate', url: 'file:///etc/passwd' });
    assert.equal(local.status, 'error');
    assert.match(local.output, /HTTP.*127\.0\.0\.1/i);
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

test('a failing browse call keeps the CLI message, which arrives on stdout', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-stdout-error-'));
  const previous = process.env.PATH;
  try {
    // browse reports failures on stdout with a nonzero exit code.
    fs.writeFileSync(path.join(bin, 'browse'), '#!/bin/sh\necho "Unknown snapshot ref: e11"\nexit 1\n', { mode: 0o755 });
    process.env.PATH = bin;
    const { browseTools } = await import('../src/tools/browse.ts');
    const result = await new ToolRegistry(browseTools()).executeOne(
      { id: '1', name: 'browse', args: { action: 'click', tab: 12, ref: 'e11' } },
      { root: process.cwd(), approval: { approve: async () => true } });
    assert.match(result.output, /Unknown snapshot ref: e11/, 'the reason the click failed must reach the model');
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('navigate reuses the given tab instead of opening another one', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-navigate-'));
  const previous = process.env.PATH;
  try {
    fs.writeFileSync(path.join(bin, 'browse'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    process.env.PATH = bin;
    const { browseTools } = await import('../src/tools/browse.ts');
    const registry = new ToolRegistry(browseTools());
    const ctx = { root: process.cwd(), approval: { approve: async () => assert.fail('unexpected prompt') } };
    const moved = await registry.executeOne({ id: '1', name: 'browse', args: { action: 'navigate', url: 'https://example.com', tab: 12 } }, ctx);
    assert.equal(moved.output, `navigate\n--json\n${JSON.stringify({ url: 'https://example.com', tab: 12 })}\n`);
    const reload = await registry.executeOne({ id: 'reload', name: 'browse', args: { action: 'reload', tab: '12' } }, ctx);
    assert.equal(reload.output, `navigate\n--json\n${JSON.stringify({ action: 'reload', tab: 12, ignoreCache: true })}\n`);
    const invalid = await registry.executeOne({ id: 'invalid', name: 'browse', args: { action: 'reload' } }, ctx);
    assert.equal(invalid.status, 'error');
    const visible = await registry.executeOne({ id: 'visible', name: 'browse', args: { action: 'navigate', url: 'http://localhost:3000/', keepVisible: true } }, ctx);
    assert.match(visible.output, /"keepVisible":true/);
    const opened = await registry.executeOne({ id: '2', name: 'browse', args: { action: 'navigate', url: 'https://example.com' } }, ctx);
    assert.match(opened.output, /"url":"https:\/\/example\.com"/);
    assert.doesNotMatch(opened.output, /"tab"/, 'without tab the CLI opens a new tab');
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('a screenshot comes back as an image saved under the session records', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-shot-'));
  const previous = process.env.PATH;
  // 1x1 PNG, written wherever --output points.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  try {
    fs.writeFileSync(path.join(bin, 'browse'), `#!/bin/sh
for last; do :; done
mkdir -p "$(dirname "$last")"
printf %s '${png}' | base64 -d > "$last"
printf '{"width":1,"height":1,"format":"png"}\\n'
`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-root-'));
    try {
      const { browseTools } = await import('../src/tools/browse.ts');
      const result = await new ToolRegistry(browseTools()).executeOne(
        { id: '1', name: 'browse', args: { action: 'screenshot', tab: 12 } },
        { root, approval: { approve: async () => true } });
      assert.equal(result.status, 'ok');
      assert.equal(result.image?.mediaType, 'image/png', 'the model must receive the pixels, not just a path');
      const saved = path.join(root, '.modkh', 'browse', '12.png');
      assert.ok(fs.existsSync(saved), 'the capture is written inside the working root');
      assert.match(result.output, /\.modkh\/browse\/12\.png/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('a failed screenshot never attaches the previous capture', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-shot-fail-'));
  const previous = process.env.PATH;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-shot-fail-root-'));
  const saved = path.join(root, '.modkh', 'browse', '12.png');
  try {
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, Buffer.from(png, 'base64'));
    fs.writeFileSync(path.join(bin, 'browse'), '#!/bin/sh\necho "Tab 12 is gone"\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
    const { browseTools } = await import('../src/tools/browse.ts');
    const result = await new ToolRegistry(browseTools()).executeOne(
      { id: '1', name: 'browse', args: { action: 'screenshot', tab: 12 } },
      { root, approval: { approve: async () => true } });
    assert.equal(result.image, undefined, 'an old file must not stand in for a failed capture');
    assert.match(result.output, /Tab 12 is gone/);
    assert.equal(result.status, 'error', 'a failed capture has no unknown effect');
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('list only shows the tabs this session opened', { skip: process.platform === 'win32' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-browse-list-'));
  const previous = process.env.PATH;
  try {
    fs.writeFileSync(path.join(bin, 'browse'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    process.env.PATH = bin;
    const { browseTools, BrowseTabs } = await import('../src/tools/browse.ts');
    const registry = new ToolRegistry(browseTools(new BrowseTabs()));
    const ctx = { root: process.cwd(), approval: { approve: async () => true } };
    const early = await registry.executeOne({ id: '1', name: 'browse', args: { action: 'list' } }, ctx);
    assert.equal(early.status, 'not-executed', 'an empty session must not list the user tabs');
    await registry.executeOne({ id: '2', name: 'browse', args: { action: 'navigate', url: 'https://example.com' } }, ctx);
    const listed = await registry.executeOne({ id: '3', name: 'browse', args: { action: 'list' } }, ctx);
    assert.equal(listed.status, 'ok');
    assert.match(listed.output, /"action":"list","group":"modkh-/);
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
