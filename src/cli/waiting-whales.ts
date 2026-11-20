import { textWidth } from './editor.ts';

export const WHALE_FRAME_MS = 180;
const POD = ['🐳', '🐋', '🫍'];
const WHALE_WIDTH = textWidth(POD[0]);
const WAVES = '∿~  ';

/** Show a moving window onto a repeating pod, never half of an emoji. */
export function whaleRow(frame: number, width: number): string {
  if (width < 11) return '';
  const waterWidth = width - 2;
  const stride = WHALE_WIDTH + Math.min(8, width - 10);
  const offset = frame * 2;
  let row = ' ';
  for (let col = 0; col < waterWidth;) {
    const position = col + offset;
    if (position % stride === 0 && col + WHALE_WIDTH <= waterWidth) {
      row += POD[Math.floor(position / stride) % POD.length];
      col += WHALE_WIDTH;
    } else {
      row += WAVES[(col + frame) % WAVES.length];
      col++;
    }
  }
  return row + ' ';
}
