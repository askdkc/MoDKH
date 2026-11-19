import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMcp } from '../src/mcp-discovery.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'project');
  await mkdir(root);
  return { dir, root, put: (name: string, text: string) => writeFile(join(root, name), text) };
}

test('discovers framework descriptors and gives explicit stdio entries precedence', async t => {
  const { root, put } = await fixture(t);
  await put('package.json', JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2' } }));
  await put('composer.json', JSON.stringify({ 'require-dev': { 'laravel/boost': '^2' } }));
  const svelte = { command: 'npx', args: ['-y', '@sveltejs/mcp'] };
  assert.deepEqual(await discoverMcp(root), { svelte });
  await put('artisan', '');
  const boost = { command: 'php', args: ['artisan', 'boost:mcp'] };
  assert.deepEqual(await discoverMcp(root), { svelte, 'laravel-boost': boost });
  await put('.mcp.json', JSON.stringify({ mcpServers: {
    svelte: { type: 'stdio', command: 'custom', args: ['two words'] }, extra: { command: 'other' },
    bad: { command: 'x', args: [2] }, remote: { type: 'http', command: 'x' }, blank: { command: ' ' },
  } }));
  assert.deepEqual(await discoverMcp(root), { svelte: { command: 'custom', args: ['two words'] },
    extra: { command: 'other', args: [] }, 'laravel-boost': boost });
});

test('ignores malformed manifests, artisan alone, and symlinked config outside root', async t => {
  const { dir, root, put } = await fixture(t);
  await put('artisan', '');
  await put('package.json', '{broken');
  const outside = join(dir, 'outside.json');
  await writeFile(outside, '{"mcpServers":{"outside":{"command":"outside"}}}');
  await symlink(outside, join(root, '.mcp.json'));
  assert.deepEqual(await discoverMcp(root), {});
});
