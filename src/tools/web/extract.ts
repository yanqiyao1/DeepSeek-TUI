import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { ContentProfile } from "./types.js";
import { safeJsonStringify } from "../../utils/json-safe.js";

const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_MARKDOWN_LINK_URL_CHARS = 4096;
const MAX_PROCESS_BODY_CHARS = 2_000_000;
const MAX_PROFILE_BODY_CHARS = 1_000_000;
const MAX_STRUCTURED_TEXT_CHARS = 1_000_000;
const MAX_PROFILE_TITLE_CHARS = 500;
const MAX_READABLE_ROOT_CANDIDATES = 200;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_CELLS = 20;

export function decodeHtml(text: string): string {
  return safeString(text).slice(0, MAX_PROCESS_BODY_CHARS)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(CONTROL_TEXT_GLOBAL_RE, " ");
}

export function normalizeText(text: string): string {
  return decodeHtml(safeString(text).replace(/<[^>]+>/g, " ")).replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim();
}

export function processBody(body: string, contentType: string, format: "markdown" | "text" | "raw"): string {
  const sourceBody = safeString(body);
  if (format === "raw") return sourceBody;
  const safeBody = sourceBody.slice(0, MAX_PROCESS_BODY_CHARS);
  const normalizedContentType = safeString(contentType).toLowerCase();
  const isHtml = normalizedContentType.includes("text/html") || /<html[\s>]/i.test(safeBody) || /<(article|main|body|p|h1|h2)[\s>]/i.test(safeBody);
  if (!isHtml) return formatStructuredText(safeBody, contentType);
  return format === "markdown" ? htmlToMarkdown(safeBody) : htmlToText(safeBody);
}

export function contentProfile(body: string, contentType: string, processed: string, truncated: boolean): ContentProfile {
  const sourceBody = safeString(body);
  const sourceProcessed = safeString(processed);
  const safeBody = sourceBody.slice(0, MAX_PROFILE_BODY_CHARS);
  const safeProcessed = sourceProcessed.slice(0, MAX_PROCESS_BODY_CHARS);
  const normalizedType = safeString(contentType).toLowerCase();
  const format: ContentProfile["format"] = normalizedType.includes("html")
    ? "html"
    : normalizedType.includes("json")
      ? "json"
      : normalizedType.includes("xml")
        ? "xml"
        : /^text\//.test(normalizedType) || !normalizedType
          ? "text"
          : "binary";
  let title: string | undefined;
  let mainContentRatio: number | undefined;
  if (format === "html") {
    try {
      const $ = cheerio.load(safeBody);
      title = normalizeText($("title").first().text()).slice(0, MAX_PROFILE_TITLE_CHARS) || undefined;
      const total = Math.max(1, normalizeText($("body").text() || $.text()).length);
      mainContentRatio = Math.min(1, normalizeText(selectReadableRoot($).text()).length / total);
    } catch {
      title = undefined;
    }
  }
  return {
    ...(title ? { title } : {}),
    format,
    character_count: sourceProcessed.length,
    word_count: countWords(safeProcessed),
    truncated: Boolean(truncated) || sourceBody.length > safeBody.length || sourceProcessed.length > safeProcessed.length,
    ...(mainContentRatio !== undefined ? { main_content_ratio: Number(mainContentRatio.toFixed(3)) } : {}),
  };
}

