import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findAttachmentCandidates } from '../src/cli/file-mentions.ts';

test('corrects both parent and filename without offering unrelated files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'notes'));
  const expected = path.join(root, 'notes', 'report.md');
  fs.writeFileSync(expected, '');
  fs.writeFileSync(path.join(root, 'notes', 'unrelated.md'), '');
  assert.deepEqual(await findAttachmentCandidates('noets/reprot.md', root), [fs.realpathSync(expected)]);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  assert.deepEqual(await findAttachmentCandidates('escape/candidates.txt', root), []);
});

test('caps results from a crowded directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, `report${i}.txt`), '');
  const found = await findAttachmentCandidates('reportX.txt', root);
  assert.equal(found.length, 5);
  assert.ok(found.every(file => path.isAbsolute(file) && fs.statSync(file).isFile()));
});
