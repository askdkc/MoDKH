import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareSkillContext, mergeSkillContext, selectTaskSkills, SKILL_CONTEXT_BYTES } from '../src/agent/skills.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { FixedModel } from '../src/model/fixed.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { AgentMessage } from '../src/agent/types.ts';

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.modkh'));
  return root;
}
const entry = (name: string, keywords: string[] = []) => ({ name, keywords, description: name, path: `${name}.md` });
const catalog = (root: string, items: unknown) => fs.writeFileSync(path.join(root, '.modkh/skills.json'), JSON.stringify(items));

test('task selection handles Japanese, English boundaries, explicit names and unrelated tasks', t => {
  const root = fixture(t);
  assert.ok(prepareSkillContext('バグを修正', root).selected.includes('coding-ideal-routine-skill'));
  assert.ok(prepareSkillContext('fix error', root).selected.includes('coding-ideal-routine-skill'));
  assert.deepEqual(prepareSkillContext('prefix fixture', root).selected, []);
  assert.equal(prepareSkillContext('hello', root).text, '');
  assert.deepEqual(prepareSkillContext('こんにちは', root).selected, ['kiokuko-soul', 'natural-japanese-output']);
  const skills = [entry('one'), entry('one-other'), entry('two'), entry('three'), entry('four')];
  assert.deepEqual(selectTaskSkills('$one-other', skills).map(s => s.name), ['one-other']);
  assert.equal(selectTaskSkills('$one $two $three $four', skills).length, 3);
});

test('local metadata selects only relevant bodies, exact duplicates are delivered once', t => {
  const root = fixture(t);
  catalog(root, [entry('php', ['PHP']), entry('unused'), entry('duplicate', ['PHP'])]);
  fs.writeFileSync(path.join(root, 'php.md'), 'SPECIALIZED_GUIDANCE');
  fs.writeFileSync(path.join(root, 'duplicate.md'), 'SPECIALIZED_GUIDANCE');
  const context = prepareSkillContext('PHP', root);
  assert.equal(context.selected.filter(name => name !== 'kiokuko-soul').length, 1);
  assert.equal(context.warnings.length, 0); // missing unused.md was never read
  assert.equal(context.text.split('SPECIALIZED_GUIDANCE').length, 2);
  assert.ok(context.bytes <= SKILL_CONTEXT_BYTES);
});

test('invalid catalogs, escaping symlinks and oversized or empty bodies degrade without blocking', t => {
  const root = fixture(t), outside = fixture(t);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE_SECRET');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'escape.md'));
  catalog(root, [entry('escape'), entry('large'), entry('empty')]);
  fs.writeFileSync(path.join(root, 'large.md'), 'x'.repeat(SKILL_CONTEXT_BYTES + 1));
  fs.writeFileSync(path.join(root, 'empty.md'), '');
  const context = prepareSkillContext('$escape $large $empty', root);
  assert.deepEqual(context.selected, ['kiokuko-soul']);
  assert.doesNotMatch(context.text, /OUTSIDE_SECRET/);
  assert.equal(context.warnings.length, 3);
  catalog(root, [{ ...entry('invalid'), keywords: [null] }]);
  const fallback = prepareSkillContext('fix bug', root);
  assert.ok(fallback.selected.includes('coding-ideal-routine-skill'));
  assert.equal(fallback.warnings.length, 1);
});

test('budget never truncates skill instructions and changed files are refreshed next turn', t => {
  const root = fixture(t);
  catalog(root, [entry('custom')]);
  fs.writeFileSync(path.join(root, 'custom.md'), 'x'.repeat(SKILL_CONTEXT_BYTES));
  assert.ok(!prepareSkillContext('$custom', root).selected.includes('custom'));
  fs.writeFileSync(path.join(root, 'custom.md'), 'FIRST');
  assert.match(prepareSkillContext('$custom', root).text, /FIRST/);
  fs.writeFileSync(path.join(root, 'custom.md'), 'SECOND');
  assert.match(prepareSkillContext('$custom', root).text, /SECOND/);
});

test('mergeSkillContext appends new guidance and never rewrites the earlier prefix', t => {
  const root = fixture(t);
  const first = prepareSkillContext('fix the cache hit rate', root);
  const second = prepareSkillContext('コミットメッセージを書いて', root);
  assert.ok(first.text.length > 0 && second.text.length > 0, 'both turns select guidance');
  const merged = mergeSkillContext(first, second);
  assert.ok(merged.text.startsWith(first.text), 'previously sent bytes stay verbatim');
  // Re-merging already delivered guidance is a no-op, so a repeated topic cannot grow the prompt.
  assert.equal(mergeSkillContext(merged, second).text, merged.text);
  // An unrelated message must not shrink guidance the session already paid for.
  const unrelated = prepareSkillContext('what is this repo?', root);
  assert.equal(mergeSkillContext(merged, unrelated).text, merged.text);
  assert.equal(mergeSkillContext(undefined, second).text, second.text);
  t.diagnostic(`first=${first.bytes}B merged=${merged.bytes}B`);
});

test('real loop injects once per request, keeps stable tool-step prefix and never persists guidance', async t => {
  const root = fixture(t);
  const model = new FixedModel([
    [{ type: 'tool-call', call: { id: 'r', name: 'probe', args: {} } }, { type: 'finish', stopReason: 'tool-calls' }],
    [{ type: 'text-delta', text: 'done' }, { type: 'finish', stopReason: 'stop' }],
  ]);
  const registry = new ToolRegistry([{ name: 'probe', description: '', parameters: {}, readOnly: true, execute: async () => 'ok' }]);
  const messages: AgentMessage[] = [{ role: 'user', content: 'fix the bug' }];
  const opts = { model, registry, root, system: 'BASE_POLICY', signal: new AbortController().signal, approval: { approve: async () => false } };
  assert.equal((await runAgentLoop(messages, opts)).outcome, 'complete');
  assert.match(model.requests[0].system!, /^BASE_POLICY/);
  assert.match(model.requests[0].system!, /\[coding-ideal-routine-skill\]/);
  assert.equal(model.requests[0].system, model.requests[1].system);
  assert.doesNotMatch(JSON.stringify(messages), /\[coding-ideal-routine-skill\]/);
  messages.push({ role: 'user', content: 'review this change' });
  const next = new FixedModel([[{ type: 'finish', stopReason: 'stop' }]]);
  await runAgentLoop(messages, { ...opts, model: next });
  assert.match(next.requests[0].system!, /\[kiokuko-review\]/);
  assert.doesNotMatch(next.requests[0].system!, /\[coding-ideal-routine-skill\]/);
  const disabled = new FixedModel([[{ type: 'finish', stopReason: 'stop' }]]);
  await runAgentLoop(messages, { ...opts, model: disabled, skills: false });
  assert.equal(disabled.requests[0].system, 'BASE_POLICY');
});
