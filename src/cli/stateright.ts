import { fileURLToPath } from 'node:url';
import { executeBounded } from '../lisp/runtime.ts';
import { findStateright, staterightRoot } from '../tools/stateright-runtime.ts';

export async function runStaterightCommand(action: string): Promise<void> {
  if (!['install', 'status'].includes(action)) throw new Error('使い方: modkh stateright install | status');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  try {
    if (action === 'install') {
      process.stdout.write('Stateright検証器を構築・導入中（Rust/Cargoが必要）…\n');
      const receipt = await executeBounded('cargo', ['install', '--locked', '--path', `${root}native/stateright`, '--root', staterightRoot(), '--force'],
        { cwd: root, env: process.env, inputDigest: '', timeoutMs: 600_000, maxOutputBytes: 32768, outputOverflow: 'tail', signal: controller.signal });
      if (receipt.state !== 'exited' || receipt.exitCode !== 0 || receipt.cleanup !== 'settled') throw new Error(`Stateright導入失敗: ${receipt.state}\n${receipt.stderr}`);
    }
    const command = findStateright();
    if (!command) { process.stdout.write('Stateright: 未導入。modkh stateright install で導入できます。\n'); return; }
    const receipt = await executeBounded(command, ['--protocol'], { cwd: root, env: process.env, inputDigest: '', timeoutMs: 5000, signal: controller.signal });
    let info;
    try { info = JSON.parse(receipt.stdout); } catch { /* invalid protocol */ }
    if (receipt.state !== 'exited' || receipt.exitCode !== 0 || receipt.cleanup !== 'settled' || info?.name !== 'modkh-stateright' || info?.schemaVersion !== 1) {
      throw new Error('Stateright検証器のプロトコルが不正です。modkh stateright install で更新してください。');
    }
    process.stdout.write(`Stateright: 利用可能\n${command}\n次のmodkh起動で前鬼が自動登録されます。\n`);
  } finally { process.removeListener('SIGINT', abort); }
}
