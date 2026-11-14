import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePermissionPolicy, describePolicy, shouldAsk, POLICY_LEVELS } from '../src/cli/permissions.ts';

test('the three documented levels parse and round-trip', () => {
  assert.deepEqual(POLICY_LEVELS, ['all', 'workspace', 'none']);
  assert.equal(parsePermissionPolicy('workspace'), 'workspace');
  assert.equal(parsePermissionPolicy('  ALL '), 'all');
  assert.equal(parsePermissionPolicy('none'), 'none');
  // Unknown words are rejected rather than silently widening or narrowing permission.
  for (const bad of ['', 'readonly', 'workspace,all', '../all']) {
    assert.equal(parsePermissionPolicy(bad), null, bad);
  }
});

test('the default is workspace: commands inside the root run without asking', () => {
  assert.equal(shouldAsk({ policy: 'workspace', kind: 'command', outsideWorkspace: false }), false);
  assert.equal(shouldAsk({ policy: 'workspace', kind: 'edit', outsideWorkspace: false }), false);
  // Anything that reaches outside the workspace still asks.
  assert.equal(shouldAsk({ policy: 'workspace', kind: 'command', outsideWorkspace: true }), true);
  assert.equal(shouldAsk({ policy: 'workspace', kind: 'edit', outsideWorkspace: true }), true);
});

test('all never asks and none always asks', () => {
  for (const kind of ['command', 'edit'] as const) {
    assert.equal(shouldAsk({ policy: 'all', kind, outsideWorkspace: false }), false);
    assert.equal(shouldAsk({ policy: 'all', kind, outsideWorkspace: true }), false);
    assert.equal(shouldAsk({ policy: 'none', kind, outsideWorkspace: false }), true);
    assert.equal(shouldAsk({ policy: 'none', kind, outsideWorkspace: true }), true);
  }
});

test('the policy is described in words a user can act on', () => {
  assert.match(describePolicy('all'), /確認しない|自動/);
  assert.match(describePolicy('workspace'), /ワークスペース内|作業ルート内/);
  assert.match(describePolicy('none'), /読み取り|毎回|すべて/);
  // The description never promises sandboxing that this does not provide.
  assert.doesNotMatch(describePolicy('all'), /サンドボックス|隔離/);
});
