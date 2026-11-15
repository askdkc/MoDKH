import fs from 'node:fs';
import path from 'node:path';
import { executeBounded, privateEnvironment, sha256 } from '../lisp/runtime.ts';
import { hostPlatform, phpAsset, type ReleaseAsset } from './platform.ts';
import { LspServer } from './lsp/client.ts';

/** Reads only official release origins, with a hard body bound and bounded redirects. */
export async function download(url: string, max: number, signal?: AbortSignal): Promise<Buffer> {
  const allowed = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  const controller = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
  for (let redirects = 0; redirects < 5; redirects++) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !allowed.has(target.hostname) || target.username || target.password) throw new Error('Unapproved native release origin');
    const response = await fetch(target, { redirect: 'manual', signal: controller, headers: { 'User-Agent': 'MoDKH', Accept: 'application/vnd.github+json' } });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); url = new URL(response.headers.get('location') ?? '', target).href; continue; }
    if (!response.ok || !response.body) throw new Error(`Release download HTTP ${response.status}`);
    if (Number(response.headers.get('content-length') ?? 0) > max) { await response.body.cancel(); throw new Error('Release exceeds byte limit'); }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > max) throw new Error('Release exceeds byte limit');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many official release redirects');
}
export async function installPhpantom(target: string, signal?: AbortSignal): Promise<{ command: string; version: string; digest: string; receipt: Record<string, unknown> }> {
  const platform = hostPlatform(); if (!platform) throw new Error('Unsupported PHPantom host');
  const metadata = JSON.parse((await download('https://api.github.com/repos/PHPantom-dev/phpantom_lsp/releases/latest', 2 * 1024 * 1024, signal)).toString('utf8')) as { tag_name?: string; assets?: ReleaseAsset[] };
  if (typeof metadata.tag_name !== 'string' || !Array.isArray(metadata.assets)) throw new Error('Invalid official release metadata');
  const asset = phpAsset(metadata.assets, platform);
  const space = fs.statfsSync(path.dirname(target));
  if (space.bavail * space.bsize < asset.size * 6 + 64 * 1024 * 1024) throw new Error('Insufficient disk space for native archive and extraction');
  const staging = fs.mkdtempSync(`${target}.staging-`);
  let settled = true;
  try {
    const bytes = await download(asset.browser_download_url, asset.size, signal);
    const archiveHash = sha256(bytes);
    if (bytes.length !== asset.size || `sha256:${archiveHash}` !== asset.digest) throw new Error('Official PHPantom archive SHA256/size mismatch');
    const archive = path.join(staging, 'release.tar.gz'); fs.writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
    const run = async (args: string[]) => {
      const result = await executeBounded('/usr/bin/tar', args, { cwd: staging, env: privateEnvironment(staging), signal, timeoutMs: 30000, inputDigest: archiveHash });
      settled &&= result.cleanup === 'settled';
      if (result.state !== 'exited' || result.exitCode !== 0) throw new Error(`Native extraction ${result.state}: ${result.stderr}`);
      return result.stdout;
    };
    const names = (await run(['-tzf', archive])).trim().split('\n');
    if (names.length > 128 || names.some(n => !/^[A-Za-z0-9._/-]+$/.test(n) || path.isAbsolute(n) || n.split('/').includes('..'))) throw new Error('Unsafe archive paths');
    const listing = (await run(['-tvzf', archive])).trim().split('\n');
    if (listing.some(line => !/^[-d]/.test(line))) throw new Error('Archive links/special files not permitted');
    await run(['-xzf', archive, '--no-same-owner']);
    const binaries = names.filter(n => path.basename(n) === 'phpantom_lsp');
    if (binaries.length !== 1) throw new Error('Expected exactly one PHPantom binary');
    const binary = path.join(staging, binaries[0]);
    if (!fs.lstatSync(binary).isFile() || fs.realpathSync(binary) !== binary) throw new Error('Invalid native binary');
    fs.chmodSync(binary, 0o700);
    const binaryHash = sha256(fs.readFileSync(binary));
    const server = new LspServer({ id: 'php', command: binary, args: [], root: staging, requestTimeoutMs: 20000, env: privateEnvironment(staging) as Record<string,string>, inheritEnv: false });
    try { await server.start(signal); } finally { await server.dispose(); }
    const receipt = { platform, release: metadata.tag_name, archiveHash, binaryHash, capabilities: server.capabilities, initialized: true, finishedAt: new Date().toISOString() };
    fs.unlinkSync(archive);
    fs.writeFileSync(path.join(staging,'install-receipt.json'),JSON.stringify(receipt,null,2));
    if (fs.existsSync(target)) throw new Error('Native destination exists; refusing destructive replacement');
    fs.renameSync(staging,target);
    return { command:path.join(target,binaries[0]),version:metadata.tag_name,digest:binaryHash,receipt };
  } finally { if (settled) fs.rmSync(staging,{recursive:true,force:true}); }
}
