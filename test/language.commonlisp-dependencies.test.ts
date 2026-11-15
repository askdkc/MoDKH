import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installLemDependencies, resolvedDependencyDirectory, resolvedNativeBuildDirectory } from '../src/language/commonlisp-dependencies.ts';
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
      } else if (name === 'qlot-capability') {
        assert.equal(command, '/private/ros');
        assert.deepEqual(args, ['-Q', '-e', '(ros:ensure-asdf)', '-l', path.join(root, 'dependencies/probe-qlot.lisp'), '-q']);
        return 'MODKH_QLOT_READY fixture-version\n';
      } else {
        assert.equal(command, '/private/roswell/bin/qlot');
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
  for (const outcome of ['bootstrap-failure', 'no-marker', 'no-lock']) {
    const root = temporaryDirectory('modkh-qlot-failure-');
    try {
      const lem = path.join(root, 'lem'); fs.mkdirSync(lem);
      fs.writeFileSync(path.join(lem, 'qlfile'), 'git micros https://github.com/lem-project/micros.git');
      const calls: string[] = [];
      await assert.rejects(installLemDependencies(root, lem, 'ros', root, async name => {
        calls.push(name);
        if (outcome === 'bootstrap-failure') throw new Error('dependency fetch failed: micros');
        if (outcome === 'no-lock' && name === 'qlot-capability') return 'MODKH_QLOT_READY fixture-version\n';
        return '';
      }), outcome === 'bootstrap-failure' ? /fetch failed: micros/ : outcome === 'no-marker' ? /missing completion evidence/ : /ENOENT/);
      assert.equal(calls.length, outcome === 'bootstrap-failure' ? 1 : outcome === 'no-marker' ? 2 : 3);
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

test('native build finds upstream src/ASD parent and rejects absent build files', () => {
  const root = temporaryDirectory('modkh-native-layout-');
  try {
    fs.mkdirSync(path.join(root, 'src'));
    const asd = path.join(root, 'src/async-process.asd'); fs.writeFileSync(asd, '');
    const discovery = `MODKH_ASDF_SYSTEM async-process ${asd}`;
    assert.throws(() => resolvedNativeBuildDirectory(discovery, root), /no supported/);
    for (const name of ['GNUmakefile', 'Makefile.am', 'configure.ac']) fs.writeFileSync(path.join(root, name), '');
    assert.equal(resolvedNativeBuildDirectory(discovery, root), fs.realpathSync(root));
    assert.notEqual(resolvedDependencyDirectory(discovery, 'async-process', root), fs.realpathSync(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real SBCL: Qlot version exits 255 but capability probe loads CLI and requires evidence', () => {
  const available = spawnSync('sbcl', ['--version']);
  if (available.error) throw available.error;
  const root = temporaryDirectory('modkh-qlot-probe-');
  try {
    // Match upstream qlot-command-toplevel's --version branch, not a successful install.
    const version = spawnSync('sbcl', ['--noinform', '--non-interactive', '--eval', '(require :asdf)',
      '--eval', '(progn (format t "Qlot fixture~%") (uiop:quit -1))'], { encoding: 'utf8' });
    assert.equal(version.status, 255);
    assert.match(version.stdout, /Qlot fixture/);
    fs.writeFileSync(path.join(root, 'qlot.asd'), '(asdf:defsystem "qlot" :version "0.0.0")\n(asdf:defsystem "qlot/cli" :components ((:file "cli")))');
    fs.writeFileSync(path.join(root, 'cli.lisp'), '(defpackage :qlot/cli (:use :cl))\n(in-package :qlot/cli)\n(defun qlot-command () nil)');
    const lem = path.join(root, 'lem'); fs.mkdirSync(lem);
    fs.writeFileSync(path.join(lem, 'qlfile'), '');
    return installLemDependencies(root, lem, 'ros', root, async (name, _command, args, cwd) => {
      if (name === 'qlot-capability') {
        const result = spawnSync('sbcl', ['--noinform', '--no-sysinit', '--no-userinit', '--non-interactive', '--load', args[4]], {
          encoding: 'utf8', env: { ...process.env, HOME: root, XDG_CACHE_HOME: root,
            CL_SOURCE_REGISTRY: `(:source-registry (:directory "${root}/") :ignore-inherited-configuration)` },
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      }
      if (name === 'lem-dependencies') {
        fs.mkdirSync(path.join(cwd!, '.qlot'));
        fs.writeFileSync(path.join(cwd!, '.qlot/setup.lisp'), '');
        fs.writeFileSync(path.join(cwd!, 'qlfile.lock'), '');
      }
      return '';
    }).then(result => assert.equal(result.version, '0.0.0')).finally(() => fs.rmSync(root, { recursive: true, force: true }));
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
});

test('Darwin TLS configuration loads before Qlot in both capability and install processes', async () => {
  const root = temporaryDirectory('modkh-qlot-tls-');
  try {
    const lem = path.join(root, 'lem'); fs.mkdirSync(lem); fs.writeFileSync(path.join(lem, 'qlfile'), '');
    const tls = path.join(root, 'tls.lisp');
    const stages: string[] = [];
    await installLemDependencies(root, lem, '/private/ros', root, async (name, command, args, cwd) => {
      stages.push(name);
      if (name === 'qlot-bootstrap') return '';
      assert.equal(command, '/private/ros');
      assert.deepEqual(args.slice(0, 5), ['-Q', '-e', '(ros:ensure-asdf)', '-l', tls]);
      if (name === 'qlot-capability') return 'MODKH_QLOT_READY fixture';
      assert.ok(args.includes('(qlot/cli:qlot-command "install" "--no-deps")'));
      fs.mkdirSync(path.join(cwd!, '.qlot')); fs.writeFileSync(path.join(cwd!, '.qlot/setup.lisp'), '');
      fs.writeFileSync(path.join(cwd!, 'qlfile.lock'), ''); return '';
    }, tls);
    assert.deepEqual(stages, ['qlot-bootstrap', 'qlot-capability', 'lem-dependencies']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
