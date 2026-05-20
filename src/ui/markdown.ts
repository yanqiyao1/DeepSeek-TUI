/** Lightweight Markdown renderer for terminal transcript output. */

import { p, box } from "./palette.js";

type InlineSegment = { text: string; bold: boolean; italic: boolean; code: boolean };
type MarkdownStyle = {
  text: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  code: (text: string) => string;
  heading: (text: string) => string;
  marker: (text: string) => string;
  fence: (text: string) => string;
};

export interface MarkdownRenderOptions {
  style?: Partial<MarkdownStyle>;
}

const defaultStyle: MarkdownStyle = {
  text: p.text,
  bold: p.blueBold,
  italic: p.info,
  code: p.warning,
  heading: p.blueBold,
  marker: p.blue,
  fence: p.dim,
};

export const thinkingMarkdownStyle: MarkdownStyle = {
  text: p.thinking,
  bold: p.info,
  italic: p.info,
  code: p.warning,
  heading: p.info,
  marker: p.info,
  fence: p.thinking,
};

export function renderMarkdown(markdown: string, options: MarkdownRenderOptions = {}): string {
  const style = { ...defaultStyle, ...options.style };
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rendered: string[] = [];
  let inFence = false;
  let fenceLang = "";

  for (const rawLine of lines) {
    const fence = rawLine.match(/^\s*```([\w.+-]*)\s*$/);
    if (fence) {
      inFence = !inFence;
      fenceLang = inFence ? fence[1] || "" : "";
      rendered.push(style.fence(`  ${box.v}${fenceLang ? ` ${fenceLang}` : ""}`));
      continue;
    }

    if (inFence) {
      rendered.push(`${style.fence(`  ${box.v} `)}${style.text(rawLine)}`);
      continue;
    }

    rendered.push(renderMarkdownLine(rawLine, style));
  }

  return rendered.join("\n");
}

function renderMarkdownLine(line: string, style: MarkdownStyle): string {
  if (!line.trim()) return "";

  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    return style.heading((heading[2] ?? "").trim());
  }

  const quote = line.match(/^>\s?(.*)$/);
  if (quote) {
    return `${style.fence(box.v)} ${renderInline(quote[1] ?? "", style)}`;
  }

  const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (unordered) {
    return `${unordered[1] ?? ""}${style.marker("•")} ${renderInline(unordered[2] ?? "", style)}`;
  }

  const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
  if (ordered) {
    return `${ordered[1] ?? ""}${style.marker("•")} ${renderInline(ordered[2] ?? "", style)}`;
  }

  return renderInline(line, style);
}

function renderInline(text: string, style: MarkdownStyle): string {
  return parseInline(text).map(segment => {
    if (segment.code) return style.code(segment.text);
    if (segment.bold) return style.bold(segment.text);
    if (segment.italic) return style.italic(segment.text);
    return style.text(segment.text);
  }).join("");
}

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        segments.push({ text: text.slice(index + 1, end), bold: false, italic: false, code: true });
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        segments.push({ text: text.slice(index + 2, end), bold: true, italic: false, code: false });
        index = end + 2;
        continue;
      }
    }

    if (isEmphasisOpener(text, index)) {
      const end = findClosingEmphasis(text, index + 1);
      if (end > index + 1) {
        segments.push({ text: text.slice(index + 1, end), bold: false, italic: true, code: false });
        index = end + 1;
        continue;
      }
    }

    const nextCode = text.indexOf("`", index + 1);
    const nextBold = text.indexOf("**", index + 1);
    const nextItalic = text.indexOf("*", index + 1);
    const candidates = [nextCode, nextBold, nextItalic].filter(pos => pos >= 0);
    const next = candidates.length ? Math.min(...candidates) : text.length;
    segments.push({ text: text.slice(index, next), bold: false, italic: false, code: false });
    index = next;
  }
  return segments;
}

function isEmphasisOpener(text: string, index: number): boolean {
  if (text[index] !== "*" || text[index + 1] === "*") return false;
  return !isWhitespace(text[index + 1]);
}

function findClosingEmphasis(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] !== "*") continue;
    if (text[i + 1] === "*") {
      i++;
      continue;
    }
    if (isWhitespace(text[i - 1])) continue;
    return i;
  }
  return -1;
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}
