/** Web search and fetch tools. */

import * as cheerio from "cheerio";
import { createHash } from "node:crypto";
import { lookup as callbackLookup } from "node:dns";
import { isIP } from "node:net";
import { Buffer } from "node:buffer";
import { Agent, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from "undici";
import type { Element } from "domhandler";
import type { WebConfig } from "../config.js";
import { PermissionLevel } from "./base.js";
import type { ToolExecutionContext } from "./base.js";
import { getRegistry } from "./registry.js";
import { contentProfile, normalizeText, processBody } from "./web/extract.js";
import { dedupeSearchResults, rankSearchResults } from "./web/rank.js";
import { engineCircuitOpen, recordEngineHealth, recordEngineTelemetry, webStatsSnapshot, withHostConcurrency, WEB_STATS } from "./web/stats.js";
import type { CacheEntry, ContentProfile, FetchResponse, ResolvedWebConfig, SearchEngine, SearchEngineTelemetry, SearchEntry, SearchOutcome, SearchType, WebRef } from "./web/types.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify, stableJsonStringify } from "../utils/json-safe.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_BYTES = 10 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (compatible; seek-code/0.1; +https://github.com/seek-code/seek-code)";
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const SEARCH_CACHE_MAX = 64;
const FETCH_CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_CACHE_MAX = 64;
const DEFAULT_CONTEXT_MAX_CHARACTERS = 10_000;
const MAX_CONTEXT_MAX_CHARACTERS = 50_000;
const DEFAULT_CONTEXT_RESULTS = 3;
const MAX_CONTEXT_RESULTS = 5;
const SEARCH_FETCH_MAX_BYTES = 512_000;
const MAX_SEARCH_TITLE_CHARS = 180;
const MAX_SEARCH_SNIPPET_CHARS = 800;
const MAX_SEARCH_QUERY_CHARS = 1_000;
const MAX_SEARCH_QUERY_ITEMS = 8;
const MAX_REF_ID_CHARS = 64;
const MAX_URL_CHARS = 8_192;
const MAX_REDIRECT_PARAM_CHARS = 16_384;
const MAX_ERROR_MESSAGE_CHARS = 500;
const MAX_CONTENT_TYPE_CHARS = 200;
const MAX_API_KEY_CHARS = 4_096;
const MAX_PUBMED_ID_CHARS = 32;
const MAX_HEADER_CACHE_ENTRIES = 32;
const MAX_HEADER_NAME_CHARS = 128;
const MAX_HEADER_VALUE_CHARS = 4_096;
const SECRET_FINGERPRINT_CHARS = 12;
const MAX_API_RESULT_ITEMS = 50;
const MAX_TOOL_ARG_ARRAY_ITEMS = 64;
const WEB_TOOL_ARG_KEYS = [
  "query",
  "q",
  "search_query",
  "max_results",
  "timeout_ms",
  "timeoutMs",
  "domains",
  "engine",
  "source",
  "type",
  "search_type",
  "searchType",
  "fetch_results",
  "include_content",
  "context",
  "context_results",
  "contextResults",
  "context_max_characters",
  "contextMaxCharacters",
  "json",
  "url",
  "ref_id",
  "refId",
  "format",
  "extract_text",
  "max_bytes",
] as const;
const UNSUPPORTED_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const UNSUPPORTED_CONTROL_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const BING_SEARCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": "\"Microsoft Edge\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": "\"macOS\"",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const SERPER_SEARCH_URL = "https://google.serper.dev/search";
const GOOGLE_CUSTOM_SEARCH_URL = "https://www.googleapis.com/customsearch/v1";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const KAGI_SEARCH_URL = "https://kagi.com/api/v0/search";
const ARXIV_SEARCH_URL = "https://export.arxiv.org/api/query";
const BAIDU_SEARCH_URL = "https://www.baidu.com/s";
const SEMANTIC_SCHOLAR_SEARCH_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const PUBMED_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";

const WEB_REFS = new Map<string, WebRef>();
const SEARCH_CACHE = new Map<string, CacheEntry<SearchOutcome>>();
const FETCH_CACHE = new Map<string, CacheEntry<FetchResponse>>();
const PROXY_DISPATCHERS = new Map<string, Dispatcher>();
const SAFE_DISPATCHER = new Agent({
  connect: {
    lookup: safeLookup,
  } as any,
});
let ENV_DISPATCHER: Dispatcher | null | undefined;
let refSeq = 0;

function asPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = parseIntegerLike(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function parseIntegerLike(value: unknown): number {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return NaN;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : NaN;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeSearchEngine(value: unknown): SearchEngine {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase().replace(/[-_\s]/g, "");
  if (normalized === "bing") return "bing";
  if (normalized === "duckduckgo" || normalized === "ddg") return "duckduckgo";
  if (normalized === "brave" || normalized === "bravesearch") return "brave";
  if (normalized === "tavily") return "tavily";
  if (normalized === "serper" || normalized === "googleserper") return "serper";
  if (normalized === "google" || normalized === "googlecustomsearch" || normalized === "googlecse") return "google";
  if (normalized === "arxiv") return "arxiv";
  if (normalized === "baidu") return "baidu";
  if (normalized === "exa" || normalized === "exasearch") return "exa";
  if (normalized === "kagi") return "kagi";
  if (normalized === "semanticscholar" || normalized === "semanticsscholar" || normalized === "s2") return "semantic_scholar";
  if (normalized === "pubmed" || normalized === "ncbi") return "pubmed";
  if (normalized === "searxng" || normalized === "searx") return "searxng";
  return "auto";
}

function normalizeSearchType(value: unknown): SearchType {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "fast" || normalized === "quick") return "fast";
  if (normalized === "deep" || normalized === "comprehensive") return "deep";
  return "auto";
}

function normalizeFetchFormat(args: Record<string, unknown>): "markdown" | "text" | "raw" {
  const raw = typeof args.format === "string"
    ? args.format
    : args.extract_text === false
      ? "raw"
      : "markdown";
  const normalized = raw.trim().toLowerCase();
  if (["raw", "html", "bytes"].includes(normalized)) return "raw";
  if (["text", "txt", "plain"].includes(normalized)) return "text";
  return "markdown";
}

function normalizeDomainPattern(value: string, options: { allowWildcard?: boolean; allowRestricted?: boolean } = {}): string | null {
  let raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (options.allowWildcard && raw === "*") return "*";

  let suffixPattern = false;
  if (raw.startsWith("*.")) {
    suffixPattern = true;
    raw = raw.slice(2);
  } else if (raw.startsWith(".")) {
    suffixPattern = true;
    raw = raw.slice(1);
  }
  if (!raw || raw.includes("*") || /\s/.test(raw)) return null;

  let host = raw;
  try {
    const parsed = raw.includes("://") ? new URL(raw) : new URL(`http://${raw}`);
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    host = parsed.hostname;
  } catch {
    return null;
  }

  host = hostWithoutBrackets(host);
  if (!host || host.includes("*") || host.includes("/") || host.includes("@")) return null;
  const ipVersion = isIP(host);
  if (suffixPattern && ipVersion) return null;
  if (!options.allowRestricted && isRestrictedHost(host)) return null;
  if (ipVersion) return host;
  if (host.length > 253) return null;
  const labels = host.split(".");
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return suffixPattern ? `.${host}` : host;
}

function normalizeDomainList(value: unknown, options: { allowWildcard?: boolean; allowRestricted?: boolean } = {}): string[] {
  const rawItems = isArrayValue(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = new Set<string>();
  for (const item of rawItems) {
    const domain = normalizeDomainPattern(item, options);
    if (domain) normalized.add(domain);
  }
  return [...normalized];
}

function hasInvalidDomainPattern(value: unknown, options: { allowWildcard?: boolean; allowRestricted?: boolean } = {}): boolean {
  if (isArrayValue(value)) return value.some(item => typeof item !== "string" || !normalizeDomainPattern(item, options));
  if (typeof value === "string") return value.split(",").some(item => !normalizeDomainPattern(item, options));
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return isArrayValue(value) && value.every(item => typeof item === "string");
}

function isNumericLike(value: unknown): value is number | string {
  return Number.isFinite(parseIntegerLike(value));
}

function isBoolLike(value: unknown): value is boolean | string {
  if (typeof value === "boolean") return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function hasUnsupportedControl(value: string): boolean {
  return UNSUPPORTED_CONTROL_RE.test(value);
}

function displayText(value: unknown, maxChars = MAX_ERROR_MESSAGE_CHARS): string {
  try {
    return String(value)
      .replace(UNSUPPORTED_CONTROL_GLOBAL_RE, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
  } catch {
    return "";
  }
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeOwnEntries(value: unknown, maxEntries = Number.POSITIVE_INFINITY): Array<[string, unknown]> {
  if (!value || typeof value !== "object") return [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys.slice(0, maxEntries)) {
    entries.push([key, safeProperty(value, key)]);
  }
  return entries;
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  try {
    if (!Array.isArray(value)) return [];
  } catch {
    return [];
  }
  const items: unknown[] = [];
  let count = 0;
  try {
    count = Math.min(value.length, maxItems);
  } catch {
    return [];
  }
  for (let index = 0; index < count; index++) {
    items.push(safeProperty(value, String(index)));
  }
  return items;
}

function snapshotToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const source = args && typeof args === "object" ? args : {};
  const snapshot: Record<string, unknown> = {};
  for (const key of WEB_TOOL_ARG_KEYS) {
    const value = safeProperty(source, key);
    if (value === undefined) continue;
    const maxArrayItems = key === "search_query" ? MAX_SEARCH_QUERY_ITEMS + 1 : MAX_TOOL_ARG_ARRAY_ITEMS;
    snapshot[key] = isArrayValue(value)
      ? safeArrayItems(value, maxArrayItems).map(item => item && typeof item === "object" ? snapshotToolArgItem(item) : item)
      : value;
  }
  return snapshot;
}

function snapshotToolArgItem(item: unknown): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  if (!item || typeof item !== "object") return snapshot;
  for (const key of WEB_TOOL_ARG_KEYS) {
    if (key === "search_query") continue;
    const value = safeProperty(item, key);
    if (value === undefined) continue;
    snapshot[key] = isArrayValue(value) ? safeArrayItems(value, MAX_TOOL_ARG_ARRAY_ITEMS) : value;
  }
  return snapshot;
}

function normalizeBoundedInputText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars || hasUnsupportedControl(normalized)) return "";
  return normalized;
}

function validateBoundedString(
  value: unknown,
  label: string,
  maxChars: number,
): string | null {
  if (value !== undefined && typeof value !== "string") return `${label} must be a string`;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxChars) return `${label} must be ${maxChars} characters or fewer`;
  if (hasUnsupportedControl(trimmed)) return `${label} contains unsupported control characters`;
  return null;
}

function validatePositiveIntegerLike(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (!isNumericLike(value)) return `${label} must be a number`;
  const parsed = parseIntegerLike(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return `${label} must be a positive integer`;
  return null;
}

function validateEngineLike(value: unknown, label: string): string | null {
  const stringError = validateBoundedString(value, label, 64);
  if (stringError) return stringError;
  if (value === undefined) return null;
  const normalized = normalizeSearchEngine(value);
  if (normalized === "auto" && typeof value === "string" && value.trim().toLowerCase() !== "auto") {
    return `${label} must be a supported search engine`;
  }
  return null;
}

function validateSearchTypeLike(value: unknown, label: string): string | null {
  const stringError = validateBoundedString(value, label, 64);
  if (stringError) return stringError;
  if (value === undefined) return null;
  const normalized = normalizeSearchType(value);
  if (normalized === "auto" && typeof value === "string" && value.trim().toLowerCase() !== "auto") {
    return `${label} must be auto, fast, or deep`;
  }
  return null;
}

function envString(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  return safeSecretText(value);
}

function firstNonEmpty(...values: string[]): string {
  return values.find(value => value.length > 0) ?? "";
}

function configSecret(value: unknown): string {
  return typeof value === "string" ? safeSecretText(value) : "";
}

function safeSecretText(value: string): string {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_API_KEY_CHARS && !hasUnsupportedControl(trimmed) ? trimmed : "";
}

function resolveWebConfig(config?: Partial<WebConfig>): ResolvedWebConfig {
  const googleApiKey = configSecret(safeProperty(config, "google_api_key"));
  const googleCx = configSecret(safeProperty(config, "google_cx"));
  const exaApiKey = configSecret(safeProperty(config, "exa_api_key"));
  const kagiApiKey = configSecret(safeProperty(config, "kagi_api_key"));
  const braveApiKey = configSecret(safeProperty(config, "brave_api_key"));
  const tavilyApiKey = configSecret(safeProperty(config, "tavily_api_key"));
  const serperApiKey = configSecret(safeProperty(config, "serper_api_key"));
  const semanticScholarApiKey = configSecret(safeProperty(config, "semantic_scholar_api_key"));
  const pubmedApiKey = configSecret(safeProperty(config, "pubmed_api_key"));
  const searxngUrl = safeProperty(config, "searxng_url");
  const proxy = safeProperty(config, "proxy");
  return {
    enabled: safeProperty(config, "enabled") !== false,
    mode: safeProperty(config, "mode") === "off" ? "off" : "live",
    searchEngine: normalizeSearchEngine(safeProperty(config, "search_engine")),
    allowedDomains: normalizeDomainList(safeProperty(config, "allowed_domains")),
    blockedDomains: normalizeDomainList(safeProperty(config, "blocked_domains")),
    googleApiKey: googleApiKey
      ? googleApiKey
      : envString("GOOGLE_API_KEY"),
    googleCx: googleCx
      ? googleCx
      : firstNonEmpty(envString("GOOGLE_CSE_ID"), envString("GOOGLE_CX")),
    exaApiKey: exaApiKey
      ? exaApiKey
      : envString("EXA_API_KEY"),
    kagiApiKey: kagiApiKey
      ? kagiApiKey
      : envString("KAGI_API_KEY"),
    braveApiKey: braveApiKey
      ? braveApiKey
      : firstNonEmpty(envString("BRAVE_SEARCH_API_KEY"), envString("BRAVE_API_KEY")),
    tavilyApiKey: tavilyApiKey
      ? tavilyApiKey
      : envString("TAVILY_API_KEY"),
    serperApiKey: serperApiKey
      ? serperApiKey
      : envString("SERPER_API_KEY"),
    semanticScholarApiKey: semanticScholarApiKey
      ? semanticScholarApiKey
      : firstNonEmpty(envString("SEMANTIC_SCHOLAR_API_KEY"), envString("S2_API_KEY")),
    pubmedApiKey: pubmedApiKey
      ? pubmedApiKey
      : firstNonEmpty(envString("PUBMED_API_KEY"), envString("NCBI_API_KEY")),
    searxngUrl: typeof searxngUrl === "string" && searxngUrl.trim()
      ? normalizeBaseUrl(searxngUrl)
      : normalizeBaseUrl(envString("SEARXNG_URL")),
    proxy: typeof proxy === "string" ? normalizeProxyUrl(proxy) : "",
    noProxy: normalizeDomainList(safeProperty(config, "no_proxy"), { allowWildcard: true, allowRestricted: true }),
    searchTimeoutMs: asPositiveInt(safeProperty(config, "search_timeout_ms"), DEFAULT_SEARCH_TIMEOUT_MS, MAX_TIMEOUT_MS),
    fetchTimeoutMs: asPositiveInt(safeProperty(config, "fetch_timeout_ms"), DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxBytes: asPositiveInt(safeProperty(config, "max_bytes"), DEFAULT_MAX_BYTES, MAX_BYTES),
  };
}

function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  if (!raw || hasUnsupportedControl(raw) || raw.length > MAX_URL_CHARS) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.username || parsed.password) return "";
    if (isRestrictedHost(parsed.hostname)) return "";
    normalizeParsedHostname(parsed);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function normalizeProxyUrl(value: string): string {
  const raw = value.trim();
  if (!raw || hasUnsupportedControl(raw) || raw.length > MAX_URL_CHARS) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.username || parsed.password) return "";
    if (isRestrictedHost(parsed.hostname)) return "";
    normalizeParsedHostname(parsed);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function extractSearchQuery(args: Record<string, unknown>): string {
  for (const key of ["query", "q"]) {
    const value = args[key];
    const normalized = normalizeBoundedInputText(value, MAX_SEARCH_QUERY_CHARS);
    if (normalized) return normalized;
  }

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery.slice(0, MAX_SEARCH_QUERY_ITEMS)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      for (const key of ["q", "query"]) {
        const normalized = normalizeBoundedInputText(record[key], MAX_SEARCH_QUERY_CHARS);
        if (normalized) return normalized;
      }
    }
  }

  return "";
}

function extractSearchMaxResults(args: Record<string, unknown>): number {
  const direct = asPositiveInt(args.max_results, 0, MAX_RESULTS);
  if (direct > 0) return direct;

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery.slice(0, MAX_SEARCH_QUERY_ITEMS)) {
      if (!item || typeof item !== "object") continue;
      const nested = asPositiveInt((item as Record<string, unknown>).max_results, 0, MAX_RESULTS);
      if (nested > 0) return nested;
    }
  }

  return DEFAULT_MAX_RESULTS;
}

