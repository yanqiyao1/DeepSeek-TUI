/** ANSI-aware terminal text helpers. */

const ANSI_RE = /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\|\x1b[@-_])/g;
const ANSI_PREFIX_RE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[P^_][\s\S]*?\x1b\\|\x1b[@-_])/;
const MAX_TERMINAL_TEXT_WIDTH = 10_000;
const MAX_ACTIVE_SGR_CHARS = 1024;
const graphemeSegmenter: { segment(input: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== "undefined" && typeof (Intl as any).Segmenter === "function"
    ? new (Intl as any).Segmenter(undefined, { granularity: "grapheme" })
    : null;

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

function nextActiveSgr(activeSgr: string, sequence: string): string {
  if (!isSgr(sequence)) return activeSgr;
  const params = sgrParams(sequence);
  if (params.length === 0) return "";
  if (params.some(param => param === 0)) {
    return params.some(param => param !== 0) ? sequence : "";
  }
  const next = activeSgr + sequence;
  return next.length > MAX_ACTIVE_SGR_CHARS ? sequence : next;
}

function safeTextWidth(width: number): number {
  const parsed = Number(width);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_TERMINAL_TEXT_WIDTH, Math.floor(parsed));
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

function isVariationSelector(codePoint: number): boolean {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
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
  if (codePoint === 0x200d || isVariationSelector(codePoint)) return 0;
  if (isCombining(codePoint)) return 0;
  return isWide(codePoint) ? 2 : 1;
}

function graphemes(text: string): string[] {
  if (!text) return [];
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), item => item.segment);
}

function nextGrapheme(text: string, index: number): string {
  if (index >= text.length) return "";
  const codePoint = text.codePointAt(index) ?? 0;
  const char = String.fromCodePoint(codePoint);
  const nextIndex = index + char.length;
  if (
    codePoint !== 0x200d &&
    !isVariationSelector(codePoint) &&
    !isCombining(codePoint) &&
    !isRegionalIndicator(codePoint) &&
    !isEmojiCodePoint(codePoint) &&
    !isCombining(text.codePointAt(nextIndex) ?? 0) &&
    (text.codePointAt(nextIndex) ?? 0) !== 0x200d &&
    !isVariationSelector(text.codePointAt(nextIndex) ?? 0)
  ) {
    return char;
  }
  if (!graphemeSegmenter) return Array.from(text.slice(index))[0] ?? "";
  const iterator = graphemeSegmenter.segment(text.slice(index))[Symbol.iterator]();
  return iterator.next().value?.segment ?? "";
}

function graphemeWidth(cluster: string): number {
  if (!cluster) return 0;
  const codePoints = Array.from(cluster).map(char => char.codePointAt(0) ?? 0);
  if (codePoints.every(codePoint => charWidth(String.fromCodePoint(codePoint)) === 0)) return 0;
  if (
    codePoints.includes(0x200d) ||
    codePoints.some(isRegionalIndicator) ||
    codePoints.some(codePoint => codePoint === 0xfe0f) ||
    codePoints.some(isEmojiCodePoint)
  ) {
    return 2;
  }
  return codePoints.reduce((sum, codePoint) => sum + charWidth(String.fromCodePoint(codePoint)), 0);
}

export function visibleLength(text: string): number {
  if (!text) return 0;
  if (isPlainAsciiText(text)) return text.length;
  let width = 0;
  for (const cluster of graphemes(stripAnsi(text))) width += graphemeWidth(cluster);
  return width;
}

function isPlainAsciiText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

export function padAnsi(text: string, width: number): string {
  const safeWidth = safeTextWidth(width);
  if (safeWidth <= 0) return text;
  return text + " ".repeat(Math.max(0, safeWidth - visibleLength(text)));
}

export function truncateAnsi(text: string, width: number, suffix = ""): string {
  const safeWidth = safeTextWidth(width);
  if (safeWidth <= 0) return "";
  if (visibleLength(text) <= safeWidth) return text;

  const safeSuffix = visibleLength(suffix) > safeWidth ? truncateAnsi(suffix, safeWidth) : suffix;
  const suffixWidth = visibleLength(safeSuffix);
  const target = Math.max(0, safeWidth - suffixWidth);
  let current = "";
  let used = 0;
  let index = 0;
  let sawSgr = false;

  while (index < text.length) {
    const ansi = text.slice(index).match(ANSI_PREFIX_RE);
    if (ansi) {
      current += ansi[0];
      if (isSgr(ansi[0])) sawSgr = true;
      index += ansi[0].length;
      continue;
    }
    const cluster = nextGrapheme(text, index);
    if (!cluster) break;
    const widthOfCluster = graphemeWidth(cluster);
    if (used + widthOfCluster > target) break;
    current += cluster;
    used += widthOfCluster;
    index += cluster.length;
  }

  return current + (sawSgr ? "\x1b[0m" : "") + safeSuffix;
}

export function fitAnsi(text: string, width: number): string {
  const safeWidth = safeTextWidth(width);
  if (safeWidth <= 0) return "";
  return padAnsi(truncateAnsi(text, safeWidth), safeWidth);
}

export function wrapAnsiLine(text: string, width: number): string[] {
  const safeWidth = safeTextWidth(width);
  if (safeWidth <= 0) return [""];
  if (!text) return [""];

  const rows: string[] = [];
  let current = "";
  let activeSgr = "";
  let rowSawSgr = false;
  let used = 0;
  let index = 0;

  while (index < text.length) {
    const ansi = text.slice(index).match(ANSI_PREFIX_RE);
    if (ansi) {
      const sequence = ansi[0];
      current += sequence;
      if (isSgr(sequence)) {
        rowSawSgr = true;
        activeSgr = nextActiveSgr(activeSgr, sequence);
      }
      index += sequence.length;
      continue;
    }

    const cluster = nextGrapheme(text, index);
    if (!cluster) break;
    const widthOfCluster = graphemeWidth(cluster);
    if (used > 0 && used + widthOfCluster > safeWidth) {
      rows.push(current + (rowSawSgr ? "\x1b[0m" : ""));
      current = activeSgr;
      rowSawSgr = activeSgr.length > 0;
      used = 0;
      continue;
    }
    if (used === 0 && widthOfCluster > safeWidth) {
      rows.push(activeSgr + " ".repeat(safeWidth) + (activeSgr ? "\x1b[0m" : ""));
      index += cluster.length;
      current = activeSgr;
      rowSawSgr = activeSgr.length > 0;
      used = 0;
      continue;
    }
    current += cluster;
    used += widthOfCluster;
    index += cluster.length;
  }

  rows.push(current);
  return rows;
}

export function wrapAnsi(text: string, width: number): string[] {
  const safeWidth = safeTextWidth(width);
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").flatMap(line => wrapAnsiLine(line, safeWidth));
}
