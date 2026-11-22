import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSkillContext } from '../src/agent/skills.ts';

test('coding loads the actual Kiokuko core, rather than abbreviated substitutes', () => {
  const context = prepareSkillContext('バグを修正して機能を実装', process.cwd());
  for (const name of ['kiokuko-soul', 'coding-ideal-routine-skill', 'one-shot-software-completion', 'kiokuko-single-purpose-functions']) {
    assert.ok(context.selected.includes(name), `missing ${name}`);
  }
  assert.match(context.text, /本当に、それを全部計算・保存・検索する必要があるのか/);
  assert.ok(!context.selected.some(name => name.startsWith('modkh-')));
});

import { bundledSkills, readBundledSkill, runtimeSkillText, verifyBundledSkills } from '../src/agent/bundled-skills.ts';
import { defaultTools, ToolRegistry } from '../src/tools/registry.ts';
import { runAgentLoop } from '../src/agent/loop.ts';
import { FixedModel } from '../src/model/fixed.ts';
import type { AgentMessage } from '../src/agent/types.ts';

const expectedNames = [
  'coding-ideal-routine-skill', 'natural-japanese-output', 'kiokuko-architecture',
  'kiokuko-benchmark', 'kiokuko-investigate', 'kiokuko-lisp', 'kiokuko-review',
  'kiokuko-simple-work', 'kiokuko-single-purpose-functions', 'kiokuko-skill-authoring',
  'kiokuko-soul', 'kiokuko-technical-writing', 'kiokuko-ui-design-soul',
  'kiokuko-verification', 'memory-reasoning', 'one-shot-software-completion', 'pstack',
  'veteran-programmer-skill',
];
test('all 18 source skills and 112 resources are present and digest-verified', () => {
  verifyBundledSkills();
  assert.deepEqual(bundledSkills().map(s => s.name).sort(), expectedNames.sort());
  assert.equal(bundledSkills().reduce((n, s) => n + Object.keys(s.files).length, 0), 112);
  for (const name of expectedNames) {
    const context = prepareSkillContext(`$${name}`, process.cwd());
    assert.ok(context.selected.includes(name), `explicit ${name} omitted`);
    assert.match(context.text, /MODKH host binding/);
  }
});

test('runtime extraction preserves all runtime clauses while omitting marked examples', () => {
  const full = readBundledSkill('kiokuko-lisp', 'SKILL.md', false);
  const runtime = readBundledSkill('kiokuko-lisp');
  assert.ok(Buffer.byteLength(runtime) < Buffer.byteLength(full));
  assert.doesNotMatch(runtime, /kiokuko:documentation/);
  assert.match(runtime, /prototype-driven|testable doubts/);
  assert.throws(() => runtimeSkillText('<!-- kiokuko:runtime a -->\nx'), /Incomplete/);
  assert.throws(() => runtimeSkillText('<!-- kiokuko:runtime a -->\nx\n<!-- /kiokuko:documentation -->'), /Unmatched/);
  const input = '<!-- kiokuko:runtime a -->\n```html\n<!-- /kiokuko:documentation -->\n```\nkeep\n<!-- /kiokuko:runtime -->\n<!-- kiokuko:documentation b -->\nomit\n<!-- /kiokuko:documentation -->';
  assert.match(runtimeSkillText(input), /keep/);
  assert.doesNotMatch(runtimeSkillText(input), /omit/);
});

test('public tool reads every packaged reference, supports paging and rejects unknown paths', async () => {
  const registry = new ToolRegistry(defaultTools());
  const ctx = { root: process.cwd(), approval: { approve: async () => false } };
  const listing = await registry.executeOne({ id: 'list', name: 'list_skills', args: {} }, ctx);
  assert.equal(listing.status, 'ok');
  assert.equal(JSON.parse(listing.output).length, 18);
  for (const skill of bundledSkills()) {
    for (const resource of Object.keys(skill.files)) {
      let startLine = 1;
      do {
        const read = await registry.executeOne({ id: 'read', name: 'read_skill', args: { name: skill.name, resource, startLine } }, ctx);
        assert.equal(read.status, 'ok', `${skill.name}/${resource}`);
        assert.ok(Buffer.byteLength(read.output) < 16 * 1024);
        const next = /\[nextLine: (\d+)/.exec(read.output);
        if (!next) break;
        assert.ok(Number(next[1]) > startLine);
        startLine = Number(next[1]);
      } while (true);
    }
  }
  for (const resource of ['../../package.json', '/etc/passwd', 'references/missing.md']) {
    const read = await registry.executeOne({ id: 'bad', name: 'read_skill', args: { name: 'kiokuko-soul', resource } }, ctx);
    assert.equal(read.status, 'error');
  }
});

test('selected source text and on-demand references reach the model without modifying history', async () => {
  const model = new FixedModel([
    [{ type: 'tool-call', call: { id: 'reference', name: 'read_skill', args: { name: 'one-shot-software-completion', resource: 'references/failure-recovery.md' } } }, { type: 'finish', stopReason: 'tool-calls' }],
    [{ type: 'finish', stopReason: 'stop' }],
  ]);
  const messages: AgentMessage[] = [{ role: 'user', content: 'fix a bug' }];
  const result = await runAgentLoop(messages, { model, registry: new ToolRegistry(defaultTools()), root: process.cwd(), signal: new AbortController().signal, approval: { approve: async () => false } });
  assert.equal(result.outcome, 'complete');
  assert.ok(model.requests[0].system!.includes(readBundledSkill('coding-ideal-routine-skill')));
  assert.equal(model.requests[0].system, model.requests[1].system);
  const response = model.requests[1].messages.find(m => m.role === 'tool');
  assert.ok(response?.role === 'tool' && response.results[0].status === 'ok');
  assert.match(response!.role === 'tool' ? response.results[0].output : '', /failure-recovery.md/);
  assert.ok(!JSON.stringify(messages).includes(readBundledSkill('coding-ideal-routine-skill')));
});

test('bundled child roles expose read-only skill resource tools', async () => {
  for (const role of ['modkh-worker', 'modkh-explorer']) {
    // Source package is JavaScript; import through URL to inspect its public definition.
    const plugin = await import(new URL(`../plugins/${role}/index.mjs`, import.meta.url).href);
    assert.ok(plugin.define().tools.includes('list_skills'));
    assert.ok(plugin.define().tools.includes('read_skill'));
  }
});

test('pstack routes on its own name and every reference resolves inside its own bundle', () => {
  for (const task of ['pstack で進めて', '$pstack で実装して']) {
    const context = prepareSkillContext(task, process.cwd());
    assert.ok(context.selected.includes('pstack'), `pstack omitted for ${task}`);
    assert.match(context.text, /read_skill\('pstack'/);
  }
  assert.ok(!prepareSkillContext('バグを修正', process.cwd()).selected.includes('pstack'));
  const resources = bundledSkills().find(skill => skill.name === 'pstack')!.files;
  assert.ok(Object.keys(resources).length > 60);
  for (const resource of Object.keys(resources)) {
    // subagents.md exists to name the Cursor-only options this port replaces, so it is the one allowed mention.
    if (resource === 'references/subagents.md') continue;
    const body = readBundledSkill('pstack', resource);
    assert.doesNotMatch(body, /~\/\.cursor|subagent_type|claude-opus-5-5|gemini-4-neon|agent-transcripts/, resource);
  }
  assert.throws(() => readBundledSkill('pstack', 'references/playbook-feature.md/x'), /Unknown bundled Skill or resource/);
});