function extractSearchDomains(args: Record<string, unknown>): string[] {
  const direct = normalizeDomainList(args.domains);
  if (direct.length) return direct;

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery.slice(0, MAX_SEARCH_QUERY_ITEMS)) {
      if (!item || typeof item !== "object") continue;
      const nested = normalizeDomainList((item as Record<string, unknown>).domains);
      if (nested.length) return nested;
    }
  }

  return [];
}

function nestedSearchValue(args: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (args[key] !== undefined) return args[key];
  }
  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery.slice(0, MAX_SEARCH_QUERY_ITEMS)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      for (const key of keys) {
        if (record[key] !== undefined) return record[key];
      }
    }
  }
  return undefined;
}

function extractSearchContextEnabled(args: Record<string, unknown>, searchType: SearchType): boolean {
  const direct = args.fetch_results ?? args.include_content ?? args.context;
  if (direct !== undefined) return asBool(direct, false);

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery.slice(0, MAX_SEARCH_QUERY_ITEMS)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const nested = record.fetch_results ?? record.include_content ?? record.context;
      if (nested !== undefined) return asBool(nested, false);
    }
  }

  return searchType === "deep";
}

function extractContextMaxCharacters(args: Record<string, unknown>): number {
  const direct = asPositiveInt(args.context_max_characters ?? args.contextMaxCharacters, 0, MAX_CONTEXT_MAX_CHARACTERS);
  if (direct > 0) return direct;

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery.slice(0, MAX_SEARCH_QUERY_ITEMS)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const nested = asPositiveInt(record.context_max_characters ?? record.contextMaxCharacters, 0, MAX_CONTEXT_MAX_CHARACTERS);
      if (nested > 0) return nested;
    }
  }

  return DEFAULT_CONTEXT_MAX_CHARACTERS;
}

function extractContextResults(args: Record<string, unknown>): number {
  const direct = asPositiveInt(args.context_results ?? args.contextResults, 0, MAX_CONTEXT_RESULTS);
  if (direct > 0) return direct;

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery.slice(0, MAX_SEARCH_QUERY_ITEMS)) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const nested = asPositiveInt(record.context_results ?? record.contextResults, 0, MAX_CONTEXT_RESULTS);
      if (nested > 0) return nested;
    }
  }

  return DEFAULT_CONTEXT_RESULTS;
}

function extractRefId(args: Record<string, unknown>): string {
  for (const key of ["ref_id", "refId"]) {
    const value = args[key];
    const normalized = normalizeBoundedInputText(value, MAX_REF_ID_CHARS);
    if (normalized) return normalized;
  }
  return "";
}

function normalizeWebSearchValidationArgs(args: Record<string, unknown>): Record<string, unknown> {
  const query = extractSearchQuery(args);
  const maxResults = extractSearchMaxResults(args);
  const domains = extractSearchDomains(args);
  const engine = normalizeSearchEngine(args.engine ?? args.source);
  const searchType = normalizeSearchType(args.type ?? args.search_type ?? args.searchType);
  const includeContent = extractSearchContextEnabled(args, searchType);
  const contextResults = extractContextResults(args);
  const contextMaxCharacters = extractContextMaxCharacters(args);

  return {
    ...args,
    ...(query ? { query } : {}),
    ...(maxResults > 0 ? { max_results: maxResults } : {}),
    ...(domains.length ? { domains } : {}),
    ...(engine ? { engine } : {}),
    ...(searchType ? { type: searchType } : {}),
    fetch_results: includeContent,
    context_results: contextResults,
    context_max_characters: contextMaxCharacters,
  };
}

function validateWebSearchDomainArgs(args: Record<string, unknown>): string | null {
  if (args.domains !== undefined && !isStringArray(args.domains)) {
    return "domains must be an array of strings";
  }
  if (args.domains !== undefined && hasInvalidDomainPattern(args.domains)) {
    return "domains entries must be valid public domain names";
  }
  const searchQuery = args.search_query;
  if (searchQuery !== undefined) {
    if (!Array.isArray(searchQuery)) return "search_query must be an array";
    for (const item of searchQuery) {
      if (!item || typeof item !== "object") return "search_query entries must be objects";
      const record = item as Record<string, unknown>;
      if (record.domains !== undefined && !isStringArray(record.domains)) {
        return "search_query domains must be an array of strings";
      }
      if (record.domains !== undefined && hasInvalidDomainPattern(record.domains)) {
        return "search_query domains entries must be valid public domain names";
      }
    }
  }
  return null;
}

