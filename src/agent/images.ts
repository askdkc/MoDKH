import { MENTION_BYTE_LIMIT } from './documents.ts';

export interface ImageAttachment { mediaType: 'image/png' | 'image/jpeg'; data: string }

function jpegDimensions(bytes: Buffer): [number, number] {
  if (bytes.length >= 4 && bytes.readUInt16BE() === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
    for (let i = 2; i + 4 < bytes.length && bytes[i++] === 0xff;) {
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (i + 2 > bytes.length || marker === 0xda) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 11 && length === 8 + 3 * bytes[i + 7]) {
        return [bytes.readUInt16BE(i + 5), bytes.readUInt16BE(i + 3)];
      }
      i += length;
    }
  }
  throw new Error('JPEG画像データが不正です');
}
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_CLIPBOARD_IMAGES = 4;
export const MAX_IMAGES = 8;

/** Clipboard and persisted JSON are data boundaries; never treat image text as a path or URL. */
export function parseImage(value: unknown, maxBytes = MAX_IMAGE_BYTES): ImageAttachment {
  if (!value || typeof value !== 'object') throw new Error('画像データが不正です');
  const image = value as Record<string, unknown>;
  if ((image.mediaType !== 'image/png' && image.mediaType !== 'image/jpeg') || typeof image.data !== 'string'
    || image.data.length > Math.ceil(maxBytes / 3) * 4) throw new Error(`画像はPNG/JPEG形式・${maxBytes / 1048576} MiB以内で指定してください`);
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== image.data) throw new Error('画像データが不正です');
  let width: number, height: number;
  if (image.mediaType === 'image/jpeg') [width, height] = jpegDimensions(bytes);
  else {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG画像データが不正です');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  }
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('画像は4,000万画素以内にしてください');
  return { mediaType: image.mediaType, data: image.data };
}

export function parseImages(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error(`添付画像は最大${MAX_IMAGES}枚です`);
  return value.map(image => parseImage(image, MENTION_BYTE_LIMIT));
}

export function imageDataUrl(image: ImageAttachment): string {
  const checked = parseImage(image);
  return `data:${checked.mediaType};base64,${checked.data}`;
}
