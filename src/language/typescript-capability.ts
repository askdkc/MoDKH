import fs from 'node:fs';
import path from 'node:path';
import { executeBounded, privateEnvironment, sha256 } from '../lisp/runtime.ts';

/** Only accept a package argument from the installed official README, never shell text. */
export function recommendedTypescript(readme: string): string | undefined {
  const candidates = [...readme.matchAll(/\bnpm install[^\r\n]*\btypescript-language-server\b[^\r\n]*\btypescript@([0-9]+(?:\.[0-9x*]+){0,2})(?=\s|$)/gm)].map(match => `typescript@${match[1]}`);
  return new Set(candidates).size === 1 ? candidates[0] : undefined;
}

const probe = String.raw`
const {createRequire}=require('node:module');
const ts=createRequire(process.argv[1])(process.argv[1]);
if(typeof ts.createLanguageService!=='function'||typeof ts.ScriptSnapshot?.fromString!=='function')throw Error('Missing language service API');
const text='const answer: number = "wrong";';
const service=ts.createLanguageService({
 getScriptFileNames:()=>['probe.ts'],getScriptVersion:()=> '1',
 getScriptSnapshot:f=>f==='probe.ts'?ts.ScriptSnapshot.fromString(text):undefined,
 getCurrentDirectory:()=>process.cwd(),getCompilationSettings:()=>({noLib:true,strict:true}),
 getDefaultLibFileName:()=>'',fileExists:f=>f==='probe.ts',readFile:()=>undefined
});
try{if(!service.getSemanticDiagnostics('probe.ts').some(d=>d.code===2322))throw Error('Type mismatch diagnostic missing');}
finally{service.dispose();}
process.stdout.write('MODKH_TYPESCRIPT_API_OK');
`;

export async function probeTypescript(prefix: string, signal?: AbortSignal): Promise<{ version: string; apiSha256: string }> {
  const api = path.join(prefix, 'node_modules/typescript/lib/typescript.js');
  const bytes = fs.readFileSync(api);
  const home = path.join(prefix, '.typescript-probe');
  fs.mkdirSync(home, { mode: 0o700 });
  try {
    const result = await executeBounded(process.execPath, ['-e', probe, api], {
      cwd: home, env: privateEnvironment(home), inputDigest: sha256(bytes), timeoutMs: 10000, signal,
    });
    if (result.state !== 'exited' || result.exitCode !== 0 || result.stdout !== 'MODKH_TYPESCRIPT_API_OK') {
      throw new Error(`TypeScript language service capability failed (${result.state}): ${result.stderr.slice(-500)}`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules/typescript/package.json'), 'utf8'));
    return { version: String(manifest.version), apiSha256: sha256(bytes) };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
