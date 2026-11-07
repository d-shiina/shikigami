// Romaji to hiragana, so the node palette finds 繰り返し by "kurikaesi" or
// "kurikaeshi" when the IME is off. Hepburn and kunrei-shiki both work.

const TABLE: Record<string, string> = {
  a: "あ", i: "い", u: "う", e: "え", o: "お",
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
  ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
  sa: "さ", si: "し", shi: "し", su: "す", se: "せ", so: "そ",
  za: "ざ", zi: "じ", ji: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
  ta: "た", ti: "ち", chi: "ち", tu: "つ", tsu: "つ", te: "て", to: "と",
  da: "だ", di: "ぢ", du: "づ", de: "で", do: "ど",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
  ha: "は", hi: "ひ", hu: "ふ", fu: "ふ", he: "へ", ho: "ほ",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
  pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
  ya: "や", yu: "ゆ", yo: "よ",
  ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
  wa: "わ", wo: "を", nn: "ん",
  fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ", vu: "ゔ",
  "-": "ー",
};
// Contracted sounds: kya, sha, cha, ja…
for (const [head, kana] of Object.entries({ k: "き", g: "ぎ", n: "に", h: "ひ", b: "び", p: "ぴ", m: "み", r: "り", s: "し", z: "じ", t: "ち", c: "ち", j: "じ" })) {
  const lead = { s: ["sy", "sh"], z: ["zy", "j"], t: ["ty", "ch"], c: ["cy"], j: ["jy"] }[head] ?? [`${head}y`];
  for (const l of lead) Object.assign(TABLE, { [`${l}a`]: `${kana}ゃ`, [`${l}u`]: `${kana}ゅ`, [`${l}o`]: `${kana}ょ` });
}

/**
 * `word` read as romaji, in hiragana; null when it is not romaji
 * ("excel", "url"), so the search does not invent a reading.
 */
export function toKana(word: string): string | null {
  if (word.length < 3 || !/^[a-z-]+$/.test(word)) return null;
  let out = "";
  let at = 0;
  while (at < word.length) {
    const c = word[at]!;
    const next = word[at + 1];
    // A doubled consonant is a small tsu (kitte → きって); n before a consonant or at the end is ん.
    if (next === c && /[bcdfghjkmprstvwyz]/.test(c)) {
      out += "っ";
      at += 1;
      continue;
    }
    if (c === "n" && (next === undefined || (/[^aiueoy]/.test(next) && next !== "n"))) {
      out += "ん";
      at += 1;
      continue;
    }
    const len = [3, 2, 1].find((n) => TABLE[word.slice(at, at + n)] !== undefined);
    if (!len) return null;
    out += TABLE[word.slice(at, at + len)];
    at += len;
  }
  return out;
}
