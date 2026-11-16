import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { MAX_IMAGE_BYTES, parseImage, type ImageAttachment } from '../agent/images.ts';

/** Read only on an explicit Ctrl+V. No clipboard text, files, credentials or network access. */
export const MAC_IMAGE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const board = $.NSPasteboard.generalPasteboard;
const revision = Number(board.changeCount);
let data = board.dataForType('public.png');
if (data.isNil()) {
  const tiff = board.dataForType('public.tiff');
  if (tiff.isNil()) throw new Error('クリップボードに画像がありません');
  if (Number(tiff.length) > 40 * 1024 * 1024) throw new Error('画像が大きすぎます');
  const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (bitmap.isNil()) throw new Error('画像を読み取れません');
  if (Number(bitmap.pixelsWide) * Number(bitmap.pixelsHigh) > 40000000) throw new Error('画像は4,000万画素以内にしてください');
  data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
}
if (data.isNil()) throw new Error('PNGへの変換に失敗しました');
if (Number(data.length) > ${MAX_IMAGE_BYTES}) throw new Error('画像は1枚5 MiB以内にしてください');
if (Number(board.changeCount) !== revision) throw new Error('クリップボードが変更されました。もう一度Ctrl+Vしてください');
JSON.stringify({mediaType:'image/png', data:ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
`;

export type ClipboardReader = (signal: AbortSignal) => Promise<ImageAttachment>;
export type ClipboardCommand = (signal: AbortSignal) => Promise<string>;

function macClipboardCommand(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_IMAGE_SCRIPT], {
      signal, timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8',
      maxBuffer: Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4096,
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(signal.aborted ? '画像の読み取りを中止しました' : `画像を貼り付けられません: ${stderr.trim().slice(0, 240) || error.message}`));
      else resolve(stdout);
    });
  });
}

export async function readClipboardImage(signal: AbortSignal, options: { platform?: string; command?: ClipboardCommand } = {}): Promise<ImageAttachment> {
  signal.throwIfAborted();
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Ctrl+Vの画像貼り付けは現在macOSのみ対応しています');
  const output = await (options.command ?? macClipboardCommand)(signal);
  signal.throwIfAborted();
  if (output.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024) throw new Error('画像が大きすぎます');
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { throw new Error('クリップボードの画像を読み取れませんでした'); }
  return parseImage(value);
}

export const MAC_TEXT_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
if (text.isNil()) throw new Error('Invalid UTF-8');
const board = $.NSPasteboard.generalPasteboard;
board.clearContents;
if (!board.setStringForType(text, $.NSPasteboardTypeString)) throw new Error('Pasteboard write failed');
`;

export async function writeClipboardText(text: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('回答のコピーはmacOSで使えます');
  try {
    const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_TEXT_SCRIPT], {
      timeout: 5000, killSignal: 'SIGKILL',
    });
    const completion = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('Pasteboard write failed')));
    });
    await Promise.all([completion, pipeline([text], child.stdin!)]);
  } catch {
    throw new Error('クリップボードに回答をコピーできませんでした');
  }
}