function validateWebSearchQueryArgs(args: Record<string, unknown>): string | null {
  for (const key of ["query", "q"] as const) {
    const error = validateBoundedString(args[key], key, MAX_SEARCH_QUERY_CHARS);
    if (error) return error;
  }

  const searchQuery = args.search_query;
  if (searchQuery === undefined) return null;
  if (!Array.isArray(searchQuery)) return "search_query must be an array";
  if (searchQuery.length > MAX_SEARCH_QUERY_ITEMS) return `search_query must contain ${MAX_SEARCH_QUERY_ITEMS} entries or fewer`;
  for (const item of searchQuery) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    for (const key of ["q", "query"] as const) {
      const error = validateBoundedString(record[key], `search_query ${key}`, MAX_SEARCH_QUERY_CHARS);
      if (error) return error;
    }
  }
  return null;
}

function validateWebSearchOptionArgs(args: Record<string, unknown>): string | null {
  for (const key of ["max_results", "timeout_ms", "timeoutMs", "context_results", "context_max_characters", "contextMaxCharacters", "contextResults"]) {
    const error = validatePositiveIntegerLike(args[key], key);
    if (error) return error;
  }
  for (const key of ["fetch_results", "include_content", "context", "json"]) {
    const value = args[key];
    if (value !== undefined && !isBoolLike(value)) return `${key} must be a boolean`;
  }
  for (const key of ["engine", "source"]) {
    const error = validateEngineLike(args[key], key);
    if (error) return error;
  }
  for (const key of ["type", "search_type", "searchType"]) {
    const error = validateSearchTypeLike(args[key], key);
    if (error) return error;
  }

  const searchQuery = args.search_query;
  if (!Array.isArray(searchQuery)) return null;
  for (const item of searchQuery) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    for (const key of ["max_results", "timeout_ms", "timeoutMs", "context_results", "context_max_characters", "contextMaxCharacters", "contextResults"]) {
      const error = validatePositiveIntegerLike(record[key], `search_query ${key}`);
      if (error) return error;
    }
    for (const key of ["fetch_results", "include_content", "context"]) {
      const value = record[key];
      if (value !== undefined && !isBoolLike(value)) return `search_query ${key} must be a boolean`;
    }
  }
  return null;
}

function validateWebSearchInput(args: Record<string, unknown>) {
  args = snapshotToolArgs(args);
  const queryError = validateWebSearchQueryArgs(args);
  if (queryError) return { ok: false as const, message: queryError };
  const domainError = validateWebSearchDomainArgs(args);
  if (domainError) return { ok: false as const, message: domainError };
  const optionError = validateWebSearchOptionArgs(args);
  if (optionError) return { ok: false as const, message: optionError };
  const normalized = normalizeWebSearchValidationArgs(args);
  return extractSearchQuery(normalized)
    ? { ok: true as const, args: normalized }
    : { ok: false as const, message: "query is required" };
}

function validateWebFetchOptionArgs(args: Record<string, unknown>): string | null {
  for (const key of ["max_bytes", "timeout_ms"]) {
    const error = validatePositiveIntegerLike(args[key], key);
    if (error) return error;
  }
  for (const key of ["json", "extract_text"]) {
    const value = args[key];
    if (value !== undefined && !isBoolLike(value)) return `${key} must be a boolean`;
  }
  const formatError = validateBoundedString(args.format, "format", 64);
  if (formatError) return formatError;
  if (typeof args.format === "string") {
    const normalized = args.format.trim().toLowerCase();
    if (normalized && !["markdown", "md", "text", "txt", "plain", "raw", "html", "bytes"].includes(normalized)) {
      return "format must be markdown, text, or raw";
    }
  }
  return null;
}

function validateWebFetchInput(args: Record<string, unknown>) {
  args = snapshotToolArgs(args);
  const optionError = validateWebFetchOptionArgs(args);
  if (optionError) return { ok: false as const, message: optionError };
  const urlError = validateBoundedString(args.url, "url", MAX_URL_CHARS);
  if (urlError) return { ok: false as const, message: urlError };
  for (const key of ["ref_id", "refId"] as const) {
    const refError = validateBoundedString(args[key], key, MAX_REF_ID_CHARS);
    if (refError) return { ok: false as const, message: refError };
  }
  const url = typeof args.url === "string" ? args.url.trim() : "";
  const refId = extractRefId(args);
  if (!url && !refId) return { ok: false as const, message: "url or ref_id is required" };
  return {
    ok: true as const,
    args: {
      ...args,
      ...(url ? { url } : {}),
      ...(refId ? { ref_id: refId } : {}),
    },
  };
}

function cloneSearchResults(results: SearchEntry[]): SearchEntry[] {
  return isArrayValue(results) ? results.map(result => cloneSearchEntry(result)) : [];
}

function cloneSearchOutcome(outcome: SearchOutcome): SearchOutcome {
  const failures = safeArrayItems(safeProperty(outcome, "failures"), MAX_API_RESULT_ITEMS)
    .filter((item): item is string => typeof item === "string")
    .map(item => displayText(item));
  const telemetry = safeArrayItems(safeProperty(outcome, "telemetry"), MAX_API_RESULT_ITEMS)
    .flatMap(item => normalizeTelemetry(item));
  return omitUndefined({
    source: displayText(safeProperty(outcome, "source"), MAX_SEARCH_TITLE_CHARS),
    results: cloneSearchResults(safeProperty(outcome, "results") as SearchEntry[]),
    failures,
    telemetry: telemetry.length ? telemetry : undefined,
    cacheHit: safeProperty(outcome, "cacheHit") === true,
  });
}

function cloneFetchResponse(resp: FetchResponse): FetchResponse {
  const status = safeProperty(resp, "status");
  const url = safeProperty(resp, "url");
  const text = safeProperty(resp, "text");
  return {
    status: Number.isSafeInteger(status) ? status as number : 0,
    url: typeof url === "string" ? url : "",
    contentType: displayText(safeProperty(resp, "contentType") ?? "application/octet-stream", MAX_CONTENT_TYPE_CHARS) || "application/octet-stream",
    text: typeof text === "string" ? text : "",
    truncated: safeProperty(resp, "truncated") === true,
  };
}

function cloneSearchEntry(result: SearchEntry): SearchEntry {
  const urlValue = safeProperty(result, "url");
  const titleValue = safeProperty(result, "title");
  const url = typeof urlValue === "string" ? urlValue : "";
  const title = typeof titleValue === "string" ? compactTitle(titleValue) : "";
  const snippet = compactSnippet(safeProperty(result, "snippet"));
  const contentValue = safeProperty(result, "content");
  const content = typeof contentValue === "string" ? trimForContext(contentValue, DEFAULT_CONTEXT_MAX_CHARACTERS) : undefined;
  const contentErrorValue = safeProperty(result, "content_error");
  const contentError = typeof contentErrorValue === "string" ? displayText(contentErrorValue) : undefined;
  const refId = safeRefId(safeProperty(result, "ref_id"));
  const profile = normalizeContentProfile(safeProperty(result, "content_profile"));
  return omitUndefined({
    title: title || url,
    url,
    ref_id: refId,
    snippet: snippet ? snippet.slice(0, MAX_SEARCH_SNIPPET_CHARS) : undefined,
    content,
    content_error: contentError,
    content_profile: profile,
  });
}

function safeRefId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(UNSUPPORTED_CONTROL_GLOBAL_RE, " ").trim();
  return /^web_[a-z0-9]{1,60}$/i.test(text) ? text : undefined;
}

function normalizeTelemetry(value: unknown): SearchEngineTelemetry[] {
  if (!value || typeof value !== "object") return [];
  const engine = displayText(safeProperty(value, "engine"), 64);
  const source = displayText(safeProperty(value, "source"), 64);
  if (!engine || !source) return [];
  const duration = safeNonNegativeInt(safeProperty(value, "duration_ms"), 24 * 60 * 60 * 1000);
  const count = safeNonNegativeInt(safeProperty(value, "result_count"), MAX_API_RESULT_ITEMS);
  return [omitUndefined({
    engine,
    source,
    ok: safeProperty(value, "ok") === true,
    duration_ms: duration,
    result_count: count,
    error: typeof safeProperty(value, "error") === "string" ? displayText(safeProperty(value, "error")) : undefined,
    cache_hit: safeProperty(value, "cache_hit") === true ? true : undefined,
  })];
}

function normalizeContentProfile(value: unknown): ContentProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    if (Array.isArray(value)) return undefined;
  } catch {
    return undefined;
  }
  const rawFormat = safeProperty(value, "format");
  if (rawFormat !== "html" && rawFormat !== "json" && rawFormat !== "xml" && rawFormat !== "text" && rawFormat !== "binary") return undefined;
  const format: ContentProfile["format"] = rawFormat;
  const titleValue = safeProperty(value, "title");
  const title = typeof titleValue === "string" ? compactTitle(titleValue) : "";
  const ratio = safeRatio(safeProperty(value, "main_content_ratio"));
  const profile: ContentProfile = {
    format,
    character_count: safeNonNegativeInt(safeProperty(value, "character_count"), MAX_BYTES),
    word_count: safeNonNegativeInt(safeProperty(value, "word_count"), MAX_BYTES),
    truncated: safeProperty(value, "truncated") === true,
  };
  if (title) profile.title = title;
  if (ratio !== undefined) profile.main_content_ratio = ratio;
  return profile;
}

function safeNonNegativeInt(value: unknown, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
}

function safeRatio(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? Number(value.toFixed(3))
    : undefined;
}

function compactSnippet(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized.length ? normalized : undefined;
  }
  if (isArrayValue(value)) {
    const normalized = safeArrayItems(value, MAX_API_RESULT_ITEMS)
      .map(item => typeof item === "string" ? normalizeText(item) : "")
      .filter(Boolean)
      .join(" ");
    return normalized.length ? normalized : undefined;
  }
  return undefined;
}

function isArrayValue(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function compactScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized.length ? normalized : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function compactTitle(value: string): string {
  return normalizeText(value).slice(0, MAX_SEARCH_TITLE_CHARS);
}

function makeSearchEntry(title: string, url: string, snippet?: string): SearchEntry {
  const entry: SearchEntry = { title: compactTitle(title) || url, url };
  const compactedSnippet = compactSnippet(snippet);
  if (compactedSnippet) entry.snippet = compactedSnippet.slice(0, MAX_SEARCH_SNIPPET_CHARS);
  return entry;
}

function recordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = safeProperty(record, key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function entryFromRecord(record: Record<string, unknown>, keys: { title: string[]; url: string[]; snippet: string[] }): SearchEntry | null {
  const rawUrl = recordValue(record, keys.url);
  if (typeof rawUrl !== "string") return null;
  const url = normalizeSearchEntryUrl(rawUrl);
  if (!url) return null;
  const title = compactSnippet(recordValue(record, keys.title)) ?? url;
  return makeSearchEntry(title, url, compactSnippet(recordValue(record, keys.snippet)));
}

function apiItems(value: unknown, maxItems = MAX_API_RESULT_ITEMS): unknown[] {
  return safeArrayItems(value, maxItems);
}

function apiObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !isArrayValue(value) ? value as Record<string, unknown> : undefined;
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  options: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; config: ResolvedWebConfig },
): Promise<unknown> {
  const resp = await fetchText(url, timeoutMs, "application/json,text/json,*/*;q=0.2", omitUndefined({
    signal: options.signal,
    maxBytes: Math.min(DEFAULT_MAX_BYTES, options.config.maxBytes),
    retries: 1,
    config: options.config,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    body: options.body,
  }));
  if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
  try {
    return JSON.parse(resp.text);
  } catch {
    throw new Error("invalid JSON response");
  }
}

