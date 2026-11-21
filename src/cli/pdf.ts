import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import { nearbyFileNames } from './nearby-file-names.ts';
import path from 'node:path';
import { MAX_IMAGES, MAX_IMAGE_BYTES, parseImage, type ImageAttachment } from '../agent/images.ts';

const run = promisify(execFile);
export const pdfUsage = '/pdf [--pages 2-4] @<PDFのパス> [依頼文]（| 区切りも可）';
const pdfPrefix = /^\/pdf[ \t]+(?:--pages[ \t]+(\d+)(?:-(\d+))?[ \t]+)?/;

export function isPdfPathPrefix(text: string): boolean {
  return pdfPrefix.exec(text.trimStart())?.[0] === text.trimStart() && !text.includes('\n');
}

function parsePdfRequest(line: string) {
  const prefix = pdfPrefix.exec(line);
  if (!prefix) throw new Error(pdfUsage);
  const args = line.slice(prefix[0].length);
  if (/^--pages(?:\s|$)/.test(args)) throw new Error(pdfUsage);
  const pathAndPrompt = args.startsWith('@') ? args.slice(1) : args;
  const quoted = pathAndPrompt.startsWith('"');
  // A closing quote or .pdf suffix marks the end of the path for inline requests.
  // Keep the legacy pipe syntax for paths without a .pdf extension as well.
  const match = quoted
    ? /^("(?:[^"\\\r\n]|\\["\\])*")(?:(?:[ \t]*\||\s+)([\s\S]*))?$/.exec(pathAndPrompt)
    : /^([^|\r\n]*?\.pdf)(?:[ \t]*\|\s*|\s+)([\s\S]*)$/i.exec(pathAndPrompt)
      ?? /^([^|\r\n]+)(?:\|([\s\S]*))?$/.exec(pathAndPrompt);
  if (!match) throw new Error(pdfUsage);
  const filename = quoted ? JSON.parse(match[1]) as string : match[1].trim();
  const prompt = match[2]?.trim() ?? 'このPDFの内容を要約してください。';
  if (!filename.trim() || !prompt) throw new Error(pdfUsage);
  return { filename, prompt, start: prefix[1], end: prefix[2] };
}

async function poppler(command: string, args: string[], maxBuffer: number, signal: AbortSignal) {
  try {
    const { stdout } = await run(command, args, {
      encoding: 'buffer', env: { ...process.env, LC_ALL: 'C' }, maxBuffer, signal, timeout: 60000,
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

export async function readPdfRequest(root: string, line: string, signal: AbortSignal, availableImages: number,
  confirmExternal?: (file: string) => Promise<boolean>, onPage?: (current: number, total: number) => void) {
  const { filename, prompt, start, end } = parsePdfRequest(line);
  const requested = filename.startsWith('~/') ? path.join(os.homedir(), filename.slice(2)) : path.resolve(root, filename);
  const file = await fs.realpath(requested).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`PDFが見つかりません: ${filename}。パスを確認してください。対話端末では /pdf @ の候補を Tab で補完できます${await nearbyFileNames(requested)}`);
    throw error;
  });
  const outside = (base: string, target: string) => {
    const relative = path.relative(base, target);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  const external = !outside(root, requested) && outside(await fs.realpath(root), file);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error('512 MiB以内のPDFファイルを指定してください');
  if (external && !await confirmExternal?.(file)) throw new Error('作業ルート外のPDFの読み込みは許可されませんでした');
  signal.throwIfAborted();
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let directory: string | undefined;
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || await fs.realpath(file) !== file) {
      throw new Error('PDFの参照先が変更されました。指定し直してください');
    }
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modkh-pdf-'));
    const snapshot = path.join(directory, 'input.pdf');
    if (!opened.size) throw new Error('PDFファイルが空です');
    await pipeline(handle.createReadStream({ end: opened.size - 1 }),
      createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }), { signal });
    if ((await fs.stat(snapshot)).size !== opened.size) throw new Error('読み込み中にPDFのサイズが変わりました');
    const pages = await renderPdf(snapshot, filename, start, end, availableImages, signal, onPage);
    return { prompt, ...pages };
  } finally {
    await handle.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

async function renderPdf(snapshot: string, filename: string, start: string | undefined, end: string | undefined,
  availableImages: number, signal: AbortSignal, onPage?: (current: number, total: number) => void) {
  const info = await poppler('pdfinfo', [snapshot], 1024 * 1024, signal);
  const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(info.toString())?.[1]);
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error('PDFのページ数を取得できません');
  const first = Number(start ?? 1), last = Number(end ?? start ?? pages);
  if (first < 1 || last < first || last > pages) throw new Error(`ページ範囲は1〜${pages}で指定してください`);
  if (last - first + 1 > availableImages) throw new Error(`全${pages}ページ。添付は画像と合わせて最大${MAX_IMAGES}枚です。--pages で範囲を指定してください`);

  const images: ImageAttachment[] = [];
  const text = [`PDF資料: ${filename}（全${pages}ページ）`];
  for (let page = first; page <= last; page++) {
    onPage?.(page - first + 1, last - first + 1);
    const range = ['-f', String(page), '-l', String(page)];
    const body = await poppler('pdftotext', [...range, '-layout', '-enc', 'UTF-8', snapshot, '-'], 32 * 1024, signal);
    const png = await poppler('pdftoppm', [...range, '-singlefile', '-scale-to', '1600', '-png', snapshot], MAX_IMAGE_BYTES, signal);
    images.push(parseImage({ mediaType: 'image/png', data: png.toString('base64') }));
    text.push(`ページ ${page}\n${body.toString().trim() || '（テキスト層なし。添付画像を参照）'}`);
  }
  return { text: text.join('\n\n'), images };
}
