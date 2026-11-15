import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LspServer } from '../src/language/lsp/client.ts';
import { languageById } from '../src/language/catalog.ts';

const fixture = new URL('./fixtures/fake-lsp.mjs', import.meta.url).pathname;

function server(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-sync-'));
  return { root, live: new LspServer({ id: 'typescript', root,
    command: process.execPath, args: [fixture], requestTimeoutMs: 8000,
    env: { ...process.env, FAKE_LSP_MODE: mode } }) };
}

test('an unchanged document returns immediately instead of polling the full window', async () => {
  const { root, live } = server('silent');
  try {
    await live.start();
    const file = path.join(root, 'a.ts');
    // First synchronization may wait; the same text afterwards is already known.
    await live.synchronize(file, 'const a = 1;\n');
    const start = Date.now();
    const again = await live.synchronize(file, 'const a = 1;\n');
    const elapsed = Date.now() - start;
    assert.equal(again.status, 'waiting');
    assert.ok(elapsed < 250, `unchanged text must not poll again: ${elapsed}ms`);
  } finally { await live.dispose(); }
});

test('a changed document returns as soon as the wait budget is spent, and says so', async () => {
  const { root, live } = server('silent');
  try {
    await live.start();
    const file = path.join(root, 'b.ts');
    await live.synchronize(file, 'const a = 1;\n');
    const start = Date.now();
    const result = await live.synchronize(file, 'const a = 2;\n');
    const elapsed = Date.now() - start;
    assert.equal(result.status, 'waiting');
    // The budget must be bounded well below the old five-second ceiling.
    assert.ok(elapsed < 1600, `bounded wait expected: ${elapsed}ms`);
  } finally { await live.dispose(); }
});

test('an observed diagnostic still returns without waiting the full budget', async () => {
  const { root, live } = server('clean');
  try {
    await live.start();
    const file = path.join(root, 'c.ts');
    const start = Date.now();
    const result = await live.synchronize(file, 'const a = 1;\n');
    const elapsed = Date.now() - start;
    assert.equal(result.status, 'observed');
    assert.ok(elapsed < 1500, `observed should be fast: ${elapsed}ms`);
  } finally { await live.dispose(); }
});
