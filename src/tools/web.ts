/** Web search and fetch tools. */

import * as cheerio from "cheerio";
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
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
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

function normalizeDomainList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isNumericLike(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

function isBoolLike(value: unknown): value is boolean | string {
  return typeof value === "boolean" || typeof value === "string";
}

function envString(name: string): string {
  return process.env[name]?.trim() || "";
}

function resolveWebConfig(config?: Partial<WebConfig>): ResolvedWebConfig {
  return {
    enabled: config?.enabled !== false,
    mode: config?.mode === "off" ? "off" : "live",
    searchEngine: normalizeSearchEngine(config?.search_engine),
    allowedDomains: normalizeDomainList(config?.allowed_domains),
    blockedDomains: normalizeDomainList(config?.blocked_domains),
    googleApiKey: typeof config?.google_api_key === "string" && config.google_api_key.trim()
      ? config.google_api_key.trim()
      : envString("GOOGLE_API_KEY"),
    googleCx: typeof config?.google_cx === "string" && config.google_cx.trim()
      ? config.google_cx.trim()
      : envString("GOOGLE_CSE_ID") || envString("GOOGLE_CX"),
    exaApiKey: typeof config?.exa_api_key === "string" && config.exa_api_key.trim()
      ? config.exa_api_key.trim()
      : envString("EXA_API_KEY"),
    kagiApiKey: typeof config?.kagi_api_key === "string" && config.kagi_api_key.trim()
      ? config.kagi_api_key.trim()
      : envString("KAGI_API_KEY"),
    braveApiKey: typeof config?.brave_api_key === "string" && config.brave_api_key.trim()
      ? config.brave_api_key.trim()
      : envString("BRAVE_SEARCH_API_KEY") || envString("BRAVE_API_KEY"),
    tavilyApiKey: typeof config?.tavily_api_key === "string" && config.tavily_api_key.trim()
      ? config.tavily_api_key.trim()
      : envString("TAVILY_API_KEY"),
    serperApiKey: typeof config?.serper_api_key === "string" && config.serper_api_key.trim()
      ? config.serper_api_key.trim()
      : envString("SERPER_API_KEY"),
    semanticScholarApiKey: typeof config?.semantic_scholar_api_key === "string" && config.semantic_scholar_api_key.trim()
      ? config.semantic_scholar_api_key.trim()
      : envString("SEMANTIC_SCHOLAR_API_KEY") || envString("S2_API_KEY"),
    pubmedApiKey: typeof config?.pubmed_api_key === "string" && config.pubmed_api_key.trim()
      ? config.pubmed_api_key.trim()
      : envString("PUBMED_API_KEY") || envString("NCBI_API_KEY"),
    searxngUrl: typeof config?.searxng_url === "string" && config.searxng_url.trim()
      ? config.searxng_url.trim().replace(/\/+$/, "")
      : envString("SEARXNG_URL").replace(/\/+$/, ""),
    proxy: typeof config?.proxy === "string" ? config.proxy.trim() : "",
    noProxy: normalizeDomainList(config?.no_proxy),
    searchTimeoutMs: asPositiveInt(config?.search_timeout_ms, DEFAULT_SEARCH_TIMEOUT_MS, MAX_TIMEOUT_MS),
    fetchTimeoutMs: asPositiveInt(config?.fetch_timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxBytes: asPositiveInt(config?.max_bytes, DEFAULT_MAX_BYTES, MAX_BYTES),
  };
}

function extractSearchQuery(args: Record<string, unknown>): string {
  for (const key of ["query", "q"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      for (const key of ["q", "query"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
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
    for (const item of searchQuery) {
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
    for (const item of searchQuery) {
      if (!item || typeof item !== "object") continue;
      const nested = normalizeDomainList((item as Record<string, unknown>).domains);
      if (nested.length) return nested;
    }
  }

  return [];
}

function extractSearchContextEnabled(args: Record<string, unknown>, searchType: SearchType): boolean {
  const direct = args.fetch_results ?? args.include_content ?? args.context;
  if (direct !== undefined) return asBool(direct, false);

  const searchQuery = args.search_query;
  if (Array.isArray(searchQuery)) {
    for (const item of searchQuery) {
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
    for (const item of searchQuery) {
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
    for (const item of searchQuery) {
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
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeWebSearchValidationArgs(args: Record<string, unknown>): Record<string, unknown> {
  const query = extractSearchQuery(args);
  const maxResults = extractSearchMaxResults(args);
  const domains = extractSearchDomains(args);
  const engine = normalizeSearchEngine(args.engine || args.source);
  const searchType = normalizeSearchType(args.type || args.search_type || args.searchType);
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
  const searchQuery = args.search_query;
  if (searchQuery !== undefined) {
    if (!Array.isArray(searchQuery)) return "search_query must be an array";
    for (const item of searchQuery) {
      if (!item || typeof item !== "object") return "search_query entries must be objects";
      const record = item as Record<string, unknown>;
      if (record.domains !== undefined && !isStringArray(record.domains)) {
        return "search_query domains must be an array of strings";
      }
    }
  }
  return null;
}

function validateWebSearchQueryArgs(args: Record<string, unknown>): string | null {
  for (const key of ["query", "q"] as const) {
    const value = args[key];
    if (value !== undefined && typeof value !== "string") return `${key} must be a string`;
  }

  const searchQuery = args.search_query;
  if (!Array.isArray(searchQuery)) return null;
  for (const item of searchQuery) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    for (const key of ["q", "query"] as const) {
      const value = record[key];
      if (value !== undefined && typeof value !== "string") return `search_query ${key} must be a string`;
    }
  }
  return null;
}

function validateWebSearchOptionArgs(args: Record<string, unknown>): string | null {
  for (const key of ["max_results", "timeout_ms", "context_results", "context_max_characters"]) {
    const value = args[key];
    if (value !== undefined && !isNumericLike(value)) return `${key} must be a number`;
  }
  for (const key of ["fetch_results", "include_content", "context", "json"]) {
    const value = args[key];
    if (value !== undefined && !isBoolLike(value)) return `${key} must be a boolean`;
  }
  for (const key of ["engine", "source", "type", "search_type", "searchType"]) {
    const value = args[key];
    if (value !== undefined && typeof value !== "string") return `${key} must be a string`;
  }

  const searchQuery = args.search_query;
  if (!Array.isArray(searchQuery)) return null;
  for (const item of searchQuery) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    for (const key of ["max_results", "context_results", "context_max_characters", "contextMaxCharacters", "contextResults"]) {
      const value = record[key];
      if (value !== undefined && !isNumericLike(value)) return `search_query ${key} must be a number`;
    }
    for (const key of ["fetch_results", "include_content", "context"]) {
      const value = record[key];
      if (value !== undefined && !isBoolLike(value)) return `search_query ${key} must be a boolean`;
    }
  }
  return null;
}

function validateWebSearchInput(args: Record<string, unknown>) {
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
    const value = args[key];
    if (value !== undefined && !isNumericLike(value)) return `${key} must be a number`;
  }
  for (const key of ["json", "extract_text"]) {
    const value = args[key];
    if (value !== undefined && !isBoolLike(value)) return `${key} must be a boolean`;
  }
  if (args.format !== undefined && typeof args.format !== "string") return "format must be a string";
  return null;
}

function validateWebFetchInput(args: Record<string, unknown>) {
  const optionError = validateWebFetchOptionArgs(args);
  if (optionError) return { ok: false as const, message: optionError };
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
  return results.map(result => ({ ...result }));
}

function cloneSearchOutcome(outcome: SearchOutcome): SearchOutcome {
  return {
    source: outcome.source,
    results: cloneSearchResults(outcome.results),
    failures: [...outcome.failures],
    telemetry: outcome.telemetry?.map(item => ({ ...item })),
    cacheHit: outcome.cacheHit,
  };
}

function cloneFetchResponse(resp: FetchResponse): FetchResponse {
  return { ...resp };
}

function compactSnippet(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized || undefined;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map(item => typeof item === "string" ? normalizeText(item) : "")
      .filter(Boolean)
      .join(" ");
    return normalized || undefined;
  }
  return undefined;
}

function compactScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function recordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function entryFromRecord(record: Record<string, unknown>, keys: { title: string[]; url: string[]; snippet: string[] }): SearchEntry | null {
  const rawUrl = recordValue(record, keys.url);
  if (typeof rawUrl !== "string" || !/^https?:\/\//i.test(rawUrl)) return null;
  const title = compactSnippet(recordValue(record, keys.title)) || rawUrl;
  return {
    title: title.slice(0, 180),
    url: rawUrl,
    snippet: compactSnippet(recordValue(record, keys.snippet)),
  };
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  options: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; config: ResolvedWebConfig },
): Promise<unknown> {
  const resp = await fetchText(url, timeoutMs, "application/json,text/json,*/*;q=0.2", {
    signal: options.signal,
    maxBytes: Math.min(DEFAULT_MAX_BYTES, options.config.maxBytes),
    retries: 1,
    config: options.config,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    method: options.method || (options.body === undefined ? "GET" : "POST"),
    body: options.body,
  });
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
  return JSON.stringify({
    query,
    maxResults,
    engine,
    searchType,
    blockedDomains: [...config.blockedDomains].sort(),
    google: Boolean(config.googleApiKey && config.googleCx),
    googleCx: config.googleCx,
    exa: Boolean(config.exaApiKey),
    kagi: Boolean(config.kagiApiKey),
    brave: Boolean(config.braveApiKey),
    tavily: Boolean(config.tavilyApiKey),
    serper: Boolean(config.serperApiKey),
    semanticScholar: Boolean(config.semanticScholarApiKey),
    pubmed: Boolean(config.pubmedApiKey),
    searxng: config.searxngUrl,
    proxy: config.proxy,
    noProxy: [...config.noProxy].sort(),
  });
}

function fetchCacheKey(url: string, accept: string, maxBytes: number, config?: ResolvedWebConfig, method = "GET", body?: unknown): string {
  return JSON.stringify({
    url,
    accept,
    maxBytes,
    method,
    body: body === undefined ? undefined : body,
    allowedDomains: [...(config?.allowedDomains || [])].sort(),
    blockedDomains: [...(config?.blockedDomains || [])].sort(),
    proxy: config?.proxy || "",
    noProxy: [...(config?.noProxy || [])].sort(),
  });
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
  for (const part of value.slice(marker + 1).split("&")) {
    const [name, raw = ""] = part.split("=", 2);
    if (name === key) return raw;
  }
  return null;
}

function normalizeDuckUrl(href: string): string {
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
    if (/^https?:\/\//.test(decoded)) return decoded;
  }
  const bingEncoded = queryParam(href, "u");
  if (bingEncoded) {
    const decoded = normalizeBingUrl(href);
    if (/^https?:\/\//.test(decoded)) return decoded;
  }
  try {
    const url = new URL(href, baseUrl).toString();
    if (!/^https?:\/\//.test(url)) return null;
    return url;
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
    if (title && href) results.push({ title, url: normalizeDuckUrl(href), snippet: snippet || undefined });
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
    const host = parsed.hostname.toLowerCase();
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
    const url = normalizeBingUrl(href);
    const snippet = extractBingSnippet($, el);
    if (title && href && !isInternalSearchUrl(url)) results.push({ title, url, snippet: snippet || undefined });
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
      const url = href.startsWith("//") ? `https:${href}` : href.startsWith("/") ? `https://www.baidu.com${href}` : href;
      results.push({ title, url, snippet: snippet && snippet !== title ? snippet : undefined });
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
    if (!url || seen.has(url)) return undefined;
    seen.add(url);
    results.push({ title: title.slice(0, 160), url });
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
  const message = formatFetchError(error).toLowerCase();
  return /fetch failed|network|timeout|timed? out|econnreset|econnrefused|enotfound|eai_again|socket|tls|terminated/.test(message);
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  if (cause?.code || cause?.message) {
    return `${error.message}${cause.code ? ` (${cause.code})` : ""}${cause.message ? `: ${cause.message}` : ""}`;
  }
  return error.message;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

function makeAbortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function fetchTextOnce(
  url: string,
  timeoutMs: number,
  accept: string,
  options: { signal?: AbortSignal; maxBytes?: number; validateRedirect?: (url: string) => Promise<void>; config?: ResolvedWebConfig; headers?: Record<string, string>; method?: "GET" | "POST"; body?: unknown } = {},
): Promise<FetchResponse> {
  if (options.signal?.aborted) throw makeAbortError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    let current = url;
    let resp: Response | null = null;
    let method = options.method || "GET";
    let body = options.body;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const dispatcher = dispatcherForUrl(current, options.config);
      resp = await fetch(current, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
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
      if (![301, 302, 303, 307, 308].includes(resp.status)) break;
      const location = resp.headers.get("location");
      if (!location) break;
      current = new URL(location, current).toString();
      await options.validateRedirect?.(current);
      if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      if (redirects === MAX_REDIRECTS) throw new Error(`too many redirects (${MAX_REDIRECTS})`);
    }
    if (!resp) throw new Error("request failed before response");
    const { text, truncated } = await readResponseText(resp, options.maxBytes || DEFAULT_MAX_BYTES);
    return {
      status: resp.status,
      url: resp.url || current,
      contentType: resp.headers.get("content-type") || "application/octet-stream",
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
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  if (options.signal?.aborted) throw makeAbortError();
  WEB_STATS.fetch_calls++;
  const shouldCache = options.cache !== false;
  const cacheKey = shouldCache ? fetchCacheKey(url, accept, maxBytes, options.config, options.method || "GET", options.body) : "";
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
      const response = await withHostConcurrency(url, () => fetchTextOnce(url, timeoutMs, accept, options));
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

async function readResponseText(resp: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const cap = Math.max(1, Math.min(maxBytes, MAX_BYTES));
  if (!resp.body) {
    const text = await resp.text();
    return { text: text.slice(0, cap), truncated: text.length > cap };
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
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
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncated };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function domainMatches(hostname: string, patterns: string[]): boolean {
  const host = hostWithoutBrackets(hostname).replace(/\.$/, "");
  return patterns.some(pattern => {
    const normalized = pattern.toLowerCase().replace(/^\*\./, ".").replace(/\.$/, "");
    if (!normalized) return false;
    if (normalized.startsWith(".")) return host.endsWith(normalized) || host === normalized.slice(1);
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function noProxyMatches(hostname: string, patterns: string[]): boolean {
  const envNoProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  return domainMatches(hostname, [
    ...patterns,
    ...envNoProxy.split(",").map(item => item.trim()).filter(Boolean),
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
  if (noProxyMatches(parsed.hostname, config?.noProxy || [])) return SAFE_DISPATCHER;
  const hasEnvProxy = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
  if (!hasEnvProxy) return SAFE_DISPATCHER;
  if (ENV_DISPATCHER === undefined) ENV_DISPATCHER = new EnvHttpProxyAgent();
  return ENV_DISPATCHER || undefined;
}

async function searchDuckDuckGo(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl("https://html.duckduckgo.com/", { ...config, allowedDomains: [] });
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetchText(url, timeoutMs, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", { signal, maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes), retries: 1, config });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`DuckDuckGo HTTP ${resp.status}`);
  const results = parseDuckResults(resp.text, maxResults);
  if (!results.length && isDuckChallenge(resp.text)) throw new Error("DuckDuckGo returned a bot challenge");
  return results.length ? results : parseGenericResults(resp.text, resp.url, maxResults);
}

async function searchBing(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl("https://www.bing.com/", { ...config, allowedDomains: [] });
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setmkt=en-US`;
  const resp = await fetchText(url, timeoutMs, BING_SEARCH_HEADERS.Accept, {
    signal,
    maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes),
    retries: 1,
    config,
    headers: BING_SEARCH_HEADERS,
  });
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
  const payload = await fetchJson(url.toString(), timeoutMs, {
    signal,
    config,
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": config.braveApiKey,
    },
  });
  const web = payload && typeof payload === "object" ? (payload as Record<string, unknown>).web : undefined;
  const items = web && typeof web === "object" ? (web as Record<string, unknown>).results : undefined;
  if (!Array.isArray(items)) return [];
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
  const payload = await fetchJson(TAVILY_SEARCH_URL, timeoutMs, {
    signal,
    config,
    method: "POST",
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
  });
  const items = payload && typeof payload === "object" ? (payload as Record<string, unknown>).results : undefined;
  if (!Array.isArray(items)) return [];
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
  const payload = await fetchJson(SERPER_SEARCH_URL, timeoutMs, {
    signal,
    config,
    method: "POST",
    headers: {
      "X-API-KEY": config.serperApiKey,
    },
    body: {
      q: query,
      num: maxResults,
    },
  });
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const organic = Array.isArray(record.organic) ? record.organic : [];
  const news = Array.isArray(record.news) ? record.news : [];
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
  const payload = await fetchJson(url.toString(), timeoutMs, {
    signal,
    config,
    headers: { "Accept": "application/json" },
  });
  const items = payload && typeof payload === "object" ? (payload as Record<string, unknown>).items : undefined;
  if (!Array.isArray(items)) return [];
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
  const payload = await fetchJson(EXA_SEARCH_URL, timeoutMs, {
    signal,
    config,
    method: "POST",
    headers: {
      "x-api-key": config.exaApiKey,
    },
    body: {
      query,
      numResults: maxResults,
      type: "auto",
      useAutoprompt: true,
    },
  });
  const items = payload && typeof payload === "object" ? (payload as Record<string, unknown>).results : undefined;
  if (!Array.isArray(items)) return [];
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
  const payload = await fetchJson(url.toString(), timeoutMs, {
    signal,
    config,
    headers: {
      "Authorization": `Bot ${config.kagiApiKey}`,
      "Accept": "application/json",
    },
  });
  const rawData = payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : undefined;
  let items: unknown[] = [];
  if (Array.isArray(rawData)) {
    items = rawData;
  } else if (rawData && typeof rawData === "object") {
    const nested = (rawData as Record<string, unknown>).results;
    if (Array.isArray(nested)) items = nested;
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
  const resp = await fetchText(url.toString(), timeoutMs, "application/atom+xml,application/xml,text/xml,*/*;q=0.5", {
    signal,
    maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes),
    retries: 1,
    config,
  });
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
    if (title && /^https?:\/\//.test(htmlLink)) {
      results.push({ title, url: htmlLink, snippet: summary || undefined });
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
  const payload = await fetchJson(url.toString(), timeoutMs, {
    signal,
    config,
    headers: {
      "Accept": "application/json",
      ...(config.semanticScholarApiKey ? { "x-api-key": config.semanticScholarApiKey } : {}),
    },
  });
  const items = payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : undefined;
  if (!Array.isArray(items)) return [];
  return items
    .map(item => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const entry = entryFromRecord(record, { title: ["title"], url: ["url"], snippet: ["abstract"] });
      if (!entry) return null;
      const year = compactScalar(record.year) || "";
      const venue = typeof record.venue === "string" ? record.venue : "";
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
  const searchPayload = await fetchJson(searchUrl.toString(), timeoutMs, {
    signal,
    config,
    headers: { "Accept": "application/json" },
  });
  const esearch = searchPayload && typeof searchPayload === "object" ? (searchPayload as Record<string, unknown>).esearchresult : undefined;
  const rawIds = esearch && typeof esearch === "object" ? (esearch as Record<string, unknown>).idlist : undefined;
  const ids: string[] = Array.isArray(rawIds)
    ? rawIds
      .map(id => compactScalar(id))
      .filter((id): id is string => Boolean(id))
      .slice(0, maxResults)
    : [];
  if (!ids.length) return [];

  const summaryUrl = new URL(PUBMED_ESUMMARY_URL);
  summaryUrl.searchParams.set("db", "pubmed");
  summaryUrl.searchParams.set("id", ids.join(","));
  summaryUrl.searchParams.set("retmode", "json");
  if (config.pubmedApiKey) summaryUrl.searchParams.set("api_key", config.pubmedApiKey);
  const summaryPayload = await fetchJson(summaryUrl.toString(), timeoutMs, {
    signal,
    config,
    headers: { "Accept": "application/json" },
  });
  const result = summaryPayload && typeof summaryPayload === "object" ? (summaryPayload as Record<string, unknown>).result : undefined;
  const records = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const entries: Array<SearchEntry | null> = ids.map((id: string) => {
    const record = records[id];
    if (!record || typeof record !== "object") return null;
    const data = record as Record<string, unknown>;
    const title = compactSnippet(data.title) || `PubMed ${id}`;
    const source = compactSnippet(data.source);
    const pubdate = compactSnippet(data.pubdate);
    return {
      title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      snippet: [source, pubdate].filter(Boolean).join(" "),
    };
  });
  return entries.filter((item): item is SearchEntry => Boolean(item)).slice(0, maxResults);
}

async function searchBaidu(query: string, maxResults: number, timeoutMs: number, config: ResolvedWebConfig, signal?: AbortSignal): Promise<SearchEntry[]> {
  await assertPublicUrl(BAIDU_SEARCH_URL, { ...config, allowedDomains: [] });
  const url = new URL(BAIDU_SEARCH_URL);
  url.searchParams.set("wd", query);
  const resp = await fetchText(url.toString(), timeoutMs, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", {
    signal,
    maxBytes: Math.min(DEFAULT_MAX_BYTES, config.maxBytes),
    retries: 1,
    config,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    },
  });
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
  const payload = await fetchJson(url.toString(), timeoutMs, {
    signal,
    config,
    headers: { "Accept": "application/json" },
  });
  const items = payload && typeof payload === "object" ? (payload as Record<string, unknown>).results : undefined;
  if (!Array.isArray(items)) return [];
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
    recordEngineHealth(candidate.source, false);
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
    WEB_REFS.set(ref_id, {
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      source,
      query,
      createdAt: Date.now(),
    });
    pruneRefs();
    return { ...result, ref_id };
  });
}

function filterSearchResults(results: SearchEntry[], allowedDomains: string[], blockedDomains: string[]): SearchEntry[] {
  return results.filter(result => {
    try {
      const hostname = new URL(result.url).hostname;
      if (blockedDomains.length && domainMatches(hostname, blockedDomains)) return false;
      if (allowedDomains.length && !domainMatches(hostname, allowedDomains)) return false;
      return true;
    } catch {
      return false;
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
  const domainError = validateWebSearchDomainArgs(args);
  if (domainError) return `Error searching: ${domainError}.`;
  const optionError = validateWebSearchOptionArgs(args);
  if (optionError) return `Error searching: ${optionError}.`;
  const query = extractSearchQuery(args);
  if (!query) return "Error searching: query is required.";

  if (!config.enabled || config.mode === "off") return "Error searching: web tools are disabled by configuration.";
  const maxResults = extractSearchMaxResults(args);
  const timeoutMs = asPositiveInt(args.timeout_ms, config.searchTimeoutMs, MAX_TIMEOUT_MS);
  const engine = normalizeSearchEngine(args.engine || args.source || config.searchEngine);
  const searchType = normalizeSearchType(args.type || args.search_type || args.searchType);
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
      ? JSON.stringify({ query, source: "", count: 0, results: [], failures: ["requested domains are outside web.allowed_domains"], message: `No results for '${query}'` }, null, 2)
      : `No results for '${query}'. Tried requested domains but they are outside web.allowed_domains`;
  }
  const searchQuery = effectiveAllowedDomains.length
    ? `${query} ${effectiveAllowedDomains.map(domain => `site:${domain.replace(/^\*\./, "").replace(/^\./, "")}`).join(" OR ")}`
    : query;
  const { source, results: rawResults, failures, telemetry, cacheHit } = await searchWithFallback(searchQuery, maxResults, timeoutMs, engine, searchType, config, signal);
  const filteredResults = filterSearchResults(rawResults, effectiveAllowedDomains, config.blockedDomains);
  const contextualResults = includeContent
    ? await attachResultContent(filteredResults, config, { contextResults, contextMaxCharacters, timeoutMs, signal })
    : filteredResults;
  const results = assignRefs(query, source, contextualResults);

  if (!results.length) {
    const payload = { query, source: "", count: 0, results: [], failures, telemetry, cache_hit: Boolean(cacheHit), message: `No results for '${query}'` };
    return jsonOutput ? JSON.stringify(payload, null, 2) : `No results for '${query}'. Tried ${failures.join(" | ") || "no engines"}`;
  }

  if (jsonOutput) {
    return JSON.stringify({
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
    }, null, 2);
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
  const [a, b] = parts as [number, number, number, number];
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

function isRestrictedIPv6(ip: string): boolean {
  const normalized = hostWithoutBrackets(ip);
  const expanded = expandIPv6Address(normalized);
  if (!expanded) return true;
  const first = expanded[0]!;
  if (expanded.every(part => part === 0)) return true;
  if (expanded.slice(0, 7).every(part => part === 0) && expanded[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (expanded.slice(0, 6).every(part => part === 0)) {
    const v4 = [
      (expanded[6]! >> 8) & 255,
      expanded[6]! & 255,
      (expanded[7]! >> 8) & 255,
      expanded[7]! & 255,
    ].join(".");
    return isRestrictedIPv4(v4);
  }
  if (expanded.slice(0, 5).every(part => part === 0) && expanded[5] === 0xffff) {
    const v4 = [
      (expanded[6]! >> 8) & 255,
      expanded[6]! & 255,
      (expanded[7]! >> 8) & 255,
      expanded[7]! & 255,
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
        const [a, b, c, d] = chunk.split(".").map(part => Number.parseInt(part, 10));
        if ([a, b, c, d].some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
        parsed.push(((a! << 8) | b!), ((c! << 8) | d!));
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
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http:// and https:// URLs are supported");
  }
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
  const normalized = content.replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[content truncated]`;
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
      const resp = await fetchText(parsed.toString(), options.timeoutMs, "text/html,text/plain,application/json,application/xml,*/*;q=0.8", {
        signal: options.signal,
        maxBytes: Math.min(config.maxBytes, SEARCH_FETCH_MAX_BYTES),
        retries: 0,
        config,
        validateRedirect: async (url) => { await assertPublicUrl(url, config); },
      });
      if (resp.status < 200 || resp.status >= 400) {
        enriched[index] = { ...result, content_error: `HTTP ${resp.status}` };
        return;
      }
      const content = processBody(resp.text, resp.contentType, "markdown");
      const trimmed = trimForContext(content, charsPerResult);
      enriched[index] = {
        ...result,
        content: trimmed,
        content_profile: contentProfile(resp.text, resp.contentType, trimmed, resp.truncated),
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
    return JSON.stringify({
      url: resp.url,
      status: resp.status,
      content_type: resp.contentType,
      truncated: resp.truncated,
      content_profile: profile,
      content,
    }, null, 2);
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
  const optionError = validateWebFetchOptionArgs(args);
  if (optionError) return `Error fetching URL: ${optionError}.`;
  if (!config.enabled || config.mode === "off") return "Error fetching URL: web tools are disabled by configuration.";
  const refId = extractRefId(args);
  const ref = refId ? WEB_REFS.get(refId) : undefined;
  if (refId && !ref) return `Error fetching URL: unknown ref_id '${refId}'. Run web_search first or pass url directly.`;
  const rawUrl = typeof args.url === "string" && args.url.trim() ? args.url.trim() : ref?.url || "";
  if (!rawUrl) return "Error fetching URL: url is required.";

  const format = normalizeFetchFormat(args);
  const jsonOutput = asBool(args.json, false);
  const timeoutMs = asPositiveInt(args.timeout_ms, config.fetchTimeoutMs, MAX_TIMEOUT_MS);
  const maxBytes = asPositiveInt(args.max_bytes, config.maxBytes, MAX_BYTES);

  try {
    const parsed = await assertPublicUrl(rawUrl, config);
    const resp = await fetchText(parsed.toString(), timeoutMs, "text/html,text/plain,application/json,application/xml,*/*;q=0.8", {
      signal,
      maxBytes,
      retries: 1,
      config,
      validateRedirect: async (url) => { await assertPublicUrl(url, config); },
    });
    const content = processBody(resp.text, resp.contentType, format).slice(0, maxBytes);
    return formatFetchResult(resp, content, jsonOutput, contentProfile(resp.text, resp.contentType, content, resp.truncated));
  } catch (error) {
    return `Error fetching URL: ${formatFetchError(error)}`;
  }
}

export function registerWebTools(configInput?: Partial<WebConfig>): void {
  const r = getRegistry();
  const webConfig = resolveWebConfig(configInput);
  const searchExecute = (args: Record<string, unknown>, context?: ToolExecutionContext) =>
    webSearchWithConfig(args, webConfig, context?.signal);
  const fetchExecute = (args: Record<string, unknown>, context?: ToolExecutionContext) =>
    webFetchWithConfig(args, webConfig, context?.signal);
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
    execute: async () => JSON.stringify(webStatsSnapshot({
      search: SEARCH_CACHE.size,
      fetch: FETCH_CACHE.size,
      refs: WEB_REFS.size,
    }), null, 2),
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "web",
    parallelOk: true,
    readOnly: true,
    searchHint: "inspect web search fetch health telemetry cache",
    resultKind: "json",
  });
}
