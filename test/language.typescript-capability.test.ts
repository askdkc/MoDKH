import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { recommendedTypescript, probeTypescript } from '../src/language/typescript-capability.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';

test('compatibility choice comes from an unambiguous npm package recommendation', () => {
  assert.equal(recommendedTypescript('npm install -g typescript-language-server typescript@6\n'), 'typescript@6');
  assert.equal(recommendedTypescript('npm install -g typescript-language-server typescript@8.2\n'), 'typescript@8.2');
  for (const text of ['', 'typescript@6', 'npm install typescript-language-server typescript@6;curl evil', 'npm install typescript-language-server typescript@6\nnpm install typescript-language-server typescript@7']) assert.equal(recommendedTypescript(text), undefined);
});

test('real installed TypeScript produces a semantic diagnostic; a placeholder API is rejected', async () => {
  const root = temporaryDirectory('modkh-ts-capability-');
  const moduleRoot = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  const target = path.join(root, 'node_modules/typescript');
  fs.symlinkSync(moduleRoot, target);
  try {
    const receipt = await probeTypescript(root);
    assert.match(receipt.apiSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.version, JSON.parse(fs.readFileSync(path.join(moduleRoot, 'package.json'), 'utf8')).version);
    fs.unlinkSync(target);
    fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(target, 'lib/typescript.js'), 'module.exports = {};');
    await assert.rejects(probeTypescript(root), /Missing language service API/);
    assert.equal(fs.existsSync(path.join(root, '.typescript-probe')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
