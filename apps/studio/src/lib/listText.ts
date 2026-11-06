// A short list of values (the values a case matches) edited as one line of
// text: `A, B, 10`. Numbers and true / false become numbers and booleans;
// write "10" in quotes to mean the text 10, or to put a comma in a value.

type Scalar = string | number | boolean | null;

const SEPARATOR = /[,、，]/;

function needsQuotes(text: string): boolean {
  return text !== text.trim() || text === "" || SEPARATOR.test(text) || text.includes('"') || typeof fromWord(text) !== "string";
}

/** A bare word as a value: a number, true / false / null, or the text itself. */
function fromWord(word: string): Scalar {
  if (word === "true") return true;
  if (word === "false") return false;
  if (word === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(word)) return Number(word);
  return word;
}

/** The line a list shows as. */
export function listToText(values: unknown): string {
  if (!Array.isArray(values)) return "";
  return values
    .map((v) => (typeof v === "string" ? (needsQuotes(v) ? `"${v.replaceAll('"', '""')}"` : v) : JSON.stringify(v)))
    .join(", ");
}

/** The list a line means. Empty text is an empty list. */
export function textToList(text: string): Scalar[] {
  const values: Scalar[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  };
  skipSpace();
  if (i >= text.length) return values;
  for (;;) {
    skipSpace();
    if (text[i] === '"') {
      // A quoted value: "" inside is one quote.
      let value = "";
      i += 1;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (text[i] === '"') {
          i += 1;
          break;
        } else {
          value += text[i];
          i += 1;
        }
      }
      values.push(value);
      while (i < text.length && !SEPARATOR.test(text[i] ?? "")) i += 1;
    } else {
      let word = "";
      while (i < text.length && !SEPARATOR.test(text[i] ?? "")) {
        word += text[i];
        i += 1;
      }
      values.push(fromWord(word.trim()));
    }
    if (i >= text.length) break;
    i += 1; // the separator
  }
  return values;
}