function getTimedCache<T>(cache: Map<string, CacheEntry<T>>, key: string, ttlMs: number): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setTimedCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, maxSize: number): void {
  cache.set(key, { createdAt: Date.now(), value });
  while (cache.size > maxSize) {
    const first = cache.keys().next().value;
    if (!first) break;
    cache.delete(first);
  }
}

function searchCacheKey(
  query: string,
  maxResults: number,
  engine: SearchEngine,
  searchType: SearchType,
  config: ResolvedWebConfig,
): string {
  return stableJsonStringify({
    query,
    maxResults,
    engine,
    searchType,
    blockedDomains: [...config.blockedDomains].sort(),
    google: Boolean(config.googleApiKey && config.googleCx),
    googleKey: secretFingerprint(config.googleApiKey),
    googleCx: config.googleCx,
    exa: secretFingerprint(config.exaApiKey),
    kagi: secretFingerprint(config.kagiApiKey),
    brave: secretFingerprint(config.braveApiKey),
    tavily: secretFingerprint(config.tavilyApiKey),
    serper: secretFingerprint(config.serperApiKey),
    semanticScholar: secretFingerprint(config.semanticScholarApiKey),
    pubmed: secretFingerprint(config.pubmedApiKey),
    searxng: config.searxngUrl,
    proxy: config.proxy,
    noProxy: [...config.noProxy].sort(),
  });
}

function secretFingerprint(value: string): string {
  if (!value) return "";
  return createHash("sha256").update(value).digest("base64url").slice(0, SECRET_FINGERPRINT_CHARS);
}

function fetchCacheKey(
  url: string,
  accept: string,
  maxBytes: number,
  config?: ResolvedWebConfig,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
  format = "",
): string {
  return stableJsonStringify({
    url,
    accept,
    maxBytes,
    format,
    method,
    body: body === undefined ? undefined : body,
    headers: headerCacheKey(headers),
    allowedDomains: [...(config?.allowedDomains ?? [])].sort(),
    blockedDomains: [...(config?.blockedDomains ?? [])].sort(),
    proxy: config?.proxy ?? "",
    noProxy: [...(config?.noProxy ?? [])].sort(),
  });
}

function headerCacheKey(headers?: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of safeOwnEntries(headers ?? {}, MAX_HEADER_CACHE_ENTRIES)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || normalizedKey.length > MAX_HEADER_NAME_CHARS || hasUnsupportedControl(normalizedKey)) continue;
    const normalizedValue = displayText(value, MAX_HEADER_VALUE_CHARS + 1);
    if (normalizedValue.length > MAX_HEADER_VALUE_CHARS || hasUnsupportedControl(normalizedValue)) {
      normalized[normalizedKey] = "invalid";
      continue;
    }
    normalized[normalizedKey] = secretFingerprint(normalizedValue);
  }
  return normalized;
}

