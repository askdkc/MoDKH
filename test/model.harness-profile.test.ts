import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgentLoop } from '../src/agent/loop.ts';
import { FixedModel } from '../src/model/fixed.ts';
import { ToolRegistry } from '../src/tools/registry.ts';

for (const [id, label] of [['chatgpt/gpt-6.2-astra', 'Astra'], ['openrouter/openai/gpt-6.2-sol', 'Sol'], ['openai/gpt-6-sol', '']]) {
  test(`selected model guidance: ${id}`, async () => {
    const recorder = new FixedModel([[{ type: 'finish', stopReason: 'stop' }]]);
    await runAgentLoop([{ role: 'user', content: 'hello' }], { model: { id, stream: recorder.stream.bind(recorder) },
      system: 'Base policy', skills: false, registry: new ToolRegistry([]), root: process.cwd(),
      approval: { approve: async () => false }, signal: new AbortController().signal });
    const system = recorder.requests[0].system!;
    if (label) assert.ok(system.startsWith(`Base policy\n[${label} 6.2]`));
    else assert.equal(system, 'Base policy');
  });
}
