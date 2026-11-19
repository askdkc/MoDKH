export interface ImageAttachment { mediaType: 'image/png'; data: string }
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_CLIPBOARD_IMAGES = 4;
export const MAX_IMAGES = 8;

/** Clipboard and persisted JSON are data boundaries; never treat image text as a path or URL. */
export function parseImage(value: unknown): ImageAttachment {
  if (!value || typeof value !== 'object') throw new Error('画像データが不正です');
  const image = value as Record<string, unknown>;
  if (image.mediaType !== 'image/png' || typeof image.data !== 'string'
    || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
    throw new Error('画像はPNG形式・1枚5 MiB以内で指定してください');
  }
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 33 || bytes.toString('base64') !== image.data
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG画像データが不正です');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw new Error('画像は4,000万画素以内にしてください');
  return { mediaType: 'image/png', data: image.data };
}

export function parseImages(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new Error(`添付画像は最大${MAX_IMAGES}枚です`);
  return value.map(parseImage);
}

export function imageDataUrl(image: ImageAttachment): string {
  const checked = parseImage(image);
  return `data:${checked.mediaType};base64,${checked.data}`;
}
