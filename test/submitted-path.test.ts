import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileMentions } from '../src/cli/file-mentions.ts';
import { StagedAttachments } from '../src/cli/staged-attachments.ts';

test('a user-supplied external path attaches exactly that PDF, a typo only suggests names', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'submitted-path-'));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const root = path.join(home, 'workspace');
  const downloads = path.join(home, 'Downloads');
  const store = new StagedAttachments();
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    store.close(); fs.rmSync(home, { recursive: true, force: true });
  });
  fs.mkdirSync(root); fs.mkdirSync(downloads);
  const data = Buffer.from('%PDF-1.4\n%%EOF\n');
  fs.writeFileSync(path.join(downloads, 'newkoku.pdf'), data);
  assert.throws(() => readFileMentions(root, '~/Downloads/newkok.pdf 読める？', store), /候補: "newkoku.pdf"/);
  assert.deepEqual(readFileMentions(root, '~/Downloads/newkoku.pdf 読める？', store)?.pdfs,
    [{ filename: 'newkoku.pdf', data: data.toString('base64') }]);
});
