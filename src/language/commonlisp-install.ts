import fs from 'node:fs';
import path from 'node:path';
import { download } from './native.ts';
import { commonLispRegistry, commonLispSystemProbe } from './commonlisp-systems.ts';
import { hostPlatform, type HostPlatform, type ReleaseAsset } from './platform.ts';
import { executeBounded, privateEnvironment, sha256, type ExecutionReceipt } from '../lisp/runtime.ts';
import { LspServer } from './lsp/client.ts';

export function roswellAsset(assets: ReleaseAsset[], platform: HostPlatform, glibc?: string): ReleaseAsset {
  const arch = platform.arch === 'arm64' ? 'arm64' : platform.os === 'darwin' ? 'x86-64' : 'x86_64';
  const suffix = platform.os === 'darwin' ? new RegExp(`-darwin-${arch}\\.tar\\.bz2$`) : new RegExp(`-linux-${arch}-glibc([0-9]+\\.[0-9]+)\\.tar\\.bz2$`);
  const candidates = assets.filter(a => {
    const match = suffix.exec(a.name); if (!match) return false;
    if (platform.os === 'linux') {
      if (!glibc) return false;
      const actual = glibc.split('.').map(Number), required = match[1].split('.').map(Number);
      if (actual[0] < required[0] || actual[0] === required[0] && actual[1] < required[1]) return false;
    }
    return true;
  });
  if (candidates.length !== 1) throw new Error(`No unambiguous compatible official Roswell asset: ${platform.os}/${arch}, glibc=${glibc ?? 'unknown'}`);
  const asset = candidates[0], url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/roswell/roswell/releases/download/') || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error('Official Roswell origin and SHA256 metadata required');
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 64 * 1024 * 1024) throw new Error('Invalid Roswell archive size');
  return asset;
}

