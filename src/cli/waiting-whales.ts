import { textWidth } from './editor.ts';

export const WHALE_FRAME_MS = 180;
const LEAD_WHALE = '🐳';
const TRAILING_WHALE = '🐋';
const LEAD_WIDTH = textWidth(LEAD_WHALE);
const TRAILING_WIDTH = textWidth(TRAILING_WHALE);
const WHALE_GAP = 8;
const WAVES = '∿~  ';

/** Render one frame in terminal columns, leaving a gutter on both sides. */
export function whaleRow(frame: number, width: number): string {
  const waterWidth = width - 2;
  const space = waterWidth - LEAD_WIDTH - TRAILING_WIDTH;
  const gap = Math.min(WHALE_GAP, space - WAVES.length);
  if (gap < 1) return '';

  const travel = space - gap;
  // Swim left, then start the next pass at the right edge.
  const passFrames = Math.ceil(travel / 2) + 1;
  const position = Math.max(0, travel - (frame % passFrames) * 2);
  const leadEnd = position + LEAD_WIDTH;
  const trailingPosition = leadEnd + gap;
  const water = Array.from({ length: waterWidth }, (_, column) => WAVES[(column + frame) % WAVES.length]).join('');
  return ` ${water.slice(0, position)}${LEAD_WHALE}${water.slice(leadEnd, trailingPosition)}${TRAILING_WHALE}${water.slice(trailingPosition + TRAILING_WIDTH)} `;
}
