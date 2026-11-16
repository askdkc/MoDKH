import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import { configureHttpModelRecording } from '../model/record-fetch.ts';

export async function recordChat(
  entry: string, argv: readonly string[], workspace: string | undefined, baseUrl: string | undefined,
): Promise<number | undefined> {
  const launchCwd = process.env.MODKH_AGENTICREPLAY_LAUNCH_CWD;
  if (launchCwd && process.env.AGENTICREPLAY_TLS_CA) {
    // The recorder starts in the workspace, while chat resolves CLI paths from the launch directory.
    process.chdir(launchCwd);
    delete process.env.MODKH_AGENTICREPLAY_LAUNCH_CWD;
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    // AgenticReplay uses the negotiated protocol upstream too. Some model APIs only offer HTTP/1.1.
    setGlobalDispatcher(new EnvHttpProxyAgent({ requestTls: { allowH2: false } }));
    configureHttpModelRecording(process.env.HTTPS_PROXY);
    return;
  }
  if (process.env.MODKH_AGENTICREPLAY === '0' ||
      process.env.AGENTICREPLAY_TLS_CA || process.env.AGENTICREPLAY_PROXY_URL) return;

  const cwd = path.resolve(workspace ?? process.cwd());
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return;
  const probe = spawnSync('agenticreplay', ['version'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 4096,
  });
  if (probe.status !== 0 || !probe.stdout?.trim()) return;

  const target = URL.parse(baseUrl ?? '');
  const tlsHosts = target?.protocol === 'https:' ? ['--tls-hosts', `+${target.hostname}`] : [];
  const child = spawn('agenticreplay', [
    'record', 'exec', '--tls-intercept', ...tlsHosts, '--no-fs', '--no-shell', '--no-agent-spans', '--',
    process.execPath, ...process.execArgv, entry, ...argv,
  ], { cwd, stdio: 'inherit', env: { ...process.env, MODKH_AGENTICREPLAY_LAUNCH_CWD: process.cwd() } });

  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTermination = () => child.kill('SIGTERM');
  process.on('SIGINT', forwardInterrupt);
  process.on('SIGTERM', forwardTermination);
  try {
    return await new Promise<number | undefined>(resolve => {
      child.once('error', error => {
        process.stderr.write(`AgenticReplay を起動できませんでした: ${error.message}\n`);
        resolve(undefined);
      });
      child.once('close', (code, signal) => {
        // AgenticReplay exits 2 for an incomplete recording after a successful chat,
        // including sessions closed before the first model request.
        resolve(code === 2 ? 0 : code ?? (signal ? 128 + constants.signals[signal] : 1));
      });
    });
  } finally {
    process.off('SIGINT', forwardInterrupt);
    process.off('SIGTERM', forwardTermination);
  }
}