interface Stage { name: string; state: 'running' | 'passed' | 'failed'; receipt?: ExecutionReceipt; detail?: string }
const repositories = ['lem-project/lem', 'cxxxr/cl-lsp', 'lem-project/async-process', 'lem-project/micros', 'lem-project/lem-mailbox', 'lem-project/lem-extension-manager', 'cxxxr/jsonrpc'] as const;
const failure = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  return `${error.name}: ${error.message}${cause ? ` (${cause.code ?? ''}: ${cause.message ?? ''})` : ''}`;
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Called under install.ts's per-language lock. Every attempt owns a new non-relocated prefix. */
export async function installCommonLisp(target: string, signal?: AbortSignal) {
  const platform = hostPlatform(); if (!platform) throw new Error('Unsupported Common Lisp host');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const space = fs.statfsSync(target);
  if (space.bavail * space.bsize < 2 * 1024 ** 3) throw new Error('Insufficient disk space: CL bootstrap needs 2 GiB reserve');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(target, 'attempt-')));
  const home = path.join(root, 'home'), rosHome = path.join(root, 'roswell-home'), prefix = path.join(root, 'runtime');
  for (const dir of [home, rosHome, prefix]) fs.mkdirSync(dir, { mode: 0o700 });
  const env = { ...privateEnvironment(home), ROSWELL_HOME: rosHome, PATH: `${prefix}/bin:${rosHome}/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,
    CL_SOURCE_REGISTRY: `(:source-registry (:tree ${JSON.stringify(path.join(rosHome, 'local-projects') + '/')}) :inherit-configuration)`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const stages: Stage[] = [], revisions: Record<string, string> = {};
  const report: Record<string, unknown> = { platform, startedAt: new Date().toISOString(), stages, revisions, status: 'installing',
    provenance: 'Verification policy: Roswell archive must match official SHA256 metadata; completed Git checkouts record commits. Consult stage results for actual verification. Quicklisp transitive downloads are upstream-managed, not independently authenticated by this installer.' };
  let settled = true, succeeded = false;
  const deadline = AbortSignal.any([AbortSignal.timeout(20 * 60_000), ...(signal ? [signal] : [])]);
  const record = () => fs.writeFileSync(path.join(root, 'install-receipt.json'), JSON.stringify(report, null, 2));
  const stage = async <T>(name: string, action: (entry: Stage) => Promise<T>): Promise<T> => {
    const entry: Stage = { name, state: 'running' }; stages.push(entry); record();
    try { const value = await action(entry); entry.state = 'passed'; record(); return value; }
    catch (e) { entry.state = 'failed'; entry.detail = failure(e); record(); throw new Error(`Common Lisp ${name}: ${failure(e)}`); }
  };
  const run = (name: string, command: string, args: string[], cwd = root) => stage(name, async entry => {
    const receipt = await executeBounded(command, args, { cwd, env, inputDigest: sha256(JSON.stringify([command,args])), timeoutMs: 20 * 60_000, maxOutputBytes: 512 * 1024, signal: deadline });
    entry.receipt = receipt; settled &&= receipt.cleanup === 'settled';
    if (receipt.state !== 'exited' || receipt.exitCode !== 0) throw new Error(`${receipt.state}/${receipt.exitCode}: ${receipt.stderr.slice(-1000)}`);
    return receipt.stdout;
  });
  try {
    await run('compiler-capability', 'cc', ['--version']);
    const metadata = await stage('release-metadata', async () => JSON.parse((await download('https://api.github.com/repos/roswell/roswell/releases/latest', 2 * 1024 ** 2, deadline)).toString('utf8')) as { tag_name: string; assets: ReleaseAsset[] });
    if (!Array.isArray(metadata.assets) || typeof metadata.tag_name !== 'string') throw new Error('Invalid Roswell metadata');
    const glibc = (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime;
    const asset = roswellAsset(metadata.assets, platform, glibc); report.release = metadata.tag_name; report.asset = asset;
    const archive = path.join(root, 'roswell.tar.bz2');
    await stage('release-download', async () => {
      const bytes = await download(asset.browser_download_url, asset.size, deadline);
      if (bytes.length !== asset.size || `sha256:${sha256(bytes)}` !== asset.digest) throw new Error('Roswell SHA256/size mismatch');
      fs.writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
    });
    const names = (await run('archive-paths', '/usr/bin/tar', ['-tjf', archive])).trim().split('\n');
    if (names.length > 2000 || names.some(n => !/^roswell\/[A-Za-z0-9._/-]*$/.test(n) || n.split('/').includes('..'))) throw new Error('Unsafe Roswell archive paths');
    const listing = (await run('archive-types', '/usr/bin/tar', ['-tvjf', archive])).trim().split('\n');
    if (listing.some(n => !/^[-d]/.test(n))) throw new Error('Roswell links/special files unsupported');
    await run('archive-extract', '/usr/bin/tar', ['-xjf', archive, '--no-same-owner']);
    await run('roswell-private-install', 'make', [`prefix=${prefix}`, 'install'], path.join(root, 'roswell'));
    const ros = path.join(prefix, 'bin/ros');
    await run('sbcl-quicklisp-setup', ros, ['setup']);
    await run('asdf-bootstrap', ros, ['install', 'asdf']);
    const projects = path.join(rosHome, 'local-projects'); fs.mkdirSync(projects, { recursive: true });
    for (const repo of repositories) {
      const destination = path.join(projects, repo.split('/')[1]);
      await run(`source:${repo}`, 'git', ['-c', 'protocol.file.allow=never', 'clone', '--depth=1', `https://github.com/${repo}.git`, destination]);
      revisions[repo] = (await run(`revision:${repo}`, 'git', ['rev-parse', 'HEAD'], destination)).trim();
    }
    const registry = commonLispRegistry(projects);
    const discoveryFile = path.join(root, 'discover-systems.lisp');
    fs.writeFileSync(discoveryFile, '(require :asdf)\n' + commonLispSystemProbe(registry));
    const discovery = await run('asdf-system-discovery', ros, ['-Q', '-l', discoveryFile, '-q']);
    if (!discovery.split(/\r?\n/).includes('MODKH_ASDF_DISCOVERY_OK')) throw new Error('ASDF discovery exited without completion evidence');
    report.asdfDiscovery = discovery;
    const native = path.join(projects, 'async-process');
    await run('native-build', 'make', [`PREFIX=${prefix}`], native);
    await run('native-install', 'make', [`PREFIX=${prefix}`, 'install'], native);
    const library = platform.os === 'darwin' ? 'libasyncprocess.dylib' : 'libasyncprocess.so';
    if (!fs.existsSync(path.join(prefix, 'lib', library))) throw new Error(`Native library missing: ${library}`);
    // Fixed host bootstrap, never a project ASDF file. No GUI frontend is loaded.
    const startup = path.join(root, 'startup.lisp');
    fs.writeFileSync(startup, `(setf *debugger-hook* (lambda (condition hook) (declare (ignore hook)) (princ condition *error-output*) (sb-ext:exit :code 1)))\n(ros:ensure-asdf)\n(require :asdf)\n(asdf:clear-source-registry)\n(asdf:initialize-source-registry '${registry})\n(ql:quickload :cffi :silent t)\n(push #P${JSON.stringify(prefix + '/lib/')} cffi:*foreign-library-directories*)\n(ql:quickload '(\"cl-lsp\" \"swank\" \"micros\") :silent t)\n`);
    const capability = '(progn (assert (fboundp (find-symbol "ADD-PACKAGE-LOCAL-NICKNAME" "SB-EXT"))) (assert (fboundp (find-symbol "RUN-PROGRAM" "UIOP"))) (assert (fboundp (find-symbol "MAIN" "CL-LSP"))) (format t "SBCL=~A ASDF=~A~%" (lisp-implementation-version) (asdf:asdf-version)) (write-line "MODKH_CL_READY"))';
    const warmed = await run('runtime-warmup', ros, ['-Q', '-l', startup, '-e', capability, '-q']);
    if (!warmed.split(/\r?\n/).includes('MODKH_CL_READY')) throw new Error('Warmup exit0 without dedicated completion marker');
    // The backend starts `ros` through PATH, so both frontend and backend receive this private env.
    const command = path.join(root, 'cl-lsp');
    fs.writeFileSync(command, `#!/bin/sh\ncd ${quote(root)} || exit 1\nexec /usr/bin/env -i ${Object.entries(env).filter(([,v])=>v!==undefined).map(([k,v])=>quote(`${k}=${v}`)).join(' ')} ${quote(ros)} -Q -l ${quote(startup)} -e '(cl-lsp:main)'\n`, { mode: 0o700 });
    const fixture = path.join(root, 'probe.lisp'), text = '(let ((value 1)) value)\n';fs.writeFileSync(fixture,text);
    const server = new LspServer({ id:'commonlisp', command,args:[],root,requestTimeoutMs:15000,inheritEnv:false,env:env as Record<string,string> });
    try {
      await stage('lsp-initialize', async()=>{await server.start(deadline);report.capabilities=server.capabilities;});
      await stage('lsp-synchronize', async()=>{report.synchronization=await server.synchronize(fixture,text);});
      await stage('lexical-definition', async()=>{
        const definitions=await server.definition(fixture,{line:0,character:16});report.lexicalDefinitions=definitions;
        if (!definitions.some(d=>d.file===fixture&&d.line===1&&d.character===8)) throw new Error('No matching lexical definition response');
      });
      await stage('unevaluated-global-observation', async()=>{
        const file=path.join(root,'global.lisp'), source='(defun modkh-unloaded () 1)\n(modkh-unloaded)\n';fs.writeFileSync(file,source);
        await server.synchronize(file,source);report.unevaluatedGlobalDefinitions=await server.definition(file,{line:1,character:2});
      });
      await stage('diagnostic-observation', async()=>{
        const invalid=path.join(root,'invalid.lisp');fs.writeFileSync(invalid,'(defun broken (');
        const result=await server.synchronize(invalid,'(defun broken (');report.diagnostics={...result,channels:server.diagnosticEvidence,verified:result.status==='observed'&&result.diagnostics.some(d=>d.severity==='error')};
      });
    } finally { try { await server.dispose(); } catch (e) { settled=false; throw e; } }
    report.launcherSha256=sha256(fs.readFileSync(command));
    report.status='ready-for-lexical-definition';report.finishedAt=new Date().toISOString();record();succeeded=true;
    return { command,args:[],version:`cl-lsp@${revisions['cxxxr/cl-lsp']}`,digest:sha256(fs.readFileSync(command)),receipt:report };
  } finally {
    if (!succeeded) {
      report.status='failed';report.finishedAt=new Date().toISOString();record();
      fs.copyFileSync(path.join(root,'install-receipt.json'),path.join(target,'last-failure.json'));
      if (settled) fs.rmSync(root,{recursive:true,force:true});
    }
  }
}

/** A partial directory or modified launcher is never a reusable managed installation. */
export function reusableCommonLisp(command: string, digest: string): boolean {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(command), 'install-receipt.json'), 'utf8'));
    return receipt.status === 'ready-for-lexical-definition' && receipt.launcherSha256 === digest
      && sha256(fs.readFileSync(command)) === digest
      && receipt.stages.some((s: Stage) => s.name === 'lsp-initialize' && s.state === 'passed')
      && receipt.stages.some((s: Stage) => s.name === 'lexical-definition' && s.state === 'passed');
  } catch { return false; }
}
