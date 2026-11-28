import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChat } from '../src/cli/chat.ts';
import type { Model, ModelEvent, ToolCall } from '../src/agent/types.ts';
import { SessionStore } from '../src/session/store.ts';
import { compactLocally, COMPACTION_MARKER } from '../src/agent/compaction.ts';

for (const mode of ['threshold', 'overflow', 'repeated reads', 'blocked reread', 'ignored block', 'legacy resume']) {
  test('CLI continues file work after ' + mode, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-work-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const previous = process.env.MODKH_HOME;
    process.env.MODKH_HOME = home;
    t.after(() => { if (previous === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = previous; });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      modelContextWindows: { 'compatible/work-test': 10000 }, memory: { enabled: false }, language: { autoInstall: false },
    }));
    fs.writeFileSync(path.join(home, 'notes.txt'), 'Expected marker: BLUE\n' + Array.from({ length: 600 }, (_, i) => 'Observation ' + i).join('\n'));
    const task = 'Implement a marker that will eventually generate a report. Create marker.js, then replace RED with BLUE.';
    let resume: string | undefined;
    if (mode === 'legacy resume') {
      const session = new SessionStore().create(home, 'compatible/work-test');
      session.append({ role: 'user', content: task });
      fs.writeFileSync(path.join(home, 'marker.js'), 'RED');
      session.append({ role: 'assistant', content: '', toolCalls: [{ id: 'read-before-restart', name: 'read_file', args: { path: 'notes.txt' } }] });
      session.append({ role: 'tool', results: [{ callId: 'read-before-restart', name: 'read_file', status: 'ok', output: fs.readFileSync(path.join(home, 'notes.txt'), 'utf8') }] });
      session.recordCompaction(compactLocally(session.messages, undefined, 0)!, 0);
      session.setStatus('error', '保存先には作業ディレクトリ内の Markdown またはテキストファイルを指定してください');
      resume = session.id;
    }
    const input = resume ? ['/exit'] : [task, '/exit'];
    let calls = 0, reads = 0, sawCheckpoint = false, sawReminder = false;
    const model: Model = { id: 'compatible/work-test', async *stream(request): AsyncIterable<ModelEvent> {
      const text = request.messages.map(m => m.role === 'tool' ? '' : m.content).join('\n');
      const tools = request.tools.map(t => t.name);
      if (!tools.includes('edit_file')) {
        yield { type: 'text-delta', text: '-' };
        yield { type: 'finish', stopReason: 'stop' };
        return;
      }
      calls++;
      sawCheckpoint ||= text.includes(COMPACTION_MARKER) && text.includes(task) && text.includes('Expected marker: BLUE');
      sawReminder ||= /repeated inspections/i.test(text);
      const blocked = request.messages.some(m => m.role === 'tool' && m.results.some(r =>
        r.status === 'not-executed' && r.output.includes('[REPEATED_READ]')));
      const repeat = mode === 'repeated reads' && !sawReminder || mode === 'blocked reread' && !blocked || mode === 'ignored block';
      let call: ToolCall;
      if (!resume && calls === 1) call = { name: 'create_file', id: 'create', args: { path: 'marker.js', content: 'RED' } };
      else if (!resume && (calls === 2 || (repeat && reads < 12))) {
        call = { name: 'read_file', id: 'read-' + ++reads, args: { path: 'notes.txt' } };
      } else if (mode === 'overflow' && calls === 3) {
        yield { type: 'finish', stopReason: 'error', errorMessage: 'request exceeds the context window' };
        return;
      } else if (fs.readFileSync(path.join(home, 'marker.js'), 'utf8') === 'RED' && (sawCheckpoint || sawReminder)) {
        call = { name: 'edit_file', id: 'edit', args: { path: 'marker.js', old_string: 'RED', new_string: 'BLUE' } };
      } else {
        yield { type: 'text-delta', text: 'Finished.' };
        yield { type: 'finish', stopReason: 'stop' };
        return;
      }
      yield { type: 'tool-call', call };
      yield { type: 'usage', input: ['threshold', 'blocked reread', 'ignored block'].includes(mode) && calls === 2 ? 8000 : 20, output: 10 };
      yield { type: 'finish', stopReason: 'tool-calls' };
    } };
    await runChat({ args: { cwd: home, model: model.id, resume }, modelFactory: () => model, terminal: {
      interactive: false, next: async () => input.shift() ?? null, write() {}, unread() {}, ask: async () => null,
      confirm: async () => 'y', choose: async () => null, showPage: async () => {}, setModel() {}, close() {},
    } });
    if (mode === 'blocked reread' || mode === 'ignored block') {
      const store = new SessionStore();
      const session = store.load(store.list()[0]!.id);
      const readResults = session.messages.flatMap(m => m.role === 'tool' ? m.results : []).filter(r => r.name === 'read_file');
      assert.equal(readResults.filter(r => r.status === 'ok').length, 3);
      assert.equal(readResults.filter(r => r.status === 'not-executed').length, mode === 'ignored block' ? 3 : 1);
      if (mode === 'ignored block') {
        assert.equal(session.status, 'interrupted');
        assert.equal(fs.readFileSync(path.join(home, 'marker.js'), 'utf8'), 'RED');
        return;
      }
    }
    assert.equal(fs.readFileSync(path.join(home, 'marker.js'), 'utf8'), 'BLUE');
    assert.equal(mode === 'repeated reads' ? sawReminder : sawCheckpoint, true);
    assert.equal(fs.existsSync(path.join(home, 'report.md')), false);
    if (resume) {
      assert.equal(new SessionStore().load(resume).compaction?.workFrom, 0);
      assert.equal(reads, 0, 'resuming consumes the saved evidence without replaying the previous call');
    }
  });
}
