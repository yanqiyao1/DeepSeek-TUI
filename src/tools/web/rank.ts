import type { SearchEntry } from "./types.js";
import { isIP } from "node:net";
import { safeSliceTextBoundary } from "../../utils/text-boundary.js";

const TRACKING_QUERY_PREFIXES = ["utm_"];
const MAX_CANONICAL_URL_CHARS = 8_192;
const MAX_SEARCH_TEXT_CHARS = 2_000;
const MAX_RANK_TERMS = 32;
const MAX_NORMALIZED_RESULTS = 1_000;
const MAX_SEARCH_RESULTS_SCANNED = 5_000;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F\uFFFD]/;
const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "spm",
]);

export function canonicalSearchUrl(url: string): string | null {
  try {
    const raw = typeof url === "string" ? url.trim() : "";
    if (!raw || raw.length > MAX_CANONICAL_URL_CHARS || CONTROL_TEXT_RE.test(raw)) return null;
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname || hostname.length > 253 || isRestrictedHostname(hostname)) return null;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      const normalizedKey = key.toLowerCase();
      if (TRACKING_QUERY_KEYS.has(normalizedKey) || TRACKING_QUERY_PREFIXES.some(prefix => normalizedKey.startsWith(prefix))) {
        parsed.searchParams.delete(key);
      }
    }
    if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) parsed.port = "";
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.hostname = hostname;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function dedupeSearchResults(results: SearchEntry[], maxResults: number): SearchEntry[] {
  const cap = normalizeMaxResults(maxResults);
  if (cap <= 0 || !Array.isArray(results)) return [];
  const seen = new Set<string>();
  const deduped: SearchEntry[] = [];
  let scanned = 0;
  for (const result of results) {
    if (scanned++ >= MAX_SEARCH_RESULTS_SCANNED) break;
    if (!result || typeof result !== "object") continue;
    const normalized = normalizeSearchEntry(result);
    const canonical = canonicalSearchUrl(normalized.url);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push({ ...normalized, url: canonical });
    if (deduped.length >= cap) break;
  }
  return deduped;
}

export function rankSearchResults(query: string, results: SearchEntry[], maxResults: number): SearchEntry[] {
  const cap = normalizeMaxResults(maxResults);
  if (cap <= 0 || !Array.isArray(results)) return [];
  const terms = [...new Set(safeSearchText(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2))].slice(0, MAX_RANK_TERMS);
  const normalizedResults: SearchEntry[] = [];
  let scanned = 0;
  for (const result of results) {
    if (scanned++ >= MAX_SEARCH_RESULTS_SCANNED) break;
    if (normalizedResults.length >= MAX_NORMALIZED_RESULTS) break;
    if (!result || typeof result !== "object") continue;
    const normalized = normalizeSearchEntry(result);
    const canonical = canonicalSearchUrl(normalized.url);
    if (!canonical) continue;
    normalizedResults.push({ ...normalized, url: canonical });
  }
  return normalizedResults
    .map((result, index) => ({ result, score: scoreSearchResult(result, terms, index) }))
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title) || a.result.url.localeCompare(b.result.url))
    .slice(0, cap)
    .map(item => item.result);
}

function scoreSearchResult(result: SearchEntry, terms: string[], index: number): number {
  const title = safeSearchText(result.title).toLowerCase();
  const snippet = safeSearchText(result.snippet || "").toLowerCase();
  let score = Math.max(0, 100 - index);
  for (const term of terms) {
    if (title.includes(term)) score += 15;
    if (snippet.includes(term)) score += 5;
  }
  try {
    const url = new URL(result.url);
    const host = url.hostname.toLowerCase();
    if (host.endsWith(".edu") || host.endsWith(".gov")) score += 8;
    if (/docs|developer|api|reference|guide/.test(url.pathname.toLowerCase())) score += 6;
    if (/github\.com|npmjs\.com|pypi\.org|developer\.mozilla\.org/.test(host)) score += 5;
    if (/\/(tag|category|search|login|signup)\b/i.test(url.pathname)) score -= 10;
  } catch {
    score -= 50;
  }
  if (!result.snippet) score -= 4;
  return score;
}