function htmlToText(html: string): string {
  const $ = cheerio.load(safeString(html).slice(0, MAX_PROCESS_BODY_CHARS));
  $("script, style, nav, footer, header, noscript, svg, iframe, canvas").remove();
  const title = normalizeText($("title").first().text());
  const root = selectReadableRoot($);
  root.find("br").replaceWith("\n");
  root.find("pre,code,li,p,div,section,article,tr").each((_, el) => { $(el).append("\n"); });
  const text = root.text().split("\n").map(line => normalizeText(line)).filter(Boolean).join("\n");
  return [title, text].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(safeString(html).slice(0, MAX_PROCESS_BODY_CHARS));
  $("script, style, nav, footer, header, noscript, svg, iframe, canvas").remove();
  $("br").replaceWith("\n");
  $("pre").each((_, el) => {
    const text = $(el).text().replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\n+$/g, "");
    $(el).replaceWith(`\n${fencedCodeBlock(text)}\n`);
  });
  $("code").each((_, el) => {
    const text = normalizeText($(el).text());
    if (text) $(el).replaceWith(`\`${text.replace(/`/g, "\\`")}\``);
  });
  $("table").each((_, el) => {
    const rows = $(el).find("tr").slice(0, MAX_TABLE_ROWS).map((_, row) =>
      $(row).find("th,td").slice(0, MAX_TABLE_CELLS).map((_, cell) => normalizeText($(cell).text())).get().join(" | ")
    ).get().filter(Boolean);
    if (rows.length) $(el).replaceWith(`\n${rows.join("\n")}\n`);
  });
  $("a[href]").each((_, el) => {
    const text = normalizeText($(el).text());
    const href = $(el).attr("href") || "";
    const safeHref = safeMarkdownHref(href);
    if (text && safeHref) $(el).replaceWith(`${text} (${safeHref})`);
  });
  $("h1,h2,h3,h4").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const level = tag === "h1" ? "# " : tag === "h2" ? "## " : tag === "h3" ? "### " : "#### ";
    $(el).replaceWith(`\n${level}${normalizeText($(el).text())}\n`);
  });
  $("li").each((_, el) => {
    $(el).replaceWith(`\n- ${normalizeText($(el).text())}`);
  });
  $("p,div,section,article").each((_, el) => {
    $(el).append("\n");
  });
  const title = normalizeText($("title").first().text());
  const body = selectReadableRoot($).text();
  const text = decodeHtml(body).split("\n").map(line => line.replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return [title ? `# ${title}` : "", text].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function fencedCodeBlock(text: string): string {
  const longestFence = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}\n${text}\n${fence}`;
}

function safeMarkdownHref(href: string): string | null {
  if (!href || href.length > MAX_MARKDOWN_LINK_URL_CHARS || CONTROL_TEXT_RE.test(href) || href.includes("\uFFFD")) return null;
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function selectReadableRoot($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  const candidates = $("article, main, [role='main'], .markdown-body, .doc, .docs, .documentation").toArray().slice(0, MAX_READABLE_ROOT_CANDIDATES);
  let best: Element | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const node = $(candidate);
    const textLength = normalizeText(node.text()).length;
    const linkLength = normalizeText(node.find("a").text()).length;
    const headingCount = node.find("h1,h2,h3").length;
    const codeCount = node.find("pre,code").length;
    const score = textLength - Math.floor(linkLength * 0.7) + headingCount * 120 + codeCount * 80;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (best) return $(best);
  const body = $("body").first();
  return body.length ? body : $.root();
}

function formatStructuredText(body: string, contentType: string): string {
  const safeBody = safeString(body);
  const trimmed = safeBody.trim();
  if (!trimmed) return safeBody.replace(CONTROL_TEXT_GLOBAL_RE, " ");
  const normalizedContentType = safeString(contentType).toLowerCase();
  if (normalizedContentType.includes("json") || /^[\[{]/.test(trimmed)) {
    if (trimmed.length > MAX_STRUCTURED_TEXT_CHARS) return safeBody.replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, MAX_STRUCTURED_TEXT_CHARS);
    try {
      return safeJsonStringify(JSON.parse(trimmed), { space: 2 }).slice(0, MAX_STRUCTURED_TEXT_CHARS);
    } catch {
      return safeBody.replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, MAX_STRUCTURED_TEXT_CHARS);
    }
  }
  return safeBody.replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, MAX_STRUCTURED_TEXT_CHARS);
}

function countWords(text: string): number {
  let count = 0;
  for (const _match of text.matchAll(/\S+/g)) count++;
  return count;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
