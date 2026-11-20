export interface PdfAttachment { filename: string; data: string }
export const MENTION_BYTE_LIMIT = 256 * 1024 * 1024;

/** Validate inline PDF parts at the session and provider boundaries. */
export function parsePdfs(value: unknown): PdfAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('PDFは8件までです');
  let remaining = MENTION_BYTE_LIMIT;
  return value.map(pdf => {
    if (!pdf || typeof pdf.filename !== 'string' || !pdf.filename || /[\p{Cc}\p{Cf}/\\]/u.test(pdf.filename)
      || typeof pdf.data !== 'string' || pdf.data.length > Math.ceil(remaining / 3) * 4) throw new Error('PDF添付が不正です');
    const body = Buffer.from(pdf.data, 'base64');
    if (body.length > remaining || body.toString('base64') !== pdf.data || body.toString('latin1', 0, 5) !== '%PDF-') throw new Error('PDFデータが不正です');
    remaining -= body.length;
    return { filename: pdf.filename, data: pdf.data };
  });
}