function normalizeMaxResults(maxResults: number): number {
  return Number.isSafeInteger(maxResults) && maxResults > 0 ? Math.min(maxResults, MAX_NORMALIZED_RESULTS) : 0;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isRestrictedHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (isIP(hostname) === 4) return isRestrictedIPv4(hostname);
  if (isIP(hostname) === 6) return isRestrictedIPv6(hostname);
  return false;
}

function safeSearchText(value: unknown): string {
  return typeof value === "string"
    ? safeSliceTextBoundary(value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim(), MAX_SEARCH_TEXT_CHARS)
    : "";
}

function safeUrlText(value: unknown): string {
  return typeof value === "string" && value.length <= MAX_CANONICAL_URL_CHARS && !CONTROL_TEXT_RE.test(value)
    ? value.trim()
    : "";
}

function isRestrictedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(part => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function isRestrictedIPv6(ip: string): boolean {
  const expanded = expandIPv6Address(ip);
  if (!expanded) return true;
  const first = expanded[0];
  const sixth = expanded[6];
  const seventh = expanded[7];
  if (first === undefined || sixth === undefined || seventh === undefined) return true;
  if (expanded.every(part => part === 0)) return true;
  if (expanded.slice(0, 7).every(part => part === 0) && expanded[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (expanded.slice(0, 6).every(part => part === 0) || expanded.slice(0, 5).every(part => part === 0) && expanded[5] === 0xffff) {
    const v4 = [
      (sixth >> 8) & 255,
      sixth & 255,
      (seventh >> 8) & 255,
      seventh & 255,
    ].join(".");
    return isRestrictedIPv4(v4);
  }
  return false;
}

function expandIPv6Address(value: string): number[] | null {
  const ip = value.replace(/^\[/, "").replace(/\]$/, "").replace(/%.*$/, "").toLowerCase();
  if (!ip || ip.split("::").length > 2) return null;
  const parsePart = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    const parsed = Number.parseInt(part, 16);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : null;
  };
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const chunks = side.split(":");
    const parsed: number[] = [];
    for (const chunk of chunks) {
      if (chunk.includes(".")) {
        const octets = chunk.split(".").map(part => Number.parseInt(part, 10));
        if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
        const [a, b, c, d] = octets as [number, number, number, number];
        parsed.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      const part = parsePart(chunk);
      if (part === null) return null;
      parsed.push(part);
    }
    return parsed;
  };
  const [leftRaw, rightRaw] = ip.split("::");
  const left = parseSide(leftRaw ?? "");
  const right = rightRaw === undefined ? [] : parseSide(rightRaw);
  if (!left || !right) return null;
  if (rightRaw === undefined) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function normalizeSearchEntry(result: SearchEntry): SearchEntry {
  const url = safeUrlText(safeProperty(result, "url"));
  const title = safeSearchText(safeProperty(result, "title")) || url;
  const snippet = safeSearchText(safeProperty(result, "snippet"));
  const content = safeSearchText(safeProperty(result, "content"));
  const contentError = safeSearchText(safeProperty(result, "content_error"));
  const refId = safeRefId(safeProperty(result, "ref_id"));
  const profile = normalizeContentProfile(safeProperty(result, "content_profile"));
  return {
    title,
    url,
    ...(refId ? { ref_id: refId } : {}),
    ...(profile ? { content_profile: profile } : {}),
    ...(snippet ? { snippet } : {}),
    ...(content ? { content } : {}),
    ...(contentError ? { content_error: contentError } : {}),
  };
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeRefId(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : "";
}

function normalizeContentProfile(value: unknown): SearchEntry["content_profile"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const format = safeProperty(value, "format");
  if (format !== "html" && format !== "json" && format !== "xml" && format !== "text" && format !== "binary") return undefined;
  const characterCount = safeNonNegativeInt(safeProperty(value, "character_count"));
  const wordCount = safeNonNegativeInt(safeProperty(value, "word_count"));
  const truncated = safeProperty(value, "truncated") === true;
  const title = safeSearchText(safeProperty(value, "title"));
  const ratio = safeRatio(safeProperty(value, "main_content_ratio"));
  return {
    ...(title ? { title } : {}),
    format,
    character_count: characterCount,
    word_count: wordCount,
    truncated,
    ...(ratio !== undefined ? { main_content_ratio: ratio } : {}),
  };
}

function safeNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0;
}

function safeRatio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? Number(value.toFixed(3))
    : undefined;
}
