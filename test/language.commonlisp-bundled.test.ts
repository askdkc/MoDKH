import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installBundledCommonLisp, CL_LSP_REPOSITORY } from '../src/language/commonlisp-bundled.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';

function fixture(root: string) {
  const source = path.join(root, 'checkout');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'vendor'));
  for (const file of ['scripts/install-headless.ros', 'vendor/SOURCES.md', 'vendor/setup.lisp']) fs.writeFileSync(path.join(source, file), 'fixture');
  return source;
}

test('askdkc bundled installer owns native/runtime preparation without Qlot or separate Lem', async () => {
  const root = temporaryDirectory('modkh-bundled-');
  try {
    const source = fixture(root), calls: string[] = [];
    const result = await installBundledCommonLisp(root, source, '/private/ros', async (name, command, args, cwd) => {
      calls.push(name);
      if (name === 'bundled-runtime-install') {
        assert.equal(command, '/private/ros'); assert.equal(cwd, source);
        assert.deepEqual(args, ['-Q', '--', path.join(source, 'scripts/install-headless.ros'), '--prefix', path.join(root, 'server')]);
        fs.mkdirSync(path.join(root, 'server')); fs.writeFileSync(path.join(root, 'server/cl-lsp'), '#!/bin/sh\n');
      } else { assert.equal(command, path.join(root, 'server/cl-lsp')); assert.deepEqual(args, ['--help']); }
      return '';
    });
    assert.equal(result.repository, CL_LSP_REPOSITORY);
    assert.equal(result.repository, 'askdkc/cl-lsp');
    assert.match(result.sourcesSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(calls, ['bundled-runtime-install', 'runtime-warmup']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ['missing-vendor', 'installer-failed', 'missing-launcher', 'warmup-failed']) {
  test(`bundled installer rejects ${failure}`, async () => {
    const root = temporaryDirectory('modkh-bundled-fail-');
    try {
      const source = fixture(root);
      if (failure === 'missing-vendor') fs.unlinkSync(path.join(source, 'vendor/setup.lisp'));
      await assert.rejects(installBundledCommonLisp(root, source, 'ros', async name => {
        if (failure === 'installer-failed' || name === 'runtime-warmup') throw new Error(failure);
        if (failure !== 'missing-launcher') { fs.mkdirSync(path.join(root, 'server')); fs.writeFileSync(path.join(root, 'server/cl-lsp'), 'fixture'); }
        return '';
      }), failure === 'missing-vendor' || failure === 'missing-launcher' ? /ENOENT/ : new RegExp(failure));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
