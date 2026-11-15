import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('npm global command registration preserves an existing dkh installation', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json')));
  assert.deepEqual(pkg.bin, { modkh: 'dist/index.js' });
  assert.deepEqual(lock.packages[''].bin, pkg.bin);
  const scratch = path.join(repo, '.dkh-feasibility');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'npm-bin-'));
  try {
    // Exercise npm itself, offline, with no application dependencies. The old alias
    // reproduces EEXIST; the shipped bin map must preserve the same existing command.
    for (const oldAlias of [true, false]) {
      const base = path.join(root, oldAlias ? 'before' : 'after');
      const prefix = path.join(base, 'prefix');
      const fixture = path.join(base, 'fixture');
      fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(prefix, 'lib/node_modules/dkh'), { recursive: true });
      const existing = path.join(prefix, 'lib/node_modules/dkh/index.js');
      fs.writeFileSync(existing, '#!/bin/sh\necho existing-dkh\n', { mode: 0o755 });
      const link = '../lib/node_modules/dkh/index.js';
      fs.symlinkSync(link, path.join(prefix, 'bin/dkh'));
      fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'dist/index.js'), '#!/usr/bin/env node\nconsole.log("modkh-bin-fixture");\n', { mode: 0o755 });
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
        name: pkg.name, version: pkg.version,
        bin: oldAlias ? { ...pkg.bin, dkh: 'dist/index.js' } : pkg.bin,
      }));
      const result = spawnSync('npm', ['install', '--global', '--prefix', prefix,
        '--cache', path.join(base, 'cache'), '--offline', '--ignore-scripts', '--no-audit', '--no-fund', fixture],
      { encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error);
      if (oldAlias) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /EEXIST/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        const command = spawnSync(path.join(prefix, 'bin/modkh'), [], { encoding: 'utf8', timeout: 10000 });
        assert.equal(command.status, 0, command.stderr);
        assert.equal(command.stdout.trim(), 'modkh-bin-fixture');
      }
      assert.equal(fs.readlinkSync(path.join(prefix, 'bin/dkh')), link);
      assert.equal(fs.readFileSync(existing, 'utf8'), '#!/bin/sh\necho existing-dkh\n');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
