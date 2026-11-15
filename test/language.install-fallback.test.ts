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
for (const recommendation of ['6', '']) test(`installer compatibility fallback ${recommendation ? 'publishes only after checks' : 'rejects missing recommendation and cleans staging'}`, async () => {
  const root = temporaryDirectory('modkh-ts-install-');
  const priorPath = process.env.PATH, priorHome = process.env.DKH_HOME;
  const fixture = fileURLToPath(new URL('./fixtures/fake-lsp.mjs', import.meta.url));
  const tsRoot = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  const calls = path.join(root, 'calls.jsonl');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  // Keep the extensionless fake npm CommonJS even when TMPDIR is inside this ESM repo.
  fs.writeFileSync(path.join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const launcher = `#!${process.execPath}\nimport ${JSON.stringify(fixture)};\n`;
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),prefix=args[args.indexOf('--prefix')+1];
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
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
  process.env.DKH_HOME = path.join(root, 'home');
  try {
    const language = languageById('typescript')!;
    const result = await ensureInstalled(language, { autoInstall: true });
    const invocations = fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    assert.equal(invocations.length, recommendation ? 2 : 1);
    const servers = path.join(languageHome(), 'servers');
    assert.equal(fs.readdirSync(servers).some(name => name.includes('.staging') || name.endsWith('.lock')), false);
    if (recommendation) {
      assert.equal(result.status, 'ready', result.detail);
      assert.ok(invocations[1].includes('typescript@6'));
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
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorHome === undefined) delete process.env.DKH_HOME; else process.env.DKH_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
