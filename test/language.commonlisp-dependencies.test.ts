import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installLemDependencies, resolvedDependencyDirectory } from '../src/language/commonlisp-dependencies.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';

test('Lem manifest is installed privately before discovery, with resolved lock evidence', async () => {
  const root = temporaryDirectory('modkh-qlot-');
  try {
    const lem = path.join(root, 'lem'); fs.mkdirSync(lem);
    const manifest = 'git micros https://github.com/lem-project/micros.git\n';
    fs.writeFileSync(path.join(lem, 'qlfile'), manifest);
    fs.writeFileSync(path.join(lem, 'qlfile.lock'), 'upstream historical lock');
    const calls: string[] = [];
    const result = await installLemDependencies(root, lem, '/private/ros', '/private/roswell', async (name, command, args, cwd) => {
      calls.push(name);
      if (name === 'qlot-bootstrap') {
        assert.equal(command, '/private/ros'); assert.deepEqual(args, ['install', 'fukamachi/qlot']);
      } else {
        assert.equal(command, '/private/roswell/bin/qlot');
        if (name === 'qlot-capability') return 'fixture-version';
        assert.equal(cwd, path.join(root, 'dependencies'));
        assert.deepEqual(args, ['install', '--no-deps']);
        assert.equal(fs.readFileSync(path.join(cwd!, 'qlfile'), 'utf8'), manifest);
        assert.equal(fs.existsSync(path.join(cwd!, 'qlfile.lock')), false);
        fs.mkdirSync(path.join(cwd!, '.qlot'));
        fs.writeFileSync(path.join(cwd!, '.qlot/setup.lisp'), '; fixture setup');
        fs.writeFileSync(path.join(cwd!, 'qlfile.lock'), 'resolved fixture lock');
      }
      return '';
    });
    assert.deepEqual(calls, ['qlot-bootstrap', 'qlot-capability', 'lem-dependencies']);
    assert.equal(result.home, path.join(root, 'dependencies/.qlot') + path.sep);
    assert.equal(result.lock, 'resolved fixture lock');
    assert.match(result.lockSha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(path.join(lem, 'qlfile.lock'), 'utf8'), 'upstream historical lock');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Qlot failure stops the pipeline; exit zero with incomplete output is also rejected', async () => {
  for (const fails of [true, false]) {
    const root = temporaryDirectory('modkh-qlot-failure-');
    try {
      const lem = path.join(root, 'lem'); fs.mkdirSync(lem);
      fs.writeFileSync(path.join(lem, 'qlfile'), 'git micros https://github.com/lem-project/micros.git');
      const calls: string[] = [];
      await assert.rejects(installLemDependencies(root, lem, 'ros', root, async name => {
        calls.push(name);
        if (fails) throw new Error('dependency fetch failed: micros');
        return '';
      }), fails ? /fetch failed: micros/ : /ENOENT/);
      assert.equal(calls.length, fails ? 1 : 3);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('native build uses the ASDF-resolved source and rejects missing, duplicate and escaped sources', () => {
  const root = temporaryDirectory('modkh-native-source-');
  try {
    const owned = path.join(root, 'owned'); fs.mkdirSync(owned);
    const asd = path.join(owned, 'async-process.asd'); fs.writeFileSync(asd, '');
    const line = `MODKH_ASDF_SYSTEM async-process ${asd}`;
    assert.equal(resolvedDependencyDirectory(line, 'async-process', owned), fs.realpathSync(owned));
    assert.throws(() => resolvedDependencyDirectory('', 'async-process', owned), /Missing/);
    assert.throws(() => resolvedDependencyDirectory(line + '\n' + line, 'async-process', owned), /ambiguous/);
    const external = path.join(root, 'external.asd'); fs.writeFileSync(external, '');
    const link = path.join(owned, 'linked.asd'); fs.symlinkSync(external, link);
    assert.throws(() => resolvedDependencyDirectory(`MODKH_ASDF_SYSTEM async-process ${link}`, 'async-process', owned), /outside/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
