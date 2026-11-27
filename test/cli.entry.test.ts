import test from 'node:test';
import assert from 'node:assert/strict';

import { parseInvocation } from '../src/index.ts';

test('引数なしは chat(対話ハーネス)になる', () => {
  const { cmd, args } = parseInvocation([]);
  assert.equal(cmd, 'chat');
  assert.equal(args['@positional'], '');
});

test('フラグのみでも chat になり、フラグはそのまま渡る', () => {
  const { cmd, args } = parseInvocation(['--model', 'fixed/scripted', '--cwd', '/tmp/x']);
  assert.equal(cmd, 'chat');
  assert.equal(args['model'], 'fixed/scripted');
  assert.equal(args['cwd'], '/tmp/x');
});

test('明示的なサブコマンドは従来どおり解釈される', () => {
  assert.equal(parseInvocation(['session', 'list']).cmd, 'session');
  assert.equal(parseInvocation(['session', 'list']).args['@positional'], 'list');
  assert.equal(parseInvocation(['auth', 'login', 'chatgpt']).cmd, 'auth');
  assert.equal(parseInvocation(['chat', '--resume', 'abc']).cmd, 'chat');
});

test('help / version はどの位置にあっても優先される', () => {
  assert.equal(parseInvocation(['--help']).args['help'], 'true');
  assert.equal(parseInvocation(['--cwd', '/tmp', '-h']).args['help'], 'true');
  assert.equal(parseInvocation(['--version']).args['version'], 'true');
  assert.equal(parseInvocation(['-v']).args['version'], 'true');
});

test('--apikey accepts separate and attached values and rejects missing keys', () => {
  assert.equal(parseInvocation(['--apikey', 'a=b']).args.apikey, 'a=b');
  assert.equal(parseInvocation(['chat', '--apikey=a=b']).args.apikey, 'a=b');
  for (const args of [['--apikey'], ['--apikey', '--model', 'local-llm/m'], ['--apikey=']]) {
    assert.throws(() => parseInvocation(args), /--apikey/);
  }
});
