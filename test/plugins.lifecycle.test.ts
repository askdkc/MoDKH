import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginManager } from '../src/plugins/manager.ts';
import { inspectPackage } from '../src/plugins/package.ts';
import { SubagentRegistry } from '../src/plugins/registry.ts';

function fixture(t: { after(fn: () => void): void }, source = 'export function define() { return { system: \"Read only\", tools: [\"read_file\"] }; }') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkh-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'source');
  fs.mkdirSync(directory);
  const manifest = { apiVersion: 1, id: 'reviewer', version: '1.0.0', title: 'Reviewer', description: 'Read sources', kind: 'local', entry: './index.mjs' };
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(directory, 'index.mjs'), source);
  return { root, directory, manifest, manager: new PluginManager(path.join(root, 'home')) };
}

test('listing, trust mismatch, and disabled admission never import plugin code', async t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'imported');
  fs.writeFileSync(path.join(f.directory, 'index.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'imported'); export function define() { return {system:'Read', tools:[]}; }`);
  const preview = f.manager.preview(f.directory);
  assert.throws(() => f.manager.install(f.directory, '0'.repeat(64)), /changed/);
  assert.equal(fs.existsSync(marker), false);
  const descriptor = f.manager.install(f.directory, preview.digest);
  assert.equal(f.manager.discover().registry.get('reviewer')?.digest, descriptor.digest);
  assert.equal(fs.existsSync(marker), false);
  assert.throws(() => f.manager.install(f.directory, preview.digest), /Duplicate/);
  f.manager.setEnabled('reviewer', false);
  await assert.rejects(f.manager.acquire('reviewer', descriptor.digest), /disabled/);
  assert.equal(fs.existsSync(marker), false);
  f.manager.setEnabled('reviewer', true);
  const lease = await f.manager.acquire('reviewer', descriptor.digest);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'imported');
  assert.throws(() => f.manager.remove('reviewer'), /in use/);
  lease.release(); lease.release();
  f.manager.remove('reviewer');
  assert.equal(f.manager.discover().registry.get('reviewer'), undefined);
});

test('manifest boundaries reject before imports or registration', t => {
  const f = fixture(t);
  for (const change of [{ apiVersion: 2 }, { extra: true }, { id: '../bad' }, { entry: '../index.mjs' }, { entry: './missing.mjs' }]) {
    fs.writeFileSync(path.join(f.directory, 'plugin.json'), JSON.stringify({ ...f.manifest, ...change }));
    assert.throws(() => f.manager.preview(f.directory));
  }
  fs.writeFileSync(path.join(f.directory, 'plugin.json'), JSON.stringify(f.manifest));
  fs.symlinkSync(path.join(f.directory, 'index.mjs'), path.join(f.directory, 'link'));
  assert.throws(() => f.manager.preview(f.directory), /symlinks/);
  fs.unlinkSync(path.join(f.directory, 'link'));
  fs.writeFileSync(path.join(f.directory, 'large'), Buffer.alloc(10 * 1024 * 1024));
  assert.throws(() => f.manager.preview(f.directory), /size limit/);
});

test('installed packages are frozen captures, rechecked against their trusted digest', async t => {
  const f = fixture(t);
  const preview = f.manager.preview(f.directory);
  const installed = f.manager.install(f.directory, preview.digest);
  fs.writeFileSync(path.join(f.directory, 'index.mjs'), 'throw new Error(\"source changed\")');
  const lease = await f.manager.acquire(installed.id, installed.digest);
  assert.equal(typeof lease.module.define, 'function');
  lease.release();
  fs.appendFileSync(path.join(f.manager.home, 'plugins/packages/reviewer', installed.digest, 'index.mjs'), '\n// changed');
  const discovered = f.manager.discover();
  assert.equal(discovered.registry.get('reviewer'), undefined);
  assert.match(discovered.diagnostics.join(' '), /digest mismatch/);
  await assert.rejects(f.manager.acquire(installed.id, installed.digest), /unavailable/);
});

test('a changed package after trust preview is not silently authorized', t => {
  const f = fixture(t);
  const preview = f.manager.preview(f.directory);
  fs.appendFileSync(path.join(f.directory, 'index.mjs'), '\n// new bytes');
  assert.throws(() => f.manager.install(f.directory, preview.digest), /changed/);
  assert.equal(fs.existsSync(path.join(f.manager.home, 'plugins')), false);
});

test('registry rejects duplicates and an old disposer cannot unregister a new generation', t => {
  const f = fixture(t);
  const p = inspectPackage(f.directory);
  const descriptor = { ...p.manifest, digest: p.digest, enabled: true, builtin: false };
  const registry = new SubagentRegistry();
  const dispose = registry.register(descriptor);
  assert.throws(() => registry.register(descriptor), /Duplicate/);
  registry.list()[0].enabled = false;
  assert.equal(registry.get('reviewer')?.enabled, true);
  dispose();
  registry.register(descriptor);
  dispose();
  assert.ok(registry.get('reviewer'));
});

test('malformed catalog disables plugins with a diagnostic, not permissive defaults', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.manager.home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(f.manager.home, 'plugins/catalog.json'), '{broken');
  const result = f.manager.discover();
  assert.deepEqual(result.registry.list(), []);
  assert.match(result.diagnostics.join(' '), /unavailable/);
});

test('failed package copy never poisons the immutable destination; explicit retry can succeed', t => {
  const f = fixture(t);
  const preview = f.manager.preview(f.directory);
  const write = fs.writeFileSync;
  const failing = t.mock.method(fs, 'writeFileSync', (...[file, data, options]: Parameters<typeof fs.writeFileSync>) => {
    if (String(file).includes(`${path.sep}packages${path.sep}`) && String(file).endsWith('plugin.json')) throw new Error('simulated disk failure');
    return write(file, data, options);
  });
  assert.throws(() => f.manager.install(f.directory, preview.digest), /simulated disk failure/);
  failing.mock.restore();
  assert.equal(f.manager.discover().registry.get('reviewer'), undefined);
  assert.equal(f.manager.install(f.directory, preview.digest).digest, preview.digest);
});
