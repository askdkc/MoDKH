import path from 'node:path';
import { PluginManager } from '../plugins/manager.ts';
import { createTerminal } from './terminal.ts';

export async function runPluginCommand(positional: string): Promise<void> {
  const manager = new PluginManager();
  const split = positional.indexOf(' ');
  const action = split < 0 ? positional : positional.slice(0, split);
  const target = split < 0 ? '' : positional.slice(split + 1);
  if (action === 'list' && !target) {
    const { registry, diagnostics } = manager.discover();
    for (const diagnostic of diagnostics) process.stderr.write(`${diagnostic}\n`);
    for (const row of registry.list()) process.stdout.write(`${row.id}  ${row.enabled ? 'enabled' : 'disabled'}  ${row.kind}  ${row.version}  ${row.digest}\n`);
    if (!registry.list().length) process.stdout.write('利用可能なプラグインはありません。\n');
    return;
  }
  if (action === 'add' && target) {
    const directory = path.resolve(target);
    const preview = manager.preview(directory);
    const ui = createTerminal(process.cwd());
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.on('SIGINT', stop);
    try {
      ui.write(`任意のNode.jsコードを実行するプラグインです。OSサンドボックスではありません。\n${preview.manifest.id} ${preview.manifest.version}\n${directory}\nSHA256: ${preview.digest}\n`);
      const answer = await ui.ask('この内容を信頼して登録しますか? [y/N]', ac.signal);
      if (ac.signal.aborted || answer?.trim().toLowerCase() !== 'y') { ui.write('登録しませんでした。\n'); return; }
      const installed = manager.install(directory, preview.digest);
      ui.write(`登録しました: ${installed.id}\n`);
    } finally { process.removeListener('SIGINT', stop); ui.close(); }
    return;
  }
  if ((action === 'enable' || action === 'disable') && target) {
    manager.setEnabled(target, action === 'enable');
    process.stdout.write(`${target}: ${action} (新規の子の起動に反映。実行中の子は維持)\n`);
    return;
  }
  if (action === 'remove' && target) {
    manager.remove(target);
    process.stdout.write(`登録を解除しました: ${target}。監査用パッケージと履歴は保持します。\n`);
    return;
  }
  throw new Error('使い方: modkh plugin list | add <directory> | enable <id> | disable <id> | remove <id>');
}
