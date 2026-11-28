import { DATASTORE_PORTS, EXPECTED_PUBLIC_PORTS, SWEEP_PORTS } from './cyber-ports-policy.ts';
import { oneLine, type Check } from './cyber-report.ts';
import { runTool } from './cyber-run.ts';
import type { ScanTarget } from './cyber-target.ts';
import { isIpv6 } from './cyber-target.ts';

export interface PortStageOptions {
  target: ScanTarget;
  /** Address the host resolves to; when absent, name resolution failed. */
  address?: string;
  source: string;
  quickPorts: boolean;
  udpPorts?: string;
  /** False when --no-nmap was given: only the server's own listener table is read. */
  remote: boolean;
  signal: AbortSignal;
  store: { write(name: string, contents: string): string };
  report(check: Check): void;
}

/** ss prints: State Recv-Q Send-Q Local:Port Peer:Port Process. */
function listeningFromSs(stdout: string): { address: string; port: string; process?: string }[] {
  const entries: { address: string; port: string; process?: string }[] = [];
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'LISTEN' || columns.length < 4) continue;
    const local = columns[3] ?? '';
    const separator = local.lastIndexOf(':');
    if (separator <= 0) continue;
    const port = local.slice(separator + 1);
    if (!/^\d+$/.test(port)) continue;
    const address = local.slice(0, separator).replace(/^\[|\]$/g, '');
    const process = /users:\(\("([^"]+)"/.exec(line)?.[1];
    entries.push({ address, port, ...(process ? { process } : {}) });
  }
  return entries;
}

/** One SSH/local audit on the server itself; only possible when the source is a Linux host. */
async function localListeners(options: PortStageOptions): Promise<Check> {
  const name = 'サーバー上の待ち受け（ss）';
  const run = await runTool('ss', ['-lntup'], options.signal, { timeoutMs: 30_000, maxBytes: 512 * 1024 });
  if (!run.started) {
    return { name, status: '未実行', lines: ['ss が見つかりません。サーバー上で `ss -lntup` を実行し、出力を確認してください。'] };
  }
  if (run.aborted) return { name, status: '中断', lines: ['待ち受けの確認を中止しました。'] };
  const cut = run.truncated ? `${name}: 出力が上限を超えたため、結果を採用しません。` : undefined;
  if (cut) return { name, status: '失敗', lines: [cut] };
  if (run.code !== 0) {
    return { name, status: '失敗', lines: [`終了コード ${run.code}。権限不足なら sudo ss -lntup で確認してください。`, oneLine(run.stderr)] };
  }
  options.store.write('ss.txt', run.stdout);
  const listeners = listeningFromSs(run.stdout);
  if (!listeners.length) {
    return { name, status: '検出なし', lines: ['待ち受けている TCP ポートはありませんでした。'] };
  }
  const lines = listeners.map(entry =>
    `${entry.address}:${entry.port}${entry.process ? ` (${entry.process})` : ''}`);
  const exposed = listeners.filter(entry =>
    DATASTORE_PORTS.has(entry.port) && !/^(127\.|::1$|\[::1\])/.test(entry.address));
  if (exposed.length) lines.push(`データストア系のポートが外部アドレスで待ち受けています: ${exposed.map(entry => entry.port).join(', ')}`);
  return {
    name, status: exposed.length ? '検出あり' : '情報', ...(exposed.length ? { count: exposed.length } : {}),
    lines: [...lines, `対象: ${options.source}（サーバー自身の待ち受け）`],
  };
}

function parseGrepable(stdout: string): { port: string; state: string; service: string }[] {
  const line = stdout.split('\n').find(entry => entry.startsWith('Host:') && /\tPorts: /.test(entry));
  if (!line) return [];
  const ports = line.split('\tPorts: ')[1] ?? '';
  const result: { port: string; state: string; service: string }[] = [];
  for (const entry of ports.split(', ')) {
    const [port, state, , , service] = entry.split('/');
    if (port && state) result.push({ port, state, service: service ?? '' });
  }
  return result;
}

