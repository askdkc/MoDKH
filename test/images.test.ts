import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseImage, parseImages, imageDataUrl, MAX_IMAGE_BYTES, MAX_IMAGES } from '../src/agent/images.ts';
import { readClipboardImage } from '../src/cli/clipboard.ts';
import { SessionStore } from '../src/session/store.ts';
import { toResponsesInput } from '../src/model/chatgpt/responses.ts';

const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==' };

test('image boundaries reject paths, bad base64, wrong media, oversized and excessive attachments', () => {
  assert.deepEqual(parseImage(image), image);
  assert.notEqual(parseImage(image), image);
  assert.deepEqual(parseImages(undefined), []);
  for (const value of [null, {}, { ...image, data: '/tmp/file.png' }, { ...image, data: 'https://example.com/image.png' },
    { ...image, mediaType: 'image/jpeg' }, { ...image, data: 'not base64!' }, { ...image, data: 'AA==' },
    { ...image, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }]) assert.throws(() => parseImage(value));
  assert.throws(() => parseImages(Array(MAX_IMAGES + 1).fill(image)), /最大/);
  const huge = Buffer.from(image.data, 'base64'); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20);
  assert.throws(() => parseImage({ ...image, data: huge.toString('base64') }), /画素/);
});

test('clipboard errors and cancellation do not read or substitute clipboard text', async () => {
  let calls = 0;
  const command = async () => { calls++; return JSON.stringify(image); };
  assert.deepEqual(await readClipboardImage(new AbortController().signal, { platform: 'darwin', command }), image);
  assert.equal(calls, 1);
  await assert.rejects(readClipboardImage(AbortSignal.abort(), { platform: 'darwin', command }));
  await assert.rejects(readClipboardImage(new AbortController().signal, { platform: 'linux', command }), /macOS/);
  assert.equal(calls, 1);
  await assert.rejects(readClipboardImage(new AbortController().signal, { platform: 'darwin', command: async () => 'clipboard text' }), /読み取れません/);
  const ac = new AbortController();
  await assert.rejects(readClipboardImage(ac.signal, { platform: 'darwin', command: async () => { ac.abort(); return JSON.stringify(image); } }));
});

test('PNG attachments survive session restart and Responses input preserves their image type', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-image-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  const session = store.create(root, 'chatgpt/vision');
  session.append({ role: 'user', content: '一行目\n二行目', images: [image] });
  const loaded = store.load(session.id);
  assert.deepEqual(loaded.messages, [{ role: 'user', content: '一行目\n二行目', images: [image] }]);
  assert.deepEqual(toResponsesInput(loaded.messages), [{ role: 'user', content: [
    { type: 'input_text', text: '一行目\n二行目' },
    { type: 'input_image', image_url: imageDataUrl(image), detail: 'auto' },
  ] }]);
  assert.deepEqual(toResponsesInput([{ role: 'user', content: '', images: [image] }]), [{ role: 'user', content: [
    { type: 'input_image', image_url: imageDataUrl(image), detail: 'auto' },
  ] }]);
  const file = path.join(root, `${session.id}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: '', images: [{ mediaType: 'image/png', data: 'invalid' }] } }) + '\n');
  assert.throws(() => store.load(session.id), /画像|PNG/);
});

test('a workspace render reaches the next Responses request as pixels tied to the tool call', async t => {
  const { ToolRegistry, defaultTools } = await import('../src/tools/registry.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'frame.png'), Buffer.from(image.data, 'base64'));
  const registry = new ToolRegistry(defaultTools());
  const call = { id: 'frame', name: 'view_image', args: { path: 'frame.png' } };
  const ctx = { root, approval: { approve: async () => assert.fail('read-only') } };
  const result = await registry.executeOne(call, ctx);
  assert.equal(result.status, 'ok', result.output);
  const session = new SessionStore(root).create(root, 'chatgpt/vision');
  session.append({ role: 'assistant', content: '', toolCalls: [call] });
  session.append({ role: 'tool', results: [result] });
  const wire = toResponsesInput(new SessionStore(root).load(session.id).messages).at(-1)!;
  assert.equal(wire.call_id, call.id);
  assert.ok(Array.isArray(wire.output));
  assert.deepEqual(wire.output.at(-1), { type: 'input_image', image_url: imageDataUrl(image), detail: 'auto' });
  fs.writeFileSync(path.join(root, 'frame.png'), 'invalid');
  for (const file of ['frame.png', '../frame.png']) {
    assert.equal((await registry.executeOne({ ...call, args: { path: file } }, ctx)).status, 'error');
  }
});

test('compaction byte threshold accounts for base64 attachments and tool observations', async () => {
  const { estimateRequestBytes } = await import('../src/agent/compaction.ts');
  const pdf = { filename: 'doc.pdf', data: 'JVBERg==' };
  assert.equal(estimateRequestBytes([{ role: 'user', content: '', images: [image], pdfs: [pdf] },
    { role: 'tool', results: [{ callId: 'frame', name: 'view_image', status: 'ok', output: '', image }] }]),
  image.data.length * 2 + pdf.data.length);
});