function normalizeFetchUrlForRequest(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  normalizeParsedHostname(parsed);
  parsed.hash = "";
  return parsed.toString();
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function queryParam(value: string, key: string): string | null {
  const marker = value.indexOf("?");
  if (marker < 0) return null;
  for (const part of value.slice(marker + 1, marker + 1 + MAX_REDIRECT_PARAM_CHARS).split("&")) {
    const [name, raw = ""] = part.split("=", 2);
    if (name === key) return raw;
  }
  return null;
}

function normalizeDuckUrl(href: string): string {
  if (href.length > MAX_URL_CHARS) return "";
  const uddg = queryParam(href, "uddg");
  if (uddg) {
    const decoded = percentDecode(uddg);
    if (decoded) return decoded;
  }
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://duckduckgo.com${href}`;
  return href;
}

function normalizeBingUrl(href: string): string {
  if (href.length > MAX_URL_CHARS) return "";
  const encoded = queryParam(href, "u");
  if (encoded) {
    const decoded = percentDecode(encoded);
    const token = decoded.startsWith("a1") || decoded.startsWith("a0") ? decoded.slice(2) : decoded;
    const padded = token.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
    try {
      const url = Buffer.from(padded, "base64").toString("utf-8");
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
    } catch {
      // keep original href
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://www.bing.com${href}`;
  return href;
}

function normalizeSearchResultUrl(href: string, baseUrl: string): string | null {
  const uddg = queryParam(href, "uddg");
  if (uddg) {
    const decoded = percentDecode(uddg);
    const normalized = normalizeSearchEntryUrl(decoded);
    if (normalized) return normalized;
  }
  const bingEncoded = queryParam(href, "u");
  if (bingEncoded) {
    const decoded = normalizeBingUrl(href);
    const normalized = normalizeSearchEntryUrl(decoded);
    if (normalized) return normalized;
  }
  try {
    const url = new URL(href, baseUrl).toString();
    return normalizeSearchEntryUrl(url);
  } catch {
    return null;
  }
}

function normalizeParsedHostname(parsed: URL): void {
  const host = hostWithoutBrackets(parsed.hostname);
  if (host && !isIP(host) && parsed.hostname !== host) parsed.hostname = host;
}

function normalizeSearchEntryUrl(rawUrl: string): string | null {
  if (!rawUrl || rawUrl.length > MAX_URL_CHARS || hasUnsupportedControl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (isRestrictedHost(parsed.hostname)) return null;
    normalizeParsedHostname(parsed);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseDuckResults(html: string, maxResults: number): SearchEntry[] {
  const $ = cheerio.load(html);
  const results: SearchEntry[] = [];
  $(".result").each((_, el) => {
    if (results.length >= maxResults) return false;
    const anchor = $(el).find("a.result__a").first();
    const title = normalizeText(anchor.html() || anchor.text());
    const href = anchor.attr("href") || "";
    const snippet = normalizeText($(el).find(".result__snippet").first().html() || $(el).find(".result__snippet").first().text());
    const url = normalizeSearchEntryUrl(normalizeDuckUrl(href));
    if (title && url && !isInternalSearchUrl(url)) results.push(makeSearchEntry(title, url, snippet));
    return undefined;
  });
  return results;
}

function extractBingSnippet($: cheerio.CheerioAPI, el: Element): string {
  const lineClamp = normalizeText($(el).find("p[class*='b_lineclamp']").first().html() || $(el).find("p[class*='b_lineclamp']").first().text());
  if (lineClamp) return lineClamp;
  const captionP = normalizeText($(el).find(".b_caption p").first().html() || $(el).find(".b_caption p").first().text());
  if (captionP) return captionP;
  return normalizeText($(el).find(".b_caption").first().html() || $(el).find(".b_caption").first().text());
}

function isInternalSearchUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = hostWithoutBrackets(parsed.hostname);
    return host === "www.bing.com" || host.endsWith(".bing.com") || host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
  } catch {
    return true;
  }
}

function parseBingResults(html: string, maxResults: number): SearchEntry[] {
  const $ = cheerio.load(html);
  const results: SearchEntry[] = [];
  $("li.b_algo").each((_, el) => {
    if (results.length >= maxResults) return false;
    const anchor = $(el).find("h2 a").first();
    const title = normalizeText(anchor.html() || anchor.text());
    const href = anchor.attr("href") || "";
    const url = normalizeSearchEntryUrl(normalizeBingUrl(href));
    const snippet = extractBingSnippet($, el);
    if (title && url && !isInternalSearchUrl(url)) results.push(makeSearchEntry(title, url, snippet));
    return undefined;
  });
  return results;
}

function parseBaiduResults(html: string, maxResults: number): SearchEntry[] {
  const $ = cheerio.load(html);
  const results: SearchEntry[] = [];
  const selectors = [
    "div.result",
    "div.c-container",
    "div.result-op",
  ].join(",");
  $(selectors).each((_, el) => {
    if (results.length >= maxResults) return false;
    const anchor = $(el).find("h3 a[href], a[href]").first();
    const title = normalizeText(anchor.html() || anchor.text());
    const href = anchor.attr("href") || "";
    const snippet = normalizeText(
      $(el).find(".c-abstract").first().html()
      || $(el).find(".content-right_8Zs40").first().html()
      || $(el).text(),
    );
    if (title && href) {
      const url = normalizeSearchResultUrl(href, BAIDU_SEARCH_URL);
      if (url) results.push(makeSearchEntry(title, url, snippet && snippet !== title ? snippet : undefined));
    }
    return undefined;
  });
  return dedupeSearchResults(results, maxResults);
}

function parseGenericResults(html: string, baseUrl: string, maxResults: number): SearchEntry[] {
  const $ = cheerio.load(html);
  const results: SearchEntry[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    if (results.length >= maxResults) return false;
    const href = $(el).attr("href") || "";
    const title = normalizeText($(el).text());
    if (!title || title.length < 3) return undefined;
    const url = normalizeSearchResultUrl(href, baseUrl);
    if (!url || isInternalSearchUrl(url) || seen.has(url)) return undefined;
    seen.add(url);
    results.push(makeSearchEntry(title, url));
    return undefined;
  });
  return results;
}

function isDuckChallenge(html: string): boolean {
  return html.includes("anomaly-modal") || html.includes("Unfortunately, bots use DuckDuckGo too");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  if (isConfigurationError(error)) return false;
  const message = formatFetchError(error).toLowerCase();
  return /fetch failed|network|timeout|timed? out|econnreset|econnrefused|enotfound|eai_again|socket|tls|terminated/.test(message);
}

function isConfigurationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /api key is not configured|custom search api key and cx are not configured|searxng url is not configured/i.test(error.message);
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return displayText(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  if (cause?.code || cause?.message) {
    return displayText(`${error.message}${cause.code ? ` (${cause.code})` : ""}${cause.message ? `: ${cause.message}` : ""}`);
  }
  return displayText(error.message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

function makeAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function makeTimeoutError(timeoutMs: number): Error {
  return new Error(`request timed out after ${timeoutMs} ms`);
}

async function fetchTextOnce(
  url: string,
  timeoutMs: number,
  accept: string,
  options: { signal?: AbortSignal; maxBytes?: number; validateRedirect?: (url: string) => Promise<void>; config?: ResolvedWebConfig; headers?: Record<string, string>; method?: "GET" | "POST"; body?: unknown } = {},
): Promise<FetchResponse> {
  if (options.signal?.aborted) throw makeAbortError();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromParent = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    let current = url;
    let resp: Response | null = null;
    let method = options.method ?? "GET";
    let body = options.body;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const dispatcher = dispatcherForUrl(current, options.config);
      const requestInit = omitUndefined({
        method,
        body: body === undefined ? undefined : safeJsonStringify(body),
        redirect: "manual" as const,
        signal: controller.signal,
        dispatcher: dispatcher as any,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": accept,
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          ...options.headers,
        },
      });
      try {
        resp = await fetch(current, requestInit);
      } catch (error) {
        if (timedOut && isAbortError(error)) throw makeTimeoutError(timeoutMs);
        throw error;
      }
      if (timedOut) throw makeTimeoutError(timeoutMs);
      if (controller.signal.aborted) throw makeAbortError();
      if (![301, 302, 303, 307, 308].includes(resp.status)) break;
      const location = resp.headers.get("location");
      if (!location) break;
      current = normalizeFetchUrlForRequest(new URL(location, current).toString());
      await options.validateRedirect?.(current);
      if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      if (redirects === MAX_REDIRECTS) throw new Error(`too many redirects (${MAX_REDIRECTS})`);
    }
    if (!resp) throw new Error("request failed before response");
    if (timedOut) throw makeTimeoutError(timeoutMs);
    if (controller.signal.aborted) throw makeAbortError();
    const { text, truncated } = await readResponseText(resp, options.maxBytes ?? DEFAULT_MAX_BYTES, controller.signal);
    if (timedOut) throw makeTimeoutError(timeoutMs);
    if (controller.signal.aborted) throw makeAbortError();
    return {
      status: resp.status,
      url: resp.url || current,
      contentType: displayText(resp.headers.get("content-type") ?? "application/octet-stream", MAX_CONTENT_TYPE_CHARS) || "application/octet-stream",
      text,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

async function fetchText(
  url: string,
  timeoutMs: number,
  accept: string,
  options: { signal?: AbortSignal; maxBytes?: number; retries?: number; validateRedirect?: (url: string) => Promise<void>; config?: ResolvedWebConfig; headers?: Record<string, string>; cache?: boolean; method?: "GET" | "POST"; body?: unknown } = {},
): Promise<FetchResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (options.signal?.aborted) throw makeAbortError();
  WEB_STATS.fetch_calls++;
  const shouldCache = options.cache !== false;
  const cacheKey = shouldCache ? fetchCacheKey(url, accept, maxBytes, options.config, options.method ?? "GET", options.body, options.headers) : "";
  if (cacheKey) {
    const cached = getTimedCache(FETCH_CACHE, cacheKey, FETCH_CACHE_TTL_MS);
    if (cached) {
      WEB_STATS.fetch_cache_hits++;
      return cloneFetchResponse(cached);
    }
  }

  const retries = Math.max(0, Math.min(options.retries ?? 1, 3));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const startedAt = Date.now();
      const response = await withHostConcurrency(url, () => fetchTextOnce(url, timeoutMs, accept, options), options.signal);
      WEB_STATS.fetch_ms += Date.now() - startedAt;
      if (attempt < retries && isRetryableStatus(response.status)) {
        lastError = new Error(`HTTP ${response.status}`);
        await delay(150 * (attempt + 1));
        continue;
      }
      if (cacheKey && response.status >= 200 && response.status < 400) {
        setTimedCache(FETCH_CACHE, cacheKey, cloneFetchResponse(response), FETCH_CACHE_MAX);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableError(error)) break;
      await delay(150 * (attempt + 1));
    }
  }
  WEB_STATS.fetch_failures++;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readResponseText(resp: Response, maxBytes: number, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const cap = asPositiveInt(maxBytes, DEFAULT_MAX_BYTES, MAX_BYTES);
  if (signal?.aborted) throw makeAbortError();
  if (!resp.body) {
    const text = await resp.text();
    if (signal?.aborted) throw makeAbortError();
    return { text: text.slice(0, cap), truncated: text.length > cap };
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let shouldCancel = false;
  const cancelReader = () => {
    shouldCancel = true;
    void reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw makeAbortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw makeAbortError();
      if (done) break;
      if (!value) continue;
      const remaining = cap - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    if (truncated || shouldCancel || signal?.aborted) await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncated };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function domainMatches(hostname: string, patterns: string[]): boolean {
  const host = hostWithoutBrackets(hostname);
  return patterns.some(pattern => {
    const normalized = normalizeDomainPattern(pattern, { allowWildcard: true, allowRestricted: true });
    if (!normalized) return false;
    if (normalized === "*") return true;
    if (normalized.startsWith(".")) return host.endsWith(normalized) || host === normalized.slice(1);
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function noProxyMatches(hostname: string, patterns: string[]): boolean {
  const envNoProxy = firstNonEmpty(process.env.NO_PROXY ?? "", process.env.no_proxy ?? "");
  return domainMatches(hostname, [
    ...patterns,
    ...normalizeDomainList(envNoProxy, { allowWildcard: true, allowRestricted: true }),
  ]);
}

function safeLookup(
  hostname: string,
  options: unknown,
  callback: (error: NodeJS.ErrnoException | null, address: unknown, family?: unknown) => void,
): void {
  callbackLookup(hostname, options as any, (error, address, family) => {
    if (error) {
      callback(error, address as any, family as any);
      return;
    }
    const addresses = Array.isArray(address)
      ? address.map(item => item.address)
      : [String(address)];
    const blocked = addresses.find(item => isRestrictedIpAddress(item));
    if (blocked) {
      const err = new Error(`blocked restricted resolved IP: ${blocked}`) as NodeJS.ErrnoException;
      err.code = "EAI_BLOCKED_PRIVATE_IP";
      callback(err, address as any, family as any);
      return;
    }
    callback(null, address as any, family as any);
  });
}

function dispatcherForUrl(rawUrl: string, config?: ResolvedWebConfig): Dispatcher | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (config?.proxy && !noProxyMatches(parsed.hostname, config.noProxy)) {
    let dispatcher = PROXY_DISPATCHERS.get(config.proxy);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(config.proxy);
      PROXY_DISPATCHERS.set(config.proxy, dispatcher);
    }
    return dispatcher;
  }
  if (noProxyMatches(parsed.hostname, config?.noProxy ?? [])) return SAFE_DISPATCHER;
  const hasEnvProxy = Boolean(process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy);
  if (!hasEnvProxy) return SAFE_DISPATCHER;
  if (ENV_DISPATCHER === undefined) ENV_DISPATCHER = new EnvHttpProxyAgent();
  return ENV_DISPATCHER ?? undefined;
}

async function searchDuckDuckGo(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl("https://html.duckduckgo.com/", { ...config, allowedDomains: [] });
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchText(url, timeoutMs, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", omitUndefined({ signal, maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes), retries: 1, config }));
  if (resp.status < 200 || resp.status >= 300) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  const results = parseDuckResults(resp.text, maxResults);
  if (!results.length && isDuckChallenge(resp.text)) throw new Error("DuckDuckGo returned a bot challenge");
  return results.length ? results : parseGenericResults(resp.text, resp.url, maxResults);
}

async function searchBing(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl("https://www.bing.com/", { ...config, allowedDomains: [] });
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US`;
  const resp = await fetchText(url, timeoutMs, BING_SEARCH_HEADERS.Accept, omitUndefined({
    signal,
    maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes),
    retries: 1,
    config,
    headers: BING_SEARCH_HEADERS,
  }));
  if (resp.status < 200 || resp.status >= 300) throw new Error(`Bing HTTP ${resp.status}`);
  const results = parseBingResults(resp.text, maxResults);
  return results.length ? results : parseGenericResults(resp.text, resp.url, maxResults);
}

async function searchBrave(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  if (!config.braveApiKey) throw new Error("Brave API key is not configured");
  await assertPublicUrl(BRAVE_SEARCH_URL, { ...config, allowedDomains: [] });
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const payload = await fetchJson(url.toString(), timeoutMs, omitUndefined({
    signal,
    config,
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": config.braveApiKey,
    },
  }));
  const web = safeProperty(apiObject(payload), "web");
  const items = apiItems(safeProperty(apiObject(web), "results"));
  return items
    .map(item => item && typeof item === "object"
      ? entryFromRecord(item as Record<string, unknown>, { title: ["title"], url: ["url"], snippet: ["description", "snippet", "snippets"] })
      : null)
    .filter((item): item is SearchEntry => Boolean(item))
    .slice(0, maxResults);
}

async function searchTavily(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  if (!config.tavilyApiKey) throw new Error("Tavily API key is not configured");
  await assertPublicUrl(TAVILY_SEARCH_URL, { ...config, allowedDomains: [] });
  const payload = await fetchJson(TAVILY_SEARCH_URL, timeoutMs, omitUndefined({
    signal,
    config,
    method: "POST" as const,
    headers: {
      "Authorization": `Bearer ${config.tavilyApiKey}`,
    },
    body: {
      query,
      max_results: maxResults,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    },
  }));
  const items = apiItems(safeProperty(apiObject(payload), "results"));
  return items
    .map(item => item && typeof item === "object"
      ? entryFromRecord(item as Record<string, unknown>, { title: ["title"], url: ["url"], snippet: ["content", "snippet"] })
      : null)
    .filter((item): item is SearchEntry => Boolean(item))
    .slice(0, maxResults);
}

async function searchSerper(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  if (!config.serperApiKey) throw new Error("Serper API key is not configured");
  await assertPublicUrl(SERPER_SEARCH_URL, { ...config, allowedDomains: [] });
  const payload = await fetchJson(SERPER_SEARCH_URL, timeoutMs, omitUndefined({
    signal,
    config,
    method: "POST" as const,
    headers: {
      "X-API-KEY": config.serperApiKey,
    },
    body: {
      q: query,
      num: maxResults,
    },
  }));
  const record = apiObject(payload) ?? {};
  const organic = apiItems(safeProperty(record, "organic"));
  const news = apiItems(safeProperty(record, "news"));
  return [...organic, ...news]
    .map(item => item && typeof item === "object"
      ? entryFromRecord(item as Record<string, unknown>, { title: ["title"], url: ["link"], snippet: ["snippet", "description"] })
      : null)
    .filter((item): item is SearchEntry => Boolean(item))
    .slice(0, maxResults);
}

async function searchGoogle(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  if (!config.googleApiKey || !config.googleCx) throw new Error("Google Custom Search API key and cx are not configured");
  await assertPublicUrl(GOOGLE_CUSTOM_SEARCH_URL, { ...config, allowedDomains: [] });
  const url = new URL(GOOGLE_CUSTOM_SEARCH_URL);
  url.searchParams.set("key", config.googleApiKey);
  url.searchParams.set("cx", config.googleCx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", String(maxResults));
  const payload = await fetchJson(url.toString(), timeoutMs, omitUndefined({
    signal,
    config,
    headers: { "Accept": "application/json" },
  }));
  const items = apiItems(safeProperty(apiObject(payload), "items"));
  return items
    .map(item => item && typeof item === "object"
      ? entryFromRecord(item as Record<string, unknown>, { title: ["title", "htmlTitle"], url: ["link"], snippet: ["snippet", "htmlSnippet"] })
      : null)
    .filter((item): item is SearchEntry => Boolean(item))
    .slice(0, maxResults);
}

async function searchExa(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  if (!config.exaApiKey) throw new Error("Exa API key is not configured");
  await assertPublicUrl(EXA_SEARCH_URL, { ...config, allowedDomains: [] });
  const payload = await fetchJson(EXA_SEARCH_URL, timeoutMs, omitUndefined({
    signal,
    config,
    method: "POST" as const,
    headers: {
      "x-api-key": config.exaApiKey,
    },
    body: {
      query,
      numResults: maxResults,
      type: "auto",
      useAutoprompt: true,
    },
  }));
  const items = apiItems(safeProperty(apiObject(payload), "results"));
  return items
    .map(item => item && typeof item === "object"
      ? entryFromRecord(item as Record<string, unknown>, { title: ["title"], url: ["url"], snippet: ["text", "summary", "snippet"] })
      : null)
    .filter((item): item is SearchEntry => Boolean(item))
    .slice(0, maxResults);
}

async function searchKagi(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  if (!config.kagiApiKey) throw new Error("Kagi API key is not configured");
  await assertPublicUrl(KAGI_SEARCH_URL, { ...config, allowedDomains: [] });
  const url = new URL(KAGI_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(maxResults));
  const payload = await fetchJson(url.toString(), timeoutMs, omitUndefined({
    signal,
    config,
    headers: {
      "Authorization": `Bot ${config.kagiApiKey}`,
      "Accept": "application/json",
    },
  }));
  const rawData = safeProperty(apiObject(payload), "data");
  let items: unknown[] = [];
  if (isArrayValue(rawData)) {
    items = apiItems(rawData);
  } else if (rawData && typeof rawData === "object") {
    items = apiItems(safeProperty(rawData, "results"));
  }
  return items
    .map(item => item && typeof item === "object"
      ? entryFromRecord(item as Record<string, unknown>, { title: ["title"], url: ["url"], snippet: ["snippet", "description"] })
      : null)
    .filter((item): item is SearchEntry => Boolean(item))
    .slice(0, maxResults);
}

async function searchArxiv(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl(ARXIV_SEARCH_URL, { ...config, allowedDomains: [] });
  const url = new URL(ARXIV_SEARCH_URL);
  url.searchParams.set("search_query", query);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(maxResults));
  const resp = await fetchText(url.toString(), timeoutMs, "application/atom+xml,application/xml,text/xml,*/*;q=0.5", omitUndefined({
    signal,
    maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes),
    retries: 1,
    config,
  }));
  if (resp.status < 200 || resp.status >= 300) throw new Error(`arXiv HTTP ${resp.status}`);
  const $ = cheerio.load(resp.text, { xmlMode: true });
  const results: SearchEntry[] = [];
  $("entry").each((_, el) => {
    if (results.length >= maxResults) return false;
    const title = normalizeText($(el).find("title").first().text());
    const id = normalizeText($(el).find("id").first().text());
    const summary = normalizeText($(el).find("summary").first().text());
    const htmlLink = $(el).find("link[rel='alternate']").attr("href")
      || $(el).find("link[type='text/html']").attr("href")
      || id;
    const url = normalizeSearchEntryUrl(htmlLink);
    if (title && url) {
      results.push(makeSearchEntry(title, url, summary));
    }
    return undefined;
  });
  return results;
}

async function searchSemanticScholar(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl(SEMANTIC_SCHOLAR_SEARCH_URL, { ...config, allowedDomains: [] });
  const url = new URL(SEMANTIC_SCHOLAR_SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(maxResults));
  url.searchParams.set("fields", "title,url,abstract,year,authors,venue");
  const payload = await fetchJson(url.toString(), timeoutMs, omitUndefined({
    signal,
    config,
    headers: {
      "Accept": "application/json",
      ...(config.semanticScholarApiKey ? { "x-api-key": config.semanticScholarApiKey } : {}),
    },
  }));
  const items = apiItems(safeProperty(apiObject(payload), "data"));
  return items
    .map(item => {
      if (!item || typeof item !== "object") return null;
      const record = apiObject(item);
      if (!record) return null;
      const entry = entryFromRecord(record, { title: ["title"], url: ["url"], snippet: ["abstract"] });
      if (!entry) return null;
      const year = compactScalar(safeProperty(record, "year")) || "";
      const venueValue = safeProperty(record, "venue");
      const venue = typeof venueValue === "string" ? venueValue : "";
      const prefix = [year, venue].filter(Boolean).join(" ");
      return prefix ? { ...entry, snippet: [prefix, entry.snippet].filter(Boolean).join(" - ") } : entry;
    })
    .filter((item): item is SearchEntry => Boolean(item))
    .slice(0, maxResults);
}

async function searchPubmed(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl(PUBMED_ESEARCH_URL, { ...config, allowedDomains: [] });
  await assertPublicUrl(PUBMED_ESUMMARY_URL, { ...config, allowedDomains: [] });
  const searchUrl = new URL(PUBMED_ESEARCH_URL);
  searchUrl.searchParams.set("db", "pubmed");
  searchUrl.searchParams.set("term", query);
  searchUrl.searchParams.set("retmode", "json");
  searchUrl.searchParams.set("retmax", String(maxResults));
  if (config.pubmedApiKey) searchUrl.searchParams.set("api_key", config.pubmedApiKey);
  const searchPayload = await fetchJson(searchUrl.toString(), timeoutMs, omitUndefined({
    signal,
    config,
    headers: { "Accept": "application/json" },
  }));
  const esearch = safeProperty(apiObject(searchPayload), "esearchresult");
  const rawIds = safeProperty(apiObject(esearch), "idlist");
  const ids: string[] = apiItems(rawIds, MAX_RESULTS)
      .map(id => normalizePubmedId(id))
      .filter((id): id is string => Boolean(id))
      .slice(0, maxResults);
  if (!ids.length) return [];

  const summaryUrl = new URL(PUBMED_ESUMMARY_URL);
  summaryUrl.searchParams.set("db", "pubmed");
  summaryUrl.searchParams.set("id", ids.join(","));
  summaryUrl.searchParams.set("retmode", "json");
  if (config.pubmedApiKey) summaryUrl.searchParams.set("api_key", config.pubmedApiKey);
  const summaryPayload = await fetchJson(summaryUrl.toString(), timeoutMs, omitUndefined({
    signal,
    config,
    headers: { "Accept": "application/json" },
  }));
  const records = apiObject(safeProperty(apiObject(summaryPayload), "result")) ?? {};
  const entries: Array<SearchEntry | null> = ids.map((id: string) => {
    const record = safeProperty(records, id);
    if (!record || typeof record !== "object") return null;
    const data = apiObject(record) ?? {};
    const title = compactSnippet(safeProperty(data, "title")) || `PubMed ${id}`;
    const source = compactSnippet(safeProperty(data, "source"));
    const pubdate = compactSnippet(safeProperty(data, "pubdate"));
    return makeSearchEntry(title, `https://pubmed.ncbi.nlm.nih.gov/${id}/`, [source, pubdate].filter(Boolean).join(" "));
  });
  return entries.filter((item): item is SearchEntry => Boolean(item)).slice(0, maxResults);
}

function normalizePubmedId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^\d{1,32}$/.test(trimmed) && trimmed.length <= MAX_PUBMED_ID_CHARS ? trimmed : undefined;
}

async function searchBaidu(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl(BAIDU_SEARCH_URL, { ...config, allowedDomains: [] });
  const url = new URL(BAIDU_SEARCH_URL);
  url.searchParams.set("wd", query);
  const resp = await fetchText(url.toString(), timeoutMs, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", omitUndefined({
    signal,
    maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes),
    retries: 1,
    config,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    },
  }));
  if (resp.status < 200 || resp.status >= 300) throw new Error(`Baidu HTTP ${resp.status}`);
  const results = parseBaiduResults(resp.text, maxResults);
  return results.length ? results : parseGenericResults(resp.text, resp.url, maxResults);
}

