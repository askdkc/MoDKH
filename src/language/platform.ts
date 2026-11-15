export interface HostPlatform { os: 'darwin' | 'linux'; arch: 'x64' | 'arm64'; target: string }
export function hostPlatform(os: string = process.platform, arch: string = process.arch): HostPlatform | undefined {
  if ((os !== 'darwin' && os !== 'linux') || (arch !== 'x64' && arch !== 'arm64')) return;
  return { os, arch, target: `${arch === 'x64' ? 'x86_64' : 'aarch64'}-${os === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}` };
}
export interface ReleaseAsset { name: string; browser_download_url: string; size: number; digest?: string }
/** Exact official target match; never silently substitute another OS/CPU or an unchecked asset. */
export function phpAsset(assets: ReleaseAsset[], platform: HostPlatform): ReleaseAsset {
  const found = assets.filter(a => a.name === `phpantom_lsp-${platform.target}.tar.gz`);
  if (found.length !== 1) throw new Error(`Official PHPantom asset unavailable for ${platform.target}`);
  const asset = found[0];
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error('Official SHA256 release metadata required');
  const url = new URL(asset.browser_download_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/PHPantom-dev/phpantom_lsp/releases/download/')) throw new Error('Unexpected PHPantom release origin');
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 128 * 1024 * 1024) throw new Error('Invalid release size');
  return asset;
}
