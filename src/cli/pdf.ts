import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertRealInRoot, resolveInRoot } from '../tools/guard.ts';
import { MAX_IMAGES, MAX_IMAGE_BYTES, parseImage, type ImageAttachment } from '../agent/images.ts';

const run = promisify(execFile);
export const pdfUsage = '/pdf [--pages 2-4] <PDFのパス> | <依頼文>';

async function poppler(command: string, args: string[], maxBuffer: number, signal: AbortSignal) {
  try {
    const { stdout } = await run(command, args, {
      encoding: 'buffer', env: { ...process.env, LC_ALL: 'C' }, maxBuffer, signal, timeout: 15000,
    });
    return stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Poppler の ${command} が必要です`);
    if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error('ページの変換結果が大きすぎます');
    }
    throw error;
  }
}

export async function readPdfRequest(root: string, line: string, signal: AbortSignal, availableImages: number) {
  const match = /^\/pdf\s+(?:--pages\s+(\d+)(?:-(\d+))?\s+)?([^|]+)\|(.+)$/.exec(line);
  if (!match || !match[4].trim()) throw new Error(pdfUsage);
  const filename = match[3].trim();
  const file = resolveInRoot(root, filename);
  assertRealInRoot(root, file);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('32 MiB以内のPDFファイルを指定してください');
  const info = await poppler('pdfinfo', [file], 1024 * 1024, signal);
  const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info.toString())?.[1]);
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error('PDFのページ数を取得できません');
  const first = Number(match[1] ?? 1), last = Number(match[2] ?? match[1] ?? pages);
  if (first < 1 || last < first || last > pages) throw new Error(`ページ範囲は1〜${pages}で指定してください`);
  if (last - first + 1 > availableImages) throw new Error(`全${pages}ページ。添付は画像と合わせて最大${MAX_IMAGES}枚です。--pages で範囲を指定してください`);

  const images: ImageAttachment[] = [];
  const text = [`PDF資料: ${filename}（全${pages}ページ）`];
  for (let page = first; page <= last; page++) {
    const range = ['-f', String(page), '-l', String(page)];
    const body = await poppler('pdftotext', [...range, '-layout', '-enc', 'UTF-8', file, '-'], 32 * 1024, signal);
    const png = await poppler('pdftoppm', [...range, '-singlefile', '-scale-to', '1600', '-png', file], MAX_IMAGE_BYTES, signal);
    images.push(parseImage({ mediaType: 'image/png', data: png.toString('base64') }));
    text.push(`ページ ${page}\n${body.toString().trim() || '（テキスト層なし。添付画像を参照）'}`);
  }
  return { prompt: match[4].trim(), text: text.join('\n\n'), images };
}