async function searchSearxng(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  if (!config.searxngUrl) throw new Error("SearXNG URL is not configured");
  const base = config.searxngUrl.replace(/\/+$/, "");
  await assertPublicUrl(base, { ...config, allowedDomains: [] });
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  const payload = await fetchJson(url.toString(), timeoutMs, omitUndefined({
    signal,
    config,
    headers: { "Accept": "application/json" },
  }));
  const items = apiItems(safeProperty(apiObject(payload), "results"));
  return items
    .map(item => item && typeof item === "object"
      ? entryFromRecord(item as Record<string, unknown>, { title: ["title"], url: ["url"], snippet: ["content", "snippet"] })
      : null)
    .filter((item): item is SearchEntry => Boolean(item))
    .slice(0, maxResults);
}

interface SearchCandidate {
  engine: SearchEngine;
  source: string;
  run: (query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal) => Promise<SearchEntry[]>;
  available: boolean;
}

function configuredSearchCandidates(config: ResolvedWebConfig): SearchCandidate[] {
  return [
    { engine: "google", source: "Google", run: searchGoogle, available: Boolean(config.googleApiKey && config.googleCx) },
    { engine: "exa", source: "Exa", run: searchExa, available: Boolean(config.exaApiKey) },
    { engine: "kagi", source: "Kagi", run: searchKagi, available: Boolean(config.kagiApiKey) },
    { engine: "brave", source: "Brave", run: searchBrave, available: Boolean(config.braveApiKey) },
    { engine: "tavily", source: "Tavily", run: searchTavily, available: Boolean(config.tavilyApiKey) },
    { engine: "serper", source: "Serper", run: searchSerper, available: Boolean(config.serperApiKey) },
    { engine: "searxng", source: "SearXNG", run: searchSearxng, available: Boolean(config.searxngUrl) },
    { engine: "bing", source: "Bing", run: searchBing, available: true },
    { engine: "duckduckgo", source: "DuckDuckGo", run: searchDuckDuckGo, available: true },
    { engine: "arxiv", source: "arXiv", run: searchArxiv, available: false },
    { engine: "semantic_scholar", source: "Semantic Scholar", run: searchSemanticScholar, available: false },
    { engine: "pubmed", source: "PubMed", run: searchPubmed, available: false },
    { engine: "baidu", source: "Baidu", run: searchBaidu, available: false },
  ];
}

function searchCandidates(engine: SearchEngine, config: ResolvedWebConfig): SearchCandidate[] {
  const all = configuredSearchCandidates(config);
  if (engine === "auto") return all.filter(candidate => candidate.available);
  const candidate = all.find(item => item.engine === engine);
  return candidate ? [candidate] : [];
}

async function runSearchCandidate(
  candidate: SearchCandidate,
  query: string,
  maxResults: number,
  timeoutMs: number,
  config: ResolvedWebConfig,
  signal?: AbortSignal,
): Promise<{ source: string; results: SearchEntry[]; telemetry: SearchEngineTelemetry }> {
  const circuitReason = engineCircuitOpen(candidate.source);
  if (circuitReason) {
    const telemetry = { engine: candidate.engine, source: candidate.source, ok: false, duration_ms: 0, result_count: 0, error: circuitReason };
    recordEngineTelemetry(telemetry);
    return Promise.reject(Object.assign(new Error(circuitReason), { telemetry }));
  }
  const startedAt = Date.now();
  try {
    const results = await candidate.run(query, maxResults, timeoutMs, config, signal);
    const telemetry = {
      engine: candidate.engine,
      source: candidate.source,
      ok: true,
      duration_ms: Date.now() - startedAt,
      result_count: results.length,
    };
    recordEngineTelemetry(telemetry);
    recordEngineHealth(candidate.source, true);
    return { source: candidate.source, results, telemetry };
  } catch (error) {
    const telemetry = {
      engine: candidate.engine,
      source: candidate.source,
      ok: false,
      duration_ms: Date.now() - startedAt,
      result_count: 0,
      error: formatFetchError(error),
    };
    recordEngineTelemetry(telemetry);
    recordEngineHealth(candidate.source, isConfigurationError(error));
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { telemetry });
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  return results;
}

