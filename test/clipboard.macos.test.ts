import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { MAC_IMAGE_SCRIPT } from '../src/cli/clipboard.ts';
import { parseImage } from '../src/agent/images.ts';

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
for (const tiff of [false, true]) {
  test(`macOS image reader exports ${tiff ? 'TIFF' : 'PNG'} as PNG without accessing the user clipboard`, { skip: process.platform !== 'darwin' }, () => {
    // Exercise real AppKit NSData/bitmap selectors, replacing only the pasteboard with an in-memory fixture.
    const board = `(() => {
      const png = $.NSData.alloc.initWithBase64EncodedStringOptions('${data}',0);
      const bitmap = $.NSBitmapImageRep.imageRepWithData(png);
      return {changeCount:1,dataForType:type => type === '${tiff ? 'public.tiff' : 'public.png'}'
        ? ${tiff ? 'bitmap.TIFFRepresentation' : 'png'} : {isNil:()=>true}};
    })()`;
    const source = MAC_IMAGE_SCRIPT.replace('$.NSPasteboard.generalPasteboard', board);
    const output = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', source], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    const image = parseImage(JSON.parse(output));
    assert.equal(image.mediaType, 'image/png');
    const bytes = Buffer.from(image.data, 'base64');
    assert.equal(bytes.readUInt32BE(16), 1);
    assert.equal(bytes.readUInt32BE(20), 1);
  });
}
