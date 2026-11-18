import fs from 'node:fs';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, parseImage } from '../agent/images.ts';
import { ToolError, type Tool } from '../agent/types.ts';
import { resolveInRoot, assertRealInRoot } from './guard.ts';

async function workspaceImage(bytes: Buffer) {
  let png = bytes;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const { default: sharp } = await import('sharp');
    const jpeg = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).autoOrient().toColourspace('srgb');
    png = await jpeg.clone().png().toBuffer();
    // A small JPEG can exceed the attachment budget once decoded to lossless PNG.
    if (png.length > MAX_IMAGE_BYTES) {
      png = await jpeg.resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    }
  }
  return parseImage({ mediaType: 'image/png', data: png.toString('base64') });
}

export const viewImageTool: Tool = {
  readOnly: true,
  name: 'view_image',
  description: '作業ルート内のPNG・JPEGを画像として確認する（5 MiB以内）。3Dゲームは実際の操作前後の画面、写実的な人物は全身と顔の寄りをレンダーして確認し、形状・材質・照明の修正に使う。',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async execute(args, ctx) {
    const file = resolveInRoot(ctx.root, args.path);
    const real = fs.realpathSync(file);
    assertRealInRoot(ctx.root, real);
    const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) {
        throw new ToolError('INVALID_IMAGE', '5 MiB以内のPNGまたはJPEGファイルを指定してください');
      }
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
        if (!count) throw new ToolError('READ_FAILED', '読み込み中に画像サイズが変わりました');
        offset += count;
      }
      const image = await workspaceImage(bytes);
      return { status: 'ok', output: String(args.path), image };
    } finally {
      fs.closeSync(fd);
    }
  },
};