async function searchWithFallback(
  query: string,
  maxResults: number,
  timeoutMs: number,
  engine: SearchEngine,
  searchType: SearchType,
  config: ResolvedWebConfig,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  if (signal?.aborted) throw makeAbortError();
  WEB_STATS.search_calls++;
  const cacheKey = searchCacheKey(query, maxResults, engine, searchType, config);
  if (cacheKey) {
    const cached = getTimedCache(SEARCH_CACHE, cacheKey, SEARCH_CACHE_TTL_MS);
    if (cached) {
      WEB_STATS.search_cache_hits++;
      return { ...cloneSearchOutcome(cached), cacheHit: true };
    }
  }

  const failures: string[] = [];
  const telemetry: SearchEngineTelemetry[] = [];
  const candidates = searchCandidates(engine, config);
  if (!candidates.length) return { source: "", results: [], failures: [`${engine}: no search engine configured`], telemetry };

  if (engine === "auto" && searchType === "deep") {
    const settled = await mapLimit(candidates, 3, candidate =>
      runSearchCandidate(candidate, query, maxResults, timeoutMs, config, signal)
    );
    const merged: SearchEntry[] = [];
    const sources: string[] = [];
    settled.forEach((result, index) => {
      const source = candidates[index]?.source || "unknown";
      if (result.status === "fulfilled") {
        telemetry.push(result.value.telemetry);
        if (result.value.results.length) {
          sources.push(result.value.source);
          merged.push(...result.value.results);
        } else {
          failures.push(`${source}: no parseable results`);
        }
        return;
      }
      if (isAbortError(result.reason) || signal?.aborted) throw result.reason;
      const rejectedTelemetry = (result.reason as { telemetry?: SearchEngineTelemetry })?.telemetry;
      if (rejectedTelemetry) telemetry.push(rejectedTelemetry);
      failures.push(`${source}: ${formatFetchError(result.reason)}`);
    });
    const outcome = {
      source: sources.join(" + "),
      results: rankSearchResults(query, dedupeSearchResults(merged, Math.max(maxResults * 2, maxResults)), maxResults),
      failures,
      telemetry,
    };
    if (cacheKey && outcome.results.length) setTimedCache(SEARCH_CACHE, cacheKey, cloneSearchOutcome(outcome), SEARCH_CACHE_MAX);
    return outcome;
  }

  for (const candidate of candidates) {
    try {
      const searched = await runSearchCandidate(candidate, query, maxResults, timeoutMs, config, signal);
      telemetry.push(searched.telemetry);
      const results = searched.results;
      if (results.length) {
        const outcome = {
          source: candidate.source,
          results: rankSearchResults(query, dedupeSearchResults(results, Math.max(maxResults * 2, maxResults)), maxResults),
          failures,
          telemetry,
        };
        if (cacheKey) setTimedCache(SEARCH_CACHE, cacheKey, cloneSearchOutcome(outcome), SEARCH_CACHE_MAX);
        return outcome;
      }
      failures.push(`${candidate.source}: no parseable results`);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      const rejectedTelemetry = (error as { telemetry?: SearchEngineTelemetry })?.telemetry;
      if (rejectedTelemetry) telemetry.push(rejectedTelemetry);
      failures.push(`${candidate.source}: ${formatFetchError(error)}`);
    }
  }

  return { source: "", results: [], failures, telemetry };
}

function assignRefs(query: string, source: string, results: SearchEntry[]): SearchEntry[] {
  return results.map(result => {
    const ref_id = `web_${(++refSeq).toString(36)}`;
    WEB_REFS.set(ref_id, omitUndefined({
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      source,
      query,
      createdAt: Date.now(),
    }));
    pruneRefs();
    return { ...result, ref_id };
  });
}

function filterSearchResults(results: SearchEntry[], allowedDomains: string[], blockedDomains: string[]): SearchEntry[] {
  return (Array.isArray(results) ? results : []).flatMap(result => {
    try {
      const entry = cloneSearchEntry(result);
      const normalizedUrl = normalizeSearchEntryUrl(entry.url);
      if (!normalizedUrl) return [];
      const hostname = new URL(normalizedUrl).hostname;
      if (blockedDomains.length && domainMatches(hostname, blockedDomains)) return [];
      if (allowedDomains.length && !domainMatches(hostname, allowedDomains)) return [];
      return [{ ...entry, url: normalizedUrl }];
    } catch {
      return [];
    }
  });
}

function pruneRefs(): void {
  const maxRefs = 200;
  const maxAgeMs = 6 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [key, value] of WEB_REFS) {
    if (now - value.createdAt > maxAgeMs) WEB_REFS.delete(key);
  }
  while (WEB_REFS.size > maxRefs) {
    const first = WEB_REFS.keys().next().value;
    if (!first) break;
    WEB_REFS.delete(first);
  }
}

