import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensureInstalled, resolveServer } from '../src/language/install.ts';
import { languageById } from '../src/language/catalog.ts';
import { languageHome } from '../src/language/detect.ts';
import { temporaryDirectory } from '../src/lisp/runtime.ts';

// npm/LSP transport are fixtures; the TypeScript semantic API probe uses the real dependency.
for (const recommendation of ['6', '', 'invalid-proxy']) test(`installer compatibility fallback ${recommendation === '6' ? 'publishes only after checks' : recommendation === 'invalid-proxy' ? 'does not start npm for an unsafe proxy' : 'rejects missing recommendation and cleans staging'}`, async () => {
  const root = temporaryDirectory('modkh-ts-install-');
  const priorPath = process.env.PATH, priorHome = process.env.MODKH_HOME;
  const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url));
  const tsRoot = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  const calls = path.join(root, 'calls.jsonl');
  const prior = new Map(['MODKH_LANGUAGE_NPM_PROXY', 'MODKH_LANGUAGE_NPM_CA_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'NPM_TOKEN', 'NPM_CONFIG_USERCONFIG'].map(
    key => [key, process.env[key]]));
  const configured = 'http://proxy.test:3128';
  if (recommendation === 'invalid-proxy') process.env.MODKH_LANGUAGE_NPM_PROXY = 'http://user:never-log-this@proxy.test:3128';
  else if (recommendation) process.env.MODKH_LANGUAGE_NPM_PROXY = configured;
  else delete process.env.MODKH_LANGUAGE_NPM_PROXY;
  const ca = path.join(root, 'test-ca.pem');
  fs.writeFileSync(ca, 'test only');
  if (recommendation === '6') process.env.MODKH_LANGUAGE_NPM_CA_FILE = ca;
  else delete process.env.MODKH_LANGUAGE_NPM_CA_FILE;
  process.env.NODE_EXTRA_CA_CERTS = '/fixture/ambient-ca.pem';
  process.env.HTTPS_PROXY = 'https://ambient-proxy.test';
  process.env.NPM_TOKEN = 'fixture-secret';
  process.env.NPM_CONFIG_USERCONFIG = '/fixture/private.npmrc';
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  // Keep the extensionless fake npm CommonJS even when TMPDIR is inside this ESM repo.
  fs.writeFileSync(path.join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const launcher = `#!${process.execPath}\nif (process.env.npm_config_https_proxy || process.env.NODE_EXTRA_CA_CERTS || process.env.HTTPS_PROXY || process.env.NPM_TOKEN) process.exit(13);\nawait import(${JSON.stringify(fixture)});\n`;
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),prefix=args[args.indexOf('--prefix')+1];
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args, proxy:process.env.npm_config_https_proxy, ca:process.env.NODE_EXTRA_CA_CERTS, leaked:['HTTPS_PROXY','NPM_TOKEN','NPM_CONFIG_USERCONFIG','MODKH_LANGUAGE_NPM_PROXY','MODKH_LANGUAGE_NPM_CA_FILE'].some(k=>k in process.env)})+'\\n');
const ts=path.join(prefix,'node_modules/typescript');
if(args.includes('typescript@latest')) {
 fs.mkdirSync(path.join(prefix,'node_modules/.bin'),{recursive:true});
 fs.mkdirSync(path.join(prefix,'node_modules/typescript-language-server'),{recursive:true});
 fs.mkdirSync(path.join(ts,'lib'),{recursive:true});
 fs.writeFileSync(path.join(prefix,'node_modules/.bin/typescript-language-server'),${JSON.stringify(launcher)},{mode:0o700});
 fs.writeFileSync(path.join(prefix,'node_modules/typescript-language-server/package.json'),JSON.stringify({version:'fixture'}));
 fs.writeFileSync(path.join(prefix,'node_modules/typescript-language-server/README.md'),${JSON.stringify(recommendation ? `npm install -g typescript-language-server typescript@${recommendation}\n` : 'no recommendation')});
} else {
 if(!args.includes('typescript@6'))process.exit(12);
 fs.rmSync(ts,{recursive:true,force:true});fs.symlinkSync(${JSON.stringify(tsRoot)},ts);
}
fs.writeFileSync(path.join(prefix,'package-lock.json'),JSON.stringify({fixture:true,args}));
`, { mode: 0o700 });
  process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ''}`;
  process.env.MODKH_HOME = path.join(root, 'home');
  try {
    const language = languageById('typescript')!;
    const result = await ensureInstalled(language, { autoInstall: true });
    if (recommendation === 'invalid-proxy') {
      assert.equal(result.status, 'error');
      assert.match(result.detail!, /MODKH_LANGUAGE_NPM_PROXY/);
      assert.doesNotMatch(result.detail!, /never-log-this/);
      assert.equal(fs.existsSync(calls), false);
      return;
    }
    const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line =>
      JSON.parse(line) as { args: string[]; proxy?: string; ca?: string; leaked: boolean });
    for (const call of invocations) {
      assert.equal(call.proxy, recommendation ? configured : undefined);
      assert.equal(call.ca, recommendation ? ca : undefined);
      assert.equal(call.leaked, false);
    }
    assert.equal(invocations.length, recommendation ? 2 : 1);
    const servers = path.join(languageHome(), 'servers');
    assert.equal(fs.readdirSync(servers).some(name => name.includes('.staging') || name.endsWith('.lock')), false);
    if (recommendation) {
      assert.equal(result.status, 'ready', result.detail);
      assert.ok(invocations[1].args.includes('typescript@6'));
      assert.equal(resolveServer(language, {}).status, 'ready');
      const receipt = JSON.parse(fs.readFileSync(path.join(servers, 'typescript/install-receipt.json'), 'utf8'));
      assert.equal(receipt.typescript.selection, 'typescript@6');
      assert.match(receipt.typescript.recommendationSha256, /^[a-f0-9]{64}$/);
      assert.match(receipt.typescript.apiSha256, /^[a-f0-9]{64}$/);
    } else {
      assert.equal(result.status, 'error');
      assert.match(result.detail!, /no unambiguous official/);
      assert.equal(fs.existsSync(path.join(servers, 'typescript')), false);
      assert.equal((await ensureInstalled(language, { autoInstall: true })).status, 'unavailable');
    }
  } finally {
    for (const [key, value] of prior) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorHome === undefined) delete process.env.MODKH_HOME; else process.env.MODKH_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
