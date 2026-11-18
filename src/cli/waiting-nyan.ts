// Original terminal sprite inspired by https://github.com/TeMPOraL/nyan-mode.
// Two vertical pixels per terminal cell, so the cat fits the three composer rows.
export const NYAN_FRAME_MS = 180;
const TRAIL_WIDTH = 6;
const CAT = [
  '......C..C',
  '.KKKK.CCCC',
  'KPPPPCCECE',
  'KpPPPCcCcC',
  '.KKKK.CCC.',
];
const FEET = ['..C.C..C..', '.C.C..C...'];
const RAINBOW = ['196', '208', '226', '46', '39', '129'];
const INK: Record<string, string> = { K: '215', P: '212', p: '161', C: '250', c: '204', E: '16' };
export const NYAN_WIDTH = TRAIL_WIDTH + CAT[0].length;

export function nyanRows(frame: number, panelStyle: string): string[] {
  const pixels = [...CAT, FEET[frame % FEET.length]].map((line, y) => [
    ...Array.from({ length: TRAIL_WIDTH }, (_, x) => RAINBOW[y + ((x + frame) % 4 < 2 ? -1 : 1)]),
    ...Array.from(line, pixel => INK[pixel]),
  ]);
  return [0, 2, 4].map(y => {
    let row = '';
    let style = '';
    for (let x = 0; x < NYAN_WIDTH; x++) {
      const top = pixels[y][x], bottom = pixels[y + 1][x];
      const foreground = top ?? bottom;
      const next = foreground ? `${bottom && top ? `48;5;${bottom}` : panelStyle};38;5;${foreground}` : panelStyle;
      if (next !== style) {
        row += `\x1b[${next}m`;
        style = next;
      }
      row += top ? '▀' : bottom ? '▄' : ' ';
    }
    return row + '\x1b[0m';
  });
}
