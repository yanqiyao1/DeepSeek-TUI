/** ANSI-aware terminal text helpers. */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function isSgr(sequence: string): boolean {
  return sequence.endsWith("m");
}

function sgrParams(sequence: string): number[] {
  const body = sequence.slice(2, -1);
  if (!body) return [0];
  return body.split(";").map(part => part ? Number(part) : 0).filter(Number.isFinite);
}

function resetsSgrStyle(sequence: string): boolean {
  const params = sgrParams(sequence);
  return params.length === 0 || params.some(param =>
    param === 0 || param === 22 || param === 23 || param === 24 ||
    param === 25 || param === 27 || param === 28 || param === 29 ||
    param === 39 || param === 49 || param === 59
  );
}

function isCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

export function charWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombining(codePoint)) return 0;
  return isWide(codePoint) ? 2 : 1;
}

export function visibleLength(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) width += charWidth(char);
  return width;
}

export function padAnsi(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function truncateAnsi(text: string, width: number, suffix = ""): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;

  const suffixWidth = visibleLength(suffix);
  const target = Math.max(0, width - suffixWidth);
  let current = "";
  let used = 0;
  let index = 0;

  while (index < text.length) {
    const ansi = text.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
    if (ansi) {
      current += ansi[0];
      index += ansi[0].length;
      continue;
    }
    const char = Array.from(text.slice(index))[0];
    if (!char) break;
    const widthOfChar = charWidth(char);
    if (used + widthOfChar > target) break;
    current += char;
    used += widthOfChar;
    index += char.length;
  }

  return current + "\x1b[0m" + suffix;
}

export function fitAnsi(text: string, width: number): string {
  return padAnsi(truncateAnsi(text, width), width);
}

export function wrapAnsiLine(text: string, width: number): string[] {
  if (width <= 0) return [""];
  if (!text) return [""];

  const rows: string[] = [];
  let current = "";
  let activeSgr = "";
  let used = 0;
  let index = 0;

  while (index < text.length) {
    const ansi = text.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
    if (ansi) {
      const sequence = ansi[0];
      current += sequence;
      if (isSgr(sequence)) activeSgr = resetsSgrStyle(sequence) ? "" : activeSgr + sequence;
      index += sequence.length;
      continue;
    }

    const char = Array.from(text.slice(index))[0];
    if (!char) break;
    const widthOfChar = charWidth(char);
    if (used > 0 && used + widthOfChar > width) {
      rows.push(current + "\x1b[0m");
      current = activeSgr;
      used = 0;
      continue;
    }
    current += char;
    used += widthOfChar;
    index += char.length;
  }

  rows.push(current);
  return rows;
}

export function wrapAnsi(text: string, width: number): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").flatMap(line => wrapAnsiLine(line, width));
}
