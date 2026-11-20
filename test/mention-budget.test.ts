import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StagedAttachments } from '../src/cli/staged-attachments.ts';
import { readFileMentions } from '../src/cli/file-mentions.ts';

test('mentions share a 256 MiB budget across formats', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mention-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'a'.repeat(150_000));
  const store = new StagedAttachments();
  t.after(() => store.close());
  assert.ok((readFileMentions(root, '@notes.txt', store)?.text?.length ?? Infinity) < 1024);
  const image = path.join(root, 'large.png');
  fs.writeFileSync(image, '');
  fs.truncateSync(image, 256 * 1024 * 1024 - 149_999);
  assert.throws(() => readFileMentions(root, '@notes.txt @large.png', store), /256 MiB/);
});