/** Nmap from this machine: only the specified host, never a scan of a shared CDN address. */
async function remotePorts(options: PortStageOptions): Promise<void> {
  const { address, target } = options;
  if (!address) {
    options.report({ name: 'Nmap', status: '失敗', lines: [`${target.host} の IP アドレスを解決できませんでした。`] });
    return;
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) {
    // The Skill checks the public side from an outside circuit; a LAN-private answer is not that.
    options.report({ name: 'Nmap', status: '未実行',
      lines: [`名前解決の結果が LAN 内のアドレス (${address}) のため、公開側の到達性は判定できません。`,
        '公開側は VPN を通らない外部回線から、LAN 側はその経路から別々に確認してください。'] });
    return;
  }
  const family = isIpv6(address) ? ['-6'] : [];
  const common = ['-n', '-Pn', '-sT', '--max-rate', '50', '--reason', ...family];
  // Step 2 of the Skill scans every TCP port; --quick-ports narrows it to the representative list.
  const ports = options.quickPorts ? ['-p', SWEEP_PORTS] : ['-p-'];
  const run = await runTool('nmap', [...common, ...ports, '-oG', '-', address], options.signal, { timeoutMs: 900_000, maxBytes: 2 * 1024 * 1024 });
  const name = 'Nmap';
  if (!run.started) {
    options.report({ name, status: '未実行', lines: ['nmap が見つかりません（PATH を確認してください）。'] });
  } else if (run.aborted) {
    options.report({ name, status: '中断', lines: ['ポート走査を中止しました。'] });
  } else if (run.timedOut) {
    options.report({ name, status: '失敗', lines: ['時間切れです。走査範囲を狭めて再実行してください。'] });
  } else if (run.truncated || run.code !== 0) {
    options.report({ name, status: '失敗', lines: [`終了コード ${run.code ?? '不明'} で走査結果を取得できませんでした。`, oneLine(run.stderr)] });
  } else {
    options.store.write('nmap.txt', run.stdout);
    const found = parseGrepable(run.stdout);
    const open = found.filter(entry => entry.state === 'open');
    const filtered = found.filter(entry => entry.state === 'open|filtered');
    const unexpected = open.filter(entry => !EXPECTED_PUBLIC_PORTS.has(entry.port));
    const datastores = open.filter(entry => DATASTORE_PORTS.has(entry.port));
    const lines = open.length
      ? open.map(entry => `${entry.port}/tcp open${entry.service ? ` (${entry.service})` : ''}`)
      : [`${address} で開いている TCP ポートはありませんでした。`];
    if (filtered.length) lines.push(`開いていると確定できないポート: ${filtered.map(entry => entry.port).join(', ')}`);
    if (unexpected.length) lines.push(`公開を想定していない開いているポート: ${unexpected.map(entry => entry.port).join(', ')}`);
    if (datastores.length) lines.push(`データストアのポートが公開されています: ${datastores.map(entry => entry.port).join(', ')}`);
    lines.push(`対象: ${address}（${options.quickPorts ? `TCP ${SWEEP_PORTS}` : 'TCP 全ポート'}）`);
    options.report({
      name, status: datastores.length ? '検出あり' : '情報',
      ...(datastores.length ? { count: datastores.length } : {}), lines,
    });
  }

  if (options.signal.aborted || !options.udpPorts) return;
  const udp = await runTool('nmap', [...common, '-sU', '-p', options.udpPorts, '--max-rate', '10', '--reason', '-oG', '-', address],
    options.signal, { timeoutMs: 900_000, maxBytes: 512 * 1024 });
  const udpName = 'Nmap（UDP）';
  if (!udp.started) {
    options.report({ name: udpName, status: '未実行', lines: ['nmap が見つかりません。'] });
    return;
  }
  if (udp.aborted) {
    options.report({ name: udpName, status: '中断', lines: ['UDP の確認を中止しました。'] });
    return;
  }
  if (udp.timedOut || udp.truncated || udp.code !== 0) {
    options.report({ name: udpName, status: '失敗', lines: [`結果を取得できませんでした（終了コード ${udp.code ?? '不明'}）。`, oneLine(udp.stderr)] });
    return;
  }
  options.store.write('nmap-udp.txt', udp.stdout);
  const entries = parseGrepable(udp.stdout);
  const open = entries.filter(entry => entry.state === 'open');
  const uncertain = entries.filter(entry => entry.state === 'open|filtered');
  options.report({
    name: udpName, status: '情報',
    lines: [
      ...(open.length ? open.map(entry => `${entry.port}/udp open`) : [`${options.udpPorts} に開いている UDP ポートはありませんでした。`]),
      ...(uncertain.length ? [`open|filtered: ${uncertain.map(entry => entry.port).join(', ')}（開いていると確定したわけではありません）`] : []),
      'UDP は待ち受けや FW で気になるポートだけを選んで確認します。',
    ],
  });
}

/** Stage 2: what the server listens on, and what answers from outside. */
export async function runPortStage(options: PortStageOptions): Promise<void> {
  options.report(await localListeners(options));
  if (!options.remote) {
    options.report({
      name: 'Nmap', status: '未実行',
      lines: ['--no-nmap が指定されたため、外部からの走査はしていません。',
        '外部からの到達性は、別マシンの各経路（公開側・VPN・LAN）から確認してください。'],
    });
    return;
  }
  if (options.signal.aborted) {
    options.report({ name: 'Nmap', status: '中断', lines: ['以降の走査は開始していません。'] });
    return;
  }
  await remotePorts(options);
}