async function webSearchWithConfig(args: Record<string, unknown>, config: ResolvedWebConfig, signal?: AbortSignal): Promise<string> {
  args = snapshotToolArgs(args);
  const queryError = validateWebSearchQueryArgs(args);
  if (queryError) return `Error searching: ${queryError}.`;
  const domainError = validateWebSearchDomainArgs(args);
  if (domainError) return `Error searching: ${domainError}.`;
  const optionError = validateWebSearchOptionArgs(args);
  if (optionError) return `Error searching: ${optionError}.`;
  const query = extractSearchQuery(args);
  if (!query) return "Error searching: query is required.";

  if (!config.enabled || config.mode === "off") return "Error searching: web tools are disabled by configuration.";
  const maxResults = extractSearchMaxResults(args);
  const timeoutMs = asPositiveInt(nestedSearchValue(args, ["timeout_ms", "timeoutMs"]), config.searchTimeoutMs, MAX_TIMEOUT_MS);
  const engine = normalizeSearchEngine(args.engine ?? args.source ?? config.searchEngine);
  const searchType = normalizeSearchType(args.type ?? args.search_type ?? args.searchType);
  const includeContent = extractSearchContextEnabled(args, searchType);
  const contextMaxCharacters = extractContextMaxCharacters(args);
  const contextResults = extractContextResults(args);
  const jsonOutput = asBool(args.json, false);
  const requestedDomains = extractSearchDomains(args);
  const effectiveAllowedDomains = requestedDomains.length
    ? requestedDomains.filter(domain => !config.allowedDomains.length || domainMatches(domain, config.allowedDomains))
    : config.allowedDomains;
  if (requestedDomains.length && !effectiveAllowedDomains.length) {
    return jsonOutput
      ? safeJsonStringify({ query, source: "", count: 0, results: [], failures: ["requested domains are outside web.allowed_domains"], message: `No results for '${query}'` }, { space: 2 })
      : `No results for '${query}'. Tried requested domains but they are outside web.allowed_domains`;
  }
  const searchQuery = effectiveAllowedDomains.length
    ? `${query} ${effectiveAllowedDomains.map(domain => `site:${domain.replace(/^\./, "")}`).join(" OR ")}`
    : query;
  const { source, results: rawResults, failures, telemetry, cacheHit } = await searchWithFallback(searchQuery, maxResults, timeoutMs, engine, searchType, config, signal);
  const filteredResults = filterSearchResults(rawResults, effectiveAllowedDomains, config.blockedDomains);
  const contextualResults = includeContent
    ? await attachResultContent(filteredResults, config, omitUndefined({ contextResults, contextMaxCharacters, timeoutMs, signal }))
    : filteredResults;
  const results = assignRefs(query, source, contextualResults);

  if (!results.length) {
    const payload = { query, source: "", count: 0, results: [], failures, telemetry, cache_hit: Boolean(cacheHit), message: `No results for '${query}'` };
    const failureSummary = failures.length ? failures.join(" | ") : "no engines";
    return jsonOutput ? safeJsonStringify(payload, { space: 2 }) : `No results for '${query}'. Tried ${failureSummary}`;
  }

  if (jsonOutput) {
    return safeJsonStringify({
      query,
      source,
      count: results.length,
      results,
      failures,
      telemetry,
      search_type: searchType,
      context_included: includeContent,
      cache_hit: Boolean(cacheHit),
      message: `Found ${results.length} result(s)`,
    }, { space: 2 });
  }

  const lines = [`Search results for: ${query}`, `Source: ${source}`, ""];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`, `   ref_id: ${result.ref_id}`, `   ${result.url}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
    if (result.content) lines.push("", trimForContext(result.content, Math.max(500, Math.floor(contextMaxCharacters / Math.max(1, Math.min(contextResults, results.length))))));
    if (result.content_error) lines.push(`   Content: unavailable (${result.content_error})`);
    lines.push("");
  });
  if (failures.length) lines.push(`Note: ${failures.join(" | ")}`);
  if (cacheHit) lines.push("Cache: hit");
  return lines.join("\n");
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
  const normalized = hostWithoutBrackets(ip);
  const expanded = expandIPv6Address(normalized);
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
  if (expanded.slice(0, 6).every(part => part === 0)) {
    const v4 = [
      (sixth >> 8) & 255,
      sixth & 255,
      (seventh >> 8) & 255,
      seventh & 255,
    ].join(".");
    return isRestrictedIPv4(v4);
  }
  if (expanded.slice(0, 5).every(part => part === 0) && expanded[5] === 0xffff) {
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
  const zoneIndex = value.indexOf("%");
  const ip = (zoneIndex >= 0 ? value.slice(0, zoneIndex) : value).toLowerCase();
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
        if (!isRestrictedIPv4(chunk) && isIP(chunk) !== 4) return null;
        const octets = chunk.split(".").map(part => Number.parseInt(part, 10));
        if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
        const [a, b, c, d] = octets as [number, number, number, number];
        parsed.push(((a << 8) | b), ((c << 8) | d));
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

function isRestrictedIpAddress(address: string): boolean {
  const host = hostWithoutBrackets(address);
  if (isIP(host) === 4) return isRestrictedIPv4(host);
  if (isIP(host) === 6) return isRestrictedIPv6(host);
  return false;
}

function isRestrictedHost(hostname: string): boolean {
  const host = hostWithoutBrackets(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") return true;
  if (isIP(host)) return isRestrictedIpAddress(host);
  return false;
}

async function assertPublicUrl(rawUrl: string, config?: ResolvedWebConfig): Promise<URL> {
  if (typeof rawUrl !== "string" || !rawUrl.trim() || rawUrl.length > MAX_URL_CHARS || hasUnsupportedControl(rawUrl) || rawUrl.includes("\uFFFD")) {
    throw new Error("invalid URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http:// and https:// URLs are supported");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL credentials are not supported");
  }
  normalizeParsedHostname(parsed);
  if (config?.blockedDomains.length && domainMatches(parsed.hostname, config.blockedDomains)) {
    throw new Error(`blocked by web.blocked_domains: ${parsed.hostname}`);
  }
  if (config?.allowedDomains.length && !domainMatches(parsed.hostname, config.allowedDomains)) {
    throw new Error(`blocked by web.allowed_domains: ${parsed.hostname}`);
  }
  if (isRestrictedHost(parsed.hostname)) {
    throw new Error(`blocked restricted host: ${parsed.hostname}`);
  }

  // Real direct fetches still use SAFE_DISPATCHER, whose DNS lookup rejects
  // private/reserved resolved IPs without doing a separate preflight request.
  return parsed;
}

function trimForContext(content: string, maxChars: number): string {
  const cap = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_CONTEXT_MAX_CHARACTERS;
  const normalized = content.replace(UNSUPPORTED_CONTROL_GLOBAL_RE, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= cap) return normalized;
  return `${normalized.slice(0, Math.max(0, cap - 24)).trimEnd()}\n[content truncated]`;
}

async function attachResultContent(
  results: SearchEntry[],
  config: ResolvedWebConfig,
  options: { contextResults: number; contextMaxCharacters: number; timeoutMs: number; signal?: AbortSignal },
): Promise<SearchEntry[]> {
  if (!results.length || options.contextResults <= 0 || options.contextMaxCharacters <= 0) return results;

  const count = Math.min(results.length, options.contextResults, MAX_CONTEXT_RESULTS);
  const charsPerResult = Math.max(500, Math.floor(options.contextMaxCharacters / count));
  const enriched = cloneSearchResults(results);
  await Promise.all(enriched.slice(0, count).map(async (result, index) => {
    try {
      const parsed = await assertPublicUrl(result.url, config);
      const safeUrl = normalizeFetchUrlForRequest(parsed.toString());
      const resp = await fetchText(safeUrl, options.timeoutMs, "text/html,text/plain,application/json,application/xml,*/*;q=0.8", omitUndefined({
        signal: options.signal,
        maxBytes: Math.min(config.maxBytes, SEARCH_FETCH_MAX_BYTES),
        retries: 0,
        config,
        validateRedirect: async (url: string) => { await assertPublicUrl(url, config); },
      }));
      if (resp.status < 200 || resp.status >= 400) {
        enriched[index] = { ...result, content_error: `HTTP ${resp.status}` };
        return;
      }
      const sourceText = resp.text.slice(0, SEARCH_FETCH_MAX_BYTES);
      const content = processBody(sourceText, resp.contentType, "markdown");
      const trimmed = trimForContext(content, charsPerResult);
      enriched[index] = {
        ...result,
        content: trimmed,
        content_profile: contentProfile(sourceText, resp.contentType, trimmed, resp.truncated || resp.text.length > sourceText.length),
      };
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
      enriched[index] = { ...result, content_error: formatFetchError(error) };
    }
  }));
  return enriched;
}

function formatFetchResult(resp: FetchResponse, content: string, jsonOutput: boolean, profile?: ContentProfile): string {
  if (jsonOutput) {
    return safeJsonStringify({
      url: resp.url,
      status: resp.status,
      content_type: resp.contentType,
      truncated: resp.truncated,
      content_profile: profile,
      content,
    }, { space: 2 });
  }
  const header = [
    `URL: ${resp.url}`,
    `Status: ${resp.status}`,
    `Content-Type: ${resp.contentType}`,
    `Truncated: ${resp.truncated}`,
    ...(profile ? [`Profile: ${profile.format}, ${profile.word_count} words${profile.title ? `, title: ${profile.title}` : ""}`] : []),
    "",
  ].join("\n");
  return header + content;
}

async function webFetchWithConfig(args: Record<string, unknown>, config: ResolvedWebConfig, signal?: AbortSignal): Promise<string> {
  args = snapshotToolArgs(args);
  const optionError = validateWebFetchOptionArgs(args);
  if (optionError) return `Error fetching URL: ${optionError}.`;
  const urlError = validateBoundedString(args.url, "url", MAX_URL_CHARS);
  if (urlError) return `Error fetching URL: ${urlError}.`;
  for (const key of ["ref_id", "refId"] as const) {
    const refError = validateBoundedString(args[key], key, MAX_REF_ID_CHARS);
    if (refError) return `Error fetching URL: ${refError}.`;
  }
  if (!config.enabled || config.mode === "off") return "Error fetching URL: web tools are disabled by configuration.";
  const refId = extractRefId(args);
  const ref = refId ? WEB_REFS.get(refId) : undefined;
  if (refId && !ref) return `Error fetching URL: unknown ref_id '${refId}'. Run web_search first or pass url directly.`;
  const rawUrl = typeof args.url === "string" && args.url.trim() ? args.url.trim() : ref?.url ?? "";
  if (!rawUrl) return "Error fetching URL: url is required.";

  const format = normalizeFetchFormat(args);
  const jsonOutput = asBool(args.json, false);
  const timeoutMs = asPositiveInt(args.timeout_ms, config.fetchTimeoutMs, MAX_TIMEOUT_MS);
  const maxBytes = asPositiveInt(args.max_bytes, config.maxBytes, MAX_BYTES);

  try {
    const parsed = await assertPublicUrl(rawUrl, config);
    const safeUrl = normalizeFetchUrlForRequest(parsed.toString());
    const resp = await fetchText(safeUrl, timeoutMs, "text/html,text/plain,application/json,application/xml,*/*;q=0.8", omitUndefined({
      signal,
      maxBytes,
      retries: 1,
      config,
      validateRedirect: async (url: string) => { await assertPublicUrl(url, config); },
    }));
    const sourceText = resp.text.slice(0, maxBytes);
    const content = processBody(sourceText, resp.contentType, format).slice(0, maxBytes);
    return formatFetchResult(resp, content, jsonOutput, contentProfile(sourceText, resp.contentType, content, resp.truncated || resp.text.length > sourceText.length));
  } catch (error) {
    return `Error fetching URL: ${formatFetchError(error)}`;
  }
}

export function registerWebTools(configInput?: Partial<WebConfig>): void {
  const r = getRegistry();
  const webConfig = resolveWebConfig(configInput);
  const searchExecute = (args: Record<string, unknown>, context?: ToolExecutionContext) =>
    webSearchWithConfig(snapshotToolArgs(args), webConfig, context?.signal);
  const fetchExecute = (args: Record<string, unknown>, context?: ToolExecutionContext) =>
    webFetchWithConfig(snapshotToolArgs(args), webConfig, context?.signal);
  r.register({
    name: "web_search",
    description: "Search the web using configured engines (Brave, Tavily, Serper, SearXNG, Bing, DuckDuckGo). Returns titles, URLs, snippets, and optional fetched context.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Alias: q." },
        q: { type: "string", description: "Search query alias." },
        search_query: {
          type: "array",
          description: "Compatibility array form: [{ q, query, max_results }].",
          items: { type: "object", properties: { q: { type: "string" }, query: { type: "string" }, max_results: { type: "integer" }, domains: { type: "array", items: { type: "string" } } } },
        },
        max_results: { type: "integer", default: DEFAULT_MAX_RESULTS, maximum: MAX_RESULTS },
        timeout_ms: { type: "integer", default: DEFAULT_SEARCH_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
        domains: { type: "array", items: { type: "string" }, description: "Optional domain filter, e.g. [\"example.com\"]." },
        engine: { type: "string", enum: ["auto", "google", "exa", "kagi", "brave", "tavily", "serper", "searxng", "arxiv", "semantic_scholar", "pubmed", "baidu", "bing", "duckduckgo"], default: "auto" },
        type: { type: "string", enum: ["auto", "fast", "deep"], default: "auto", description: "Search depth. deep merges engines and includes page context by default." },
        fetch_results: { type: "boolean", default: false, description: "Fetch top result pages and include extracted context." },
        include_content: { type: "boolean", default: false, description: "Alias for fetch_results." },
        context_results: { type: "integer", default: DEFAULT_CONTEXT_RESULTS, maximum: MAX_CONTEXT_RESULTS },
        context_max_characters: { type: "integer", default: DEFAULT_CONTEXT_MAX_CHARACTERS, maximum: MAX_CONTEXT_MAX_CHARACTERS },
        json: { type: "boolean", default: false },
      },
    },
    execute: searchExecute,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "web",
    parallelOk: true,
    readOnly: true,
    searchHint: "search internet sources",
    resultKind: "text",
    maxResultSizeChars: 100_000,
    isSearchOrReadCommand: () => ({ isSearch: true, isRead: false }),
    validateInput: validateWebSearchInput,
  });
  r.register({
    name: "web_fetch",
    description: "Fetch and extract text from an HTTP/HTTPS URL or web_search ref_id.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        ref_id: { type: "string", description: "Result ref_id returned by web_search." },
        format: { type: "string", enum: ["markdown", "text", "raw"], default: "markdown" },
        extract_text: { type: "boolean", default: true },
        max_bytes: { type: "integer", default: DEFAULT_MAX_BYTES, maximum: MAX_BYTES },
        timeout_ms: { type: "integer", default: DEFAULT_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
        json: { type: "boolean", default: false },
      },
    },
    execute: fetchExecute,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "web",
    parallelOk: true,
    readOnly: true,
    searchHint: "fetch webpage content",
    resultKind: "text",
    maxResultSizeChars: 120_000,
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
    validateInput: validateWebFetchInput,
  });
  r.register({
    name: "fetch_url",
    description: "Alias for web_fetch. Fetch a known HTTP/HTTPS URL and return content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        ref_id: { type: "string" },
        format: { type: "string", enum: ["markdown", "text", "raw"], default: "markdown" },
        max_bytes: { type: "integer", default: DEFAULT_MAX_BYTES, maximum: MAX_BYTES },
        timeout_ms: { type: "integer", default: DEFAULT_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
        json: { type: "boolean", default: false },
      },
    },
    execute: fetchExecute,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "web",
    parallelOk: true,
    deferLoading: true,
    readOnly: true,
    searchHint: "fetch url content",
    resultKind: "text",
    maxResultSizeChars: 120_000,
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
    validateInput: validateWebFetchInput,
  });
  r.register({
    name: "web_stats",
    description: "Show web search/fetch cache, engine health, latency, and failure statistics for this process.",
    parameters: { type: "object", properties: {} },
    execute: async () => safeJsonStringify(webStatsSnapshot({
      search: SEARCH_CACHE.size,
      fetch: FETCH_CACHE.size,
      refs: WEB_REFS.size,
    }), { space: 2 }),
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "web",
    parallelOk: true,
    readOnly: true,
    searchHint: "inspect web search fetch health telemetry cache",
    resultKind: "json",
  });
}
