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
  assert.throws(() => readFileMentions(root, '~/Downlods/newkoku.pdf', store), error =>
    error instanceof Error && error.message.endsWith('親ディレクトリ候補: "Downloads"') && !('draft' in error));
  fs.symlinkSync(home, path.join(root, 'escape'), 'dir');
  assert.throws(() => readFileMentions(root, './escape/Downlods/newkoku.pdf', store), error =>
    error instanceof Error && !error.message.includes('Downloads') && !('draft' in error));
  const input = '質問: ~/Downloads/newkokusho.pdf 読める？';
  assert.throws(() => readFileMentions(root, input, store), { draft: '質問: ~/Downloads/newkoku.pdf 読める？' });
  fs.writeFileSync(path.join(downloads, 'newkokushi.pdf'), data);
  for (const typo of [input, '~/Downloads/unrelated.pdf 読める？']) {
    assert.throws(() => readFileMentions(root, typo, store), error => error instanceof Error && !('draft' in error));
  }
  assert.deepEqual(readFileMentions(root, '~/Downloads/newkoku.pdf 読める？', store)?.pdfs,
    [{ filename: 'newkoku.pdf', data: data.toString('base64') }]);
});
