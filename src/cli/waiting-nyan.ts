import { textWidth } from './editor.ts';

export const WHALE_FRAME_MS = 180;
const WHALES = '🐳 🐋';
const WHALE_WIDTH = textWidth(WHALES);
const WAVES = '∿~  ';

/** Render one frame in terminal columns, leaving a gutter on both sides. */
export function whaleRow(frame: number, width: number): string {
  const waterWidth = width - 2;
  const travel = waterWidth - WHALE_WIDTH;
  if (travel < WAVES.length) return '';

  // Fold the path at each end instead of jumping back to the start.
  const phase = (frame * 2) % (2 * travel);
  const position = travel - Math.abs(travel - phase);
  const water = Array.from({ length: waterWidth }, (_, column) => WAVES[(column + frame) % WAVES.length]).join('');
  return ` ${water.slice(0, position)}${WHALES}${water.slice(position + WHALE_WIDTH)} `;
}
