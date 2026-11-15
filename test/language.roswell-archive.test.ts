import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateRoswellArchivePaths } from '../src/language/commonlisp-install.ts';

test('official Roswell archive listing accepts Lisp filenames containing plus signs', () => {
  const listing = fs.readFileSync(new URL('./fixtures/roswell-archive-paths.txt', import.meta.url), 'utf8');
  assert.ok(listing.includes('roswell/lisp/install+sigsegv.lisp'));
  // The former allowlist rejected this actual release listing.
  assert.ok(listing.trim().split('\n').some(name => !/^roswell\/[A-Za-z0-9._/-]*$/.test(name)));
  assert.doesNotThrow(() => validateRoswellArchivePaths(listing));
});

test('Roswell archive path validation still rejects escape, absolute and malformed names', () => {
  for (const name of ['', '/roswell/ros', '../roswell/ros', 'roswell/../escape',
    'roswell/lisp/../../escape', 'other/ros', 'roswell/lisp/evil\\name',
    'roswell/lisp/a\u0000b', ' roswell/ros', 'roswell/ros ', 'roswell/ros\n/escape']) {
    assert.throws(() => validateRoswellArchivePaths(name), /Unsafe Roswell archive path/);
  }
  assert.throws(() => validateRoswellArchivePaths(Array(2001).fill('roswell/ros').join('\n')), /2000 entries/);
});
