import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { SessionStore } from '../src/session/store.ts';
import { toResponsesInput } from '../src/model/chatgpt/responses.ts';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { TerminalUI } from '../src/cli/terminal.ts';
import { readPdfRequest } from '../src/cli/pdf.ts';
import { screenFrom } from './tui.screen.ts';

test('PDF chat command attaches the selected page and its text to the coding turn', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-pdf-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ language: { autoInstall: false } }));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    ...[6, 7].map(stream => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents ${stream} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...['EXCLUDED', 'Build the red button'].map(label => {
      const content = `q 30 0 0 30 120 100 cm BI /W 1 /H 1 /CS /RGB /BPC 8 /F /AHx ID FF0000> EI Q 1 0 0 rg 10 20 80 30 re f BT /F1 12 Tf 10 90 Td (${label}) Tj ET\n`;
      return `<< /Length ${content.length} >>\nstream\n${content}endstream`;
    }),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(root, 'design spec.pdf'), pdf);
  fs.writeFileSync(path.join(root, 'design notes.txt'), 'not a PDF');
  const input = new PassThrough() as unknown as ReadStream;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; return input; };
  const terminalOutput = new PassThrough() as unknown as WriteStream;
  terminalOutput.columns = 100;
  terminalOutput.rows = 40;
  let screen = '';
  terminalOutput.on('data', chunk => { screen += chunk.toString(); });
  const terminal = new TerminalUI(root, input, terminalOutput);
  t.after(() => terminal.close());
  const submission = terminal.next();
  input.write('/pdf @des');
  const visible = screenFrom(screen, 40).join('\n');
  assert.match(visible, /› design spec\.pdf/);
  assert.doesNotMatch(visible, /design notes\.txt/);
  input.write('\t\r');
  const command = await submission;
  assert.equal(command?.trim(), '/pdf @"design spec.pdf"');
  const document = await readPdfRequest(root, command!.trim(), new AbortController().signal, 4);
  assert.equal(document.images.length, 2);
  assert.match(document.text, /Build the red button/);
  assert.match(document.prompt, /要約/);
  const selected = terminal.next();
  input.write('/pdf --pages 2 @des');
  assert.doesNotMatch(screenFrom(screen, 40).join('\n'), /design notes\.txt/);
  input.write('\t| Implement this layout\r');
  const selectedCommand = await selected;
  assert.equal(selectedCommand, '/pdf --pages 2 @"design spec.pdf" | Implement this layout');
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const editing = requests.length === 1;
    const delta = editing ? { tool_calls: [{ index: 0, id: 'create', type: 'function', function: {
      name: 'create_file', arguments: JSON.stringify({ path: 'button.html', content: '<button>Build</button>' }),
    } }] } : { content: 'Done' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = { id: 'pdf', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: editing ? 'tool_calls' : 'stop' }] };
    res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const child = spawn(process.execPath, [process.env.MODKH_TEST_ENTRY ?? new URL('../src/index.ts', import.meta.url).pathname,
    'chat', '--cwd', root, '--model', 'compatible/fixture', '--base-url', baseUrl], {
    env: { ...process.env, MODKH_HOME: home, MODKH_PLAIN: '1', MODKH_AGENTICREPLAY: '0' }, timeout: 60000,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.stdin.end(`/pdf --pages 3 design spec.pdf | invalid\n${selectedCommand}\n/exit\n`);
  assert.equal((await once(child, 'close'))[0], 0, output);
  assert.equal(requests.length, 2, output);
  assert.equal(fs.readFileSync(path.join(root, 'button.html'), 'utf8'), '<button>Build</button>');
  const store = new SessionStore(path.join(home, 'sessions'));
  const users = store.load(store.list()[0].id).messages.filter(m => m.role === 'user');
  assert.equal(users.length, 1, output);
  assert.match(users[0].content, /Implement this layout/);
  assert.match(users[0].content, /Build the red button/);
  assert.doesNotMatch(users[0].content, /EXCLUDED/);
  assert.equal(users[0].images?.length, 1);
  const expected = spawnSync('pdftoppm', ['-f', '2', '-l', '2', '-singlefile', '-scale-to', '1600',
    '-png', path.join(root, 'design spec.pdf')]);
  assert.equal(expected.status, 0);
  assert.deepEqual(Buffer.from(users[0].images![0].data, 'base64'), expected.stdout);
  assert.deepEqual(requests[0].messages.find(m => m.role === 'user')?.content, [
    { type: 'text', text: users[0].content },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + expected.stdout.toString('base64') } },
  ]);
  assert.doesNotMatch(output, /Build the red button/);
  assert.match(JSON.stringify(toResponsesInput(users)), /data:image\/png;base64,iVBOR/);
});
