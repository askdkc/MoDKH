import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool } from '../agent/types.ts';

export class StagedAttachments {
  private directory?: string;
  private entries = new Map<string, { file: string; size: number }>();

  stage(fd: number, size: number): string {
    this.directory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'modkh-attachments-'));
    const id = randomUUID();
    const file = path.join(this.directory, id);
    const out = fs.openSync(file, 'wx', 0o600);
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const buffer = Buffer.alloc(64 * 1024);
      let copied = 0;
      while (copied < size) {
        const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - copied), copied);
        if (!n) throw new Error('添付ファイルのサイズが変わりました');
        const chunk = buffer.subarray(0, n);
        if (chunk.includes(0) || (!copied && chunk.toString('ascii', 0, 5) === '%PDF-')) throw new Error('UTF-8テキストを指定してください');
        decoder.decode(chunk, { stream: true });
        fs.writeFileSync(out, chunk);
        copied += n;
      }
      decoder.decode();
      if (fs.fstatSync(fd).size !== size) throw new Error('添付ファイルのサイズが変わりました');
    } catch (error) {
      fs.unlinkSync(file);
      throw error;
    } finally { fs.closeSync(out); }
    this.entries.set(id, { file, size });
    return id;
  }

  discard(id: string) {
    const entry = this.entries.get(id);
    if (entry) fs.rmSync(entry.file, { force: true });
    this.entries.delete(id);
  }

  close() {
    if (this.directory) fs.rmSync(this.directory, { recursive: true, force: true });
    this.entries.clear();
    this.directory = undefined;
  }

  tool(): Tool {
    return { name: 'inspect_attachment', readOnly: true,
      description: '現在のチャットの添付IDを調べる。添付テキストをoffset（バイト）から最大4 KiB読み取る。',
      parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['id'] },
      execute: async args => {
        const entry = typeof args.id === 'string' && this.entries.get(args.id);
        if (!entry) throw new Error('添付IDが無効です。元ファイルを再添付してください');
        const offset = args.offset ?? 0;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.size) throw new Error('offsetが範囲外です');
        const fd = fs.openSync(entry.file, 'r');
        try {
          const buf = Buffer.alloc(4097);
          let n = fs.readSync(fd, buf, 0, buf.length, offset);
          if (n === buf.length) { n--; while ((buf[n] & 0xc0) === 0x80) n--; }
          return JSON.stringify({ offset, nextOffset: offset + n < entry.size ? offset + n : null, text: buf.toString('utf8', 0, n) });
        } finally { fs.closeSync(fd); }
      },
    };
  }
}
