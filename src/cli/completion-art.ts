import { randomInt } from 'node:crypto';

const celebrations = [
  String.raw`    \ | /
   -(°∀°)-     /\_/\
    / | \    ∩(・∀・)∩`,
  String.raw`     /) /)
    (｡･ω･｡)っ  ☆
   c(_つ_ﾉ`,
  String.raw`     +     *
       /\_/\
    ヽ(＾▽＾)ﾉ  ♪
       /  /`,
  String.raw`   ♪  ʕ•ᴥ•ʔ  ♪
     へ(   )へ
       /  >`,
  String.raw`      .-.
     (•ө•)   ♪
    <(   )>
      ^ ^`,
  String.raw`     /\       /\
   ( ﾟ∀ﾟ)人(ﾟ∀ﾟ )
    /_/      \_)`,
  String.raw`      ☆
     /_\
   ＼(＾o＾)／
      |  |`,
  String.raw`     *  \o/  *
    o     |     o
     \   / \   /
      '-------'`,
  String.raw`     /\   *
    /  \
   | () |  ↑
   /|__|\
     vv`,
  String.raw`      __________
     (  ・∀・  )
      \      /
       '----'
        _||_`,
];

/** Deal every picture once per round, keeping adjacent rounds distinct too. */
export function completionArtPicker(): () => string {
  let deck: string[] = [];
  let previous: string | undefined;
  return () => {
    if (!deck.length) {
      deck = [...celebrations];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [deck[i], deck[j]] = [deck[j]!, deck[i]!];
      }
      const last = deck.length - 1;
      if (deck[last] === previous) {
        const j = randomInt(last);
        [deck[last], deck[j]] = [deck[j]!, deck[last]!];
      }
    }
    previous = deck.pop()!;
    return `${previous}  ＜ 作業が終わったよ！`;
  };
}
