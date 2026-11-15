import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildModelFromRef, parseConnectArgs } from '../src/cli/chat.ts';
import { FixedModel } from '../src/model/fixed.ts';

test('parseConnectArgs は ref を解釈し --base-url を読む', () => {
  assert.deepEqual(parseConnectArgs('fixed/scripted'), { ref: 'fixed/scripted', baseUrl: undefined });
  assert.deepEqual(parseConnectArgs('compatible/xyz --base-url http://localhost:1234/v1'), {
    ref: 'compatible/xyz',
    baseUrl: 'http://localhost:1234/v1',
  });
  assert.deepEqual(parseConnectArgs('chatgpt/gpt-5.2'), { ref: 'chatgpt/gpt-5.2', baseUrl: undefined });
});

test('parseConnectArgs は引数なしや余分な引数を null にする', () => {
  assert.equal(parseConnectArgs(''), null);
  assert.equal(parseConnectArgs('   '), null);
  assert.equal(parseConnectArgs('openai/gpt --unknown 1'), null);
  assert.equal(parseConnectArgs('--base-url http://x'), null);
});

test('buildModelFromRef は固定応答モデルを返す', () => {
  assert.ok(buildModelFromRef('fixed/scripted') instanceof FixedModel);
});

test('buildModelFromRef は未知のプロバイダーで明示エラー(自動切替なし)', () => {
  assert.throws(
    () => buildModelFromRef('incompatible-provider/xyz'),
    /自動で切り替え/,
  );
});

test('buildModelFromRef は chatgpt 未ログインで明示エラー', () => {
  const prev = process.env['MODKH_HOME'];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-connect-'));
  process.env['MODKH_HOME'] = home;
  try {
    assert.throws(
      () => buildModelFromRef('chatgpt/gpt-5.2'),
      /ChatGPTにログインしていない/,
    );
  } finally {
    if (prev === undefined) delete process.env['MODKH_HOME'];
    else process.env['MODKH_HOME'] = prev;
  }
});

test('buildModelFromRef は API キー未設定で明示エラー', () => {
  const prev = process.env['OPENAI_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  try {
    assert.throws(() => buildModelFromRef('openai/gpt-5.2'), /OPENAI_API_KEY/);
  } finally {
    if (prev !== undefined) process.env['OPENAI_API_KEY'] = prev;
  }
});
