import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry, defaultTools } from '../src/tools/registry.ts';

async function workspace(run: (root: string, outside: string) => Promise<void>) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-approval-target-'));
  const root = path.join(base, 'root'), outside = path.join(base, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  try { await run(root, outside); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
}

function execute(root: string, name: string, args: Record<string, unknown>, duringApproval: () => void) {
  return new ToolRegistry(defaultTools()).executeOne({ id: 'approved-target', name, args }, {
    root, approval: { approve: async () => { duringApproval(); return true; } },
  });
}

for (const destination of ['inside', 'outside']) {
  test(`run_command rejects cwd replacement during approval (${destination})`, async () => {
    await workspace(async (root, outside) => {
      const cwd = path.join(root, 'cwd');
      const other = destination === 'outside' ? outside : path.join(root, 'other');
      fs.mkdirSync(cwd);
      if (destination === 'inside') fs.mkdirSync(other);
      const result = await execute(root, 'run_command', { cwd: 'cwd', command: 'printf UNAPPROVED_EXECUTION' }, () => {
        fs.renameSync(cwd, path.join(root, 'old-cwd'));
        fs.symlinkSync(other, cwd);
      });
      assert.equal(result.status, 'not-executed');
      assert.doesNotMatch(result.output, /UNAPPROVED_EXECUTION/);
    });
  });
}

test('edit_file rejects a same-content symlink target swap', async () => {
  await workspace(async (root) => {
    fs.writeFileSync(path.join(root, 'a'), 'same');
    fs.writeFileSync(path.join(root, 'b'), 'same');
    const target = path.join(root, 'target');
    fs.symlinkSync(path.join(root, 'a'), target);
    const result = await execute(root, 'edit_file', { path: 'target', old_string: 'same', new_string: 'changed' }, () => {
      fs.unlinkSync(target); fs.symlinkSync(path.join(root, 'b'), target);
    });
    assert.equal(result.status, 'not-executed');
    assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'same');
    assert.equal(fs.readFileSync(path.join(root, 'b'), 'utf8'), 'same');
  });
});

test('create_file rejects a parent symlink target swap', async () => {
  await workspace(async (root) => {
    for (const name of ['a', 'b']) fs.mkdirSync(path.join(root, name));
    const parent = path.join(root, 'parent');
    fs.symlinkSync(path.join(root, 'a'), parent);
    const result = await execute(root, 'create_file', { path: 'parent/nested/new', content: 'new' }, () => {
      fs.unlinkSync(parent); fs.symlinkSync(path.join(root, 'b'), parent);
    });
    assert.equal(result.status, 'not-executed');
    assert.deepEqual(fs.readdirSync(path.join(root, 'a')), []);
    assert.deepEqual(fs.readdirSync(path.join(root, 'b')), []);
  });
});

test('a concurrent creation is known not-executed rather than unknown', async () => {
  await workspace(async (root) => {
    const result = await execute(root, 'create_file', { path: 'a', content: 'ours' }, () => {
      fs.writeFileSync(path.join(root, 'a'), 'concurrent');
    });
    assert.equal(result.status, 'not-executed');
    assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'concurrent');
  });
});

test('a deleted edit target is known not-executed and is not recreated', async () => {
  await workspace(async (root) => {
    fs.writeFileSync(path.join(root, 'a'), 'before');
    const result = await execute(root, 'edit_file', { path: 'a', old_string: 'before', new_string: 'after' }, () => {
      fs.unlinkSync(path.join(root, 'a'));
    });
    assert.equal(result.status, 'not-executed');
    assert.equal(fs.existsSync(path.join(root, 'a')), false);
  });
});

test('unchanged symlink targets and newly created equivalent parents still work', async () => {
  await workspace(async (root) => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    const created = await execute(root, 'create_file', { path: 'link/nested/a', content: 'before' }, () => {
      fs.mkdirSync(path.join(root, 'real', 'nested'));
    });
    assert.equal(created.status, 'ok');
    const edited = await execute(root, 'edit_file', { path: 'link/nested/a', old_string: 'before', new_string: 'after' }, () => {});
    assert.equal(edited.status, 'ok');
    assert.equal(fs.readFileSync(path.join(root, 'real', 'nested', 'a'), 'utf8'), 'after');
    const command = await execute(root, 'run_command', { cwd: 'link', command: 'printf APPROVED' }, () => {});
    assert.equal(command.status, 'ok');
    assert.match(command.output, /APPROVED/);
  });
});
