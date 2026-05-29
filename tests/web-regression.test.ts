import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contentProfile, normalizeText, processBody } from "../src/tools/web/extract.js";
import { getRegistry } from "../src/tools/registry.js";
import { registerWebTools } from "../src/tools/web.js";

let oldHttpProxy: string | undefined;
let oldHttpsProxy: string | undefined;
let oldNoProxy: string | undefined;

beforeEach(() => {
  oldHttpProxy = process.env.HTTP_PROXY;
  oldHttpsProxy = process.env.HTTPS_PROXY;
  oldNoProxy = process.env.NO_PROXY;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  getRegistry().clear();
  registerWebTools();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (oldHttpProxy === undefined) delete process.env.HTTP_PROXY;
  else process.env.HTTP_PROXY = oldHttpProxy;
  if (oldHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = oldHttpsProxy;
  if (oldNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = oldNoProxy;
});

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

describe("web tools", () => {
  it("sanitizes extracted text repeatedly and safely formats structured text", () => {
    expect(normalizeText("one\u0000two")).toBe("one two");
    expect(normalizeText("three\u0007four")).toBe("three four");

    const formatted = processBody("{\"count\":1,\"nested\":{\"ok\":true}}", "application/json", "text");
    const malformed = processBody("{\"bad\":\"value\u0000\"", "application/json", "text");

    expect(formatted).toContain("\"count\": 1");
    expect(formatted).toContain("\"ok\": true");
    expect(malformed).toContain("value ");
    expect(formatted).not.toContain("\u0000");
    expect(malformed).not.toContain("\u0000");
  });

  it("bounds HTML extraction and profile analysis on very large pages", () => {
    const html = `<html><head><title>${"T".repeat(700)}</title></head><body><main><p>${"word ".repeat(500_000)}</p></main></body></html>`;
    const markdown = processBody(html, "text/html", "markdown");
    const profile = contentProfile(html, "text/html", markdown, false);

    expect(markdown.length).toBeLessThanOrEqual(2_100_000);
    expect(profile.truncated).toBe(true);
    expect(profile.title?.length).toBe(500);
    expect(profile.word_count).toBeGreaterThan(0);
  });

  it("preserves Unicode boundaries while bounding large extracted pages", () => {
    const title = `${"T".repeat(499)}👩‍💻 developer`;
    const html = `<html><head><title>${title}</title></head><body><main><p>${"a".repeat(1_999_999)}😀tail</p></main></body></html>`;
    const markdown = processBody(html, "text/html", "markdown");
    const profile = contentProfile(html, "text/html", markdown, false);

    expect(profile.title).toBe("T".repeat(499));
    expect(markdown).not.toContain("\uFFFD");
    expect(hasUnpairedSurrogate(markdown)).toBe(false);
    expect(hasUnpairedSurrogate(profile.title ?? "")).toBe(false);
  });

  it("fails closed for non-string extraction inputs", () => {
    expect(normalizeText({ value: "ignored" } as any)).toBe("");
    expect(processBody({ value: "ignored" } as any, { toString: () => { throw new Error("bad content type"); } } as any, "text")).toBe("");
    expect(processBody({ raw: true } as any, "text/plain", "raw")).toBe("");

    const profile = contentProfile({ value: "ignored" } as any, { nested: true } as any, { text: "ignored" } as any, true);

    expect(profile).toEqual({
      format: "text",
      character_count: 0,
      word_count: 0,
      truncated: true,
    });
  });

  it("bounds markdown table conversion and readable-root candidates", () => {
    const rows = Array.from({ length: 250 }, (_, row) =>
      `<tr>${Array.from({ length: 30 }, (_, cell) => `<td>${row}-${cell}</td>`).join("")}</tr>`
    ).join("");
    const ignoredLateCandidate = `<main><h1>Late Candidate</h1><p>${"late ".repeat(200)}</p></main>`;
    const html = `<html><body><main><table>${rows}</table></main>${Array.from({ length: 220 }, (_, index) => `<article>noise ${index}</article>`).join("")}${ignoredLateCandidate}</body></html>`;

    const markdown = processBody(html, "text/html", "markdown");

    expect(markdown).toContain("0-0 | 0-1");
    expect(markdown).toContain("199-0");
    expect(markdown).not.toContain("0-20");
    expect(markdown).not.toContain("200-0");
    expect(markdown).not.toContain("Late Candidate");
  });

  it("uses configured Google Custom Search results", async () => {
    getRegistry().clear();
    registerWebTools({ google_api_key: "google-key", google_cx: "cx-id" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("www.googleapis.com/customsearch/v1");
      expect(url).toContain("key=google-key");
      expect(url).toContain("cx=cx-id");
      expect(url).toContain("q=google+query");
      return new Response(JSON.stringify({
        items: [
          { title: "Google Result", link: "https://example.com/google", snippet: "Google snippet" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "google query", engine: "google" });

    expect(result).toContain("Source: Google");
    expect(result).toContain("Google Result");
    expect(result).toContain("Google snippet");
  });

  it("bounds and sanitizes search result fields before rendering and ref fetches", async () => {
    getRegistry().clear();
    registerWebTools({ google_api_key: "google-key", google_cx: "cx-id" });
    const longTitle = `Dirty\u0000Title ${"x".repeat(3000)}`;
    const longSnippet = `Dirty\u0007Snippet ${"y".repeat(3000)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("www.googleapis.com")) {
        return new Response(JSON.stringify({
          items: [
            { title: longTitle, link: "https://example.com/dirty", snippet: longSnippet },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://example.com/dirty") {
        return new Response("<html><body><h1>Clean fetched page</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "dirty result", engine: "google" });
    const ref = result.match(/ref_id: (web_[a-z0-9]+)/)?.[1];
    const fetched = await getRegistry().lookup("web_fetch")!.execute({ ref_id: ref });

    expect(result).toContain("Dirty Title");
    expect(result).not.toContain("\u0000");
    expect(result).not.toContain("\u0007");
    expect(result).not.toContain("x".repeat(2500));
    expect(result).not.toContain("y".repeat(2500));
    expect(fetched).toContain("Clean fetched page");
  });

  it("clips fetched response bodies on UTF-8 boundaries", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("x".repeat(9) + "😀tail", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    const result = await getRegistry().lookup("web_fetch")!.execute({
      url: "https://example.com/unicode-boundary",
      max_bytes: 10,
    });

    expect(result).toContain("x".repeat(9));
    expect(result).not.toContain("\uFFFD");
    expect(result).not.toContain("tail");
    expect(hasUnpairedSurrogate(result)).toBe(false);
  });

  it("uses configured Exa search results", async () => {
    getRegistry().clear();
    registerWebTools({ exa_api_key: "exa-key" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://api.exa.ai/search");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("exa-key");
      expect(JSON.parse(String(init?.body)).query).toBe("exa query");
      return new Response(JSON.stringify({
        results: [
          { title: "Exa Result", url: "https://example.com/exa", text: "Exa snippet" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "exa query", engine: "exa" });

    expect(result).toContain("Source: Exa");
    expect(result).toContain("Exa Result");
    expect(result).toContain("Exa snippet");
  });

  it("serializes JSON POST bodies through the safe serializer", async () => {
    getRegistry().clear();
    registerWebTools({ exa_api_key: "exa-key" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://api.exa.ai/search");
      const parsed = JSON.parse(String(init?.body));
      expect(parsed).toMatchObject({ query: "exa query", numResults: 5 });
      return new Response(JSON.stringify({
        results: [
          { title: "Exa Result", url: "https://example.com/exa", text: "Exa snippet" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "exa query", engine: "exa" });

    expect(result).toContain("Source: Exa");
    expect(result).toContain("Exa Result");
  });

  it("uses configured Kagi search results", async () => {
    getRegistry().clear();
    registerWebTools({ kagi_api_key: "kagi-key" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      expect(url).toContain("kagi.com/api/v0/search");
      expect(url).toContain("q=kagi+query");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bot kagi-key");
      return new Response(JSON.stringify({
        data: [
          { title: "Kagi Result", url: "https://example.com/kagi", snippet: "Kagi snippet" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "kagi query", engine: "kagi" });

    expect(result).toContain("Source: Kagi");
    expect(result).toContain("Kagi Result");
    expect(result).toContain("Kagi snippet");
  });

  it("uses arXiv Atom search results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("export.arxiv.org/api/query");
      expect(url).toContain("search_query=cat%3Acs.AI");
      return new Response(`
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>https://arxiv.org/abs/2401.00001</id>
            <title>Example arXiv Paper</title>
            <summary>Paper summary text.</summary>
            <link href="https://arxiv.org/abs/2401.00001" rel="alternate" type="text/html" />
          </entry>
        </feed>
      `, { status: 200, headers: { "content-type": "application/atom+xml" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "cat:cs.AI", engine: "arxiv" });

    expect(result).toContain("Source: arXiv");
    expect(result).toContain("Example arXiv Paper");
    expect(result).toContain("Paper summary text.");
    expect(result).toContain("https://arxiv.org/abs/2401.00001");
  });

  it("uses Semantic Scholar paper search results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("api.semanticscholar.org/graph/v1/paper/search");
      expect(url).toContain("query=semantic+query");
      return new Response(JSON.stringify({
        data: [
          {
            title: "Semantic Scholar Paper",
            url: "https://www.semanticscholar.org/paper/abc",
            abstract: "Semantic Scholar abstract",
            year: 2026,
            venue: "ICML",
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "semantic query", engine: "semantic_scholar" });

    expect(result).toContain("Source: Semantic Scholar");
    expect(result).toContain("Semantic Scholar Paper");
    expect(result).toContain("2026 ICML");
    expect(result).toContain("Semantic Scholar abstract");
  });

  it("skips malformed Semantic Scholar years instead of stringifying objects", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: [
        {
          title: "Semantic Scholar Paper",
          url: "https://www.semanticscholar.org/paper/abc",
          abstract: "Semantic Scholar abstract",
          year: { value: 2026 },
          venue: "ICML",
        },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await getRegistry().lookup("web_search")!.execute({ query: "semantic query", engine: "semantic_scholar" });

    expect(result).toContain("Source: Semantic Scholar");
    expect(result).toContain("Semantic Scholar Paper");
    expect(result).toContain("ICML - Semantic Scholar abstract");
    expect(result).not.toContain("[object Object]");
  });

  it("uses PubMed E-utilities search results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) {
        expect(url).toContain("term=pubmed+query");
        return new Response(JSON.stringify({ esearchresult: { idlist: ["123", "456"] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("esummary.fcgi")) {
        expect(url).toContain("id=123%2C456");
        return new Response(JSON.stringify({
          result: {
            uids: ["123", "456"],
            "123": { title: "PubMed Result One", source: "Nature", pubdate: "2026 Jan" },
            "456": { title: "PubMed Result Two", source: "Science", pubdate: "2025 Dec" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "pubmed query", engine: "pubmed", max_results: 2 });

    expect(result).toContain("Source: PubMed");
    expect(result).toContain("PubMed Result One");
    expect(result).toContain("https://pubmed.ncbi.nlm.nih.gov/123");
    expect(result).toContain("Nature 2026 Jan");
  });

  it("skips malformed PubMed ids instead of building fake URLs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) {
        return new Response(JSON.stringify({ esearchresult: { idlist: ["123", "abc", "9".repeat(40), { bad: true }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("esummary.fcgi")) {
        expect(url).toContain("id=123");
        expect(url).not.toContain("abc");
        expect(url).not.toContain("999999999999");
        expect(url).not.toContain("%5Bobject+Object%5D");
        return new Response(JSON.stringify({
          result: {
            uids: ["123"],
            "123": { title: "PubMed Result One", source: "Nature", pubdate: "2026 Jan" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "pubmed query", engine: "pubmed", max_results: 2 });

    expect(result).toContain("Source: PubMed");
    expect(result).toContain("https://pubmed.ncbi.nlm.nih.gov/123");
    expect(result).not.toContain("[object Object]");
    expect(result).not.toContain("https://pubmed.ncbi.nlm.nih.gov/[object Object]/");
  });

  it("uses Baidu HTML search results when explicitly selected", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("www.baidu.com/s");
      expect(url).toContain("wd=baidu+query");
      return new Response(`
        <html><body>
          <div class="result">
            <h3><a href="https://example.com/baidu">Baidu Result</a></h3>
            <div class="c-abstract">Baidu snippet</div>
          </div>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "baidu query", engine: "baidu" });

    expect(result).toContain("Source: Baidu");
    expect(result).toContain("Baidu Result");
    expect(result).toContain("Baidu snippet");
  });

  it("uses configured Brave search results", async () => {
    getRegistry().clear();
    registerWebTools({ brave_api_key: "brave-key" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      expect(url).toContain("api.search.brave.com/res/v1/web/search");
      expect(url).toContain("q=brave+query");
      expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brave-key");
      return new Response(JSON.stringify({
        web: {
          results: [
            { title: "Brave Result", url: "https://example.com/brave", description: "Brave snippet" },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "brave query", engine: "brave" });

    expect(result).toContain("Source: Brave");
    expect(result).toContain("Brave Result");
    expect(result).toContain("Brave snippet");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores overlong or control-character API keys from config and env", async () => {
    try {
      process.env.BRAVE_API_KEY = "env-brave-key";
      getRegistry().clear();
      registerWebTools({ brave_api_key: "bad\u0000key" });
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("env-brave-key");
        return new Response(JSON.stringify({
          web: { results: [{ title: "Env Brave Result", url: "https://example.com/env-brave" }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      const result = await getRegistry().lookup("web_search")!.execute({ query: "env key", engine: "brave" });

      expect(result).toContain("Env Brave Result");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.BRAVE_API_KEY;
      getRegistry().clear();
      registerWebTools();
    }
  });

  it("ignores hostile web config getters when registering tools", async () => {
    try {
      process.env.BRAVE_API_KEY = "env-brave-key";
      const config: Record<string, unknown> = {};
      Object.defineProperty(config, "brave_api_key", {
        enumerable: true,
        get() {
          throw new Error("config getter failed");
        },
      });
      Object.defineProperty(config, "allowed_domains", {
        enumerable: true,
        get() {
          throw new Error("domains getter failed");
        },
      });
      getRegistry().clear();
      expect(() => registerWebTools(config as any)).not.toThrow();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
        web: { results: [{ title: "Env Config Result", url: "https://example.com/env-config" }] },
      }), { status: 200, headers: { "content-type": "application/json" } }));

      const result = await getRegistry().lookup("web_search")!.execute({ query: "config", engine: "brave" });

      expect(result).toContain("Env Config Result");
      expect(result).not.toContain("config getter failed");
    } finally {
      delete process.env.BRAVE_API_KEY;
      getRegistry().clear();
      registerWebTools();
    }
  });

  it("uses configured Tavily search results", async () => {
    getRegistry().clear();
    registerWebTools({ tavily_api_key: "tavily-key" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://api.tavily.com/search");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tavily-key");
      expect(JSON.parse(String(init?.body)).query).toBe("tavily query");
      return new Response(JSON.stringify({
        results: [
          { title: "Tavily Result", url: "https://example.com/tavily", content: "Tavily content snippet" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "tavily query", engine: "tavily" });

    expect(result).toContain("Source: Tavily");
    expect(result).toContain("Tavily Result");
    expect(result).toContain("Tavily content snippet");
  });

  it("uses configured Serper search results", async () => {
    getRegistry().clear();
    registerWebTools({ serper_api_key: "serper-key" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://google.serper.dev/search");
      expect((init?.headers as Record<string, string>)["X-API-KEY"]).toBe("serper-key");
      expect(JSON.parse(String(init?.body)).q).toBe("serper query");
      return new Response(JSON.stringify({
        organic: [
          { title: "Serper Result", link: "https://example.com/serper", snippet: "Serper snippet" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "serper query", engine: "serper" });

    expect(result).toContain("Source: Serper");
    expect(result).toContain("Serper Result");
    expect(result).toContain("Serper snippet");
  });

  it("uses configured SearXNG search results", async () => {
    getRegistry().clear();
    registerWebTools({ searxng_url: "https://search.example" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("https://search.example/search");
      expect(url).toContain("format=json");
      return new Response(JSON.stringify({
        results: [
          { title: "SearXNG Result", url: "https://example.com/searxng", content: "SearXNG snippet" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "searxng query", engine: "searxng" });

    expect(result).toContain("Source: SearXNG");
    expect(result).toContain("SearXNG Result");
    expect(result).toContain("SearXNG snippet");
  });

  it("auto search prefers configured API engines before scraper fallback", async () => {
    getRegistry().clear();
    registerWebTools({ google_api_key: "google-key", google_cx: "cx-id", exa_api_key: "exa-key", brave_api_key: "brave-key" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("www.googleapis.com")) {
        return new Response(JSON.stringify({
          items: [{ title: "Auto Google", link: "https://example.com/auto-google" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("api.search.brave.com")) {
        return new Response(JSON.stringify({
          web: { results: [{ title: "Auto Brave", url: "https://example.com/auto-brave" }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "auto brave" });

    expect(result).toContain("Source: Google");
    expect(result).toContain("Auto Google");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports missing API key for explicitly selected API engines", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));

    const result = await getRegistry().lookup("web_search")!.execute({ query: "missing key", engine: "brave" });

    expect(result).toContain("No results for 'missing key'");
    expect(result).toContain("Brave API key is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not open engine circuits for missing API-key configuration", async () => {
    getRegistry().clear();
    registerWebTools();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("duckduckgo.com")) {
        return new Response(`
          <html><body>
            <div class="result">
              <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fafter-missing-key">After Missing Key</a>
              <a class="result__snippet">Duck result after missing API key.</a>
            </div>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    for (let index = 0; index < 4; index++) {
      const result = await getRegistry().lookup("web_search")!.execute({ query: `missing-${index}`, engine: "brave" });
      expect(result).toContain("Brave API key is not configured");
      expect(result).not.toContain("temporarily disabled");
    }
    const fallback = await getRegistry().lookup("web_search")!.execute({ query: "after missing key" });

    expect(fallback).toContain("After Missing Key");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not open engine circuits for user-aborted searches", async () => {
    getRegistry().clear();
    registerWebTools();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("bing.com") && url.includes("abort-")) {
        const signal = init?.signal as AbortSignal | undefined;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (url.includes("bing.com")) {
        return new Response(`
          <html><body>
            <li class="b_algo">
              <h2><a href="https://example.com/after-abort">After Abort</a></h2>
              <div class="b_caption"><p>Search recovered after abort.</p></div>
            </li>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    for (let index = 0; index < 4; index++) {
      const controller = new AbortController();
      const search = getRegistry().lookup("web_search")!.execute({
        query: `abort-${index}`,
        engine: "bing",
      }, { signal: controller.signal });
      controller.abort();
      await expect(search).rejects.toThrow(/abort/i);
    }
    const recovered = await getRegistry().lookup("web_search")!.execute({ query: "after abort", engine: "bing" });

    expect(recovered).toContain("After Abort");
    expect(recovered).not.toContain("temporarily disabled");
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes("after%20abort"))).toBe(true);
  });

  it("merges and deduplicates engines for deep search", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) {
        return new Response(`
          <html><body>
            <li class="b_algo">
              <h2><a href="https://example.com/shared?utm_source=bing">Shared Result</a></h2>
              <p class="b_lineclamp">Bing lineclamp snippet.</p>
            </li>
            <li class="b_algo">
              <h2><a href="https://example.com/bing-only">Bing Only</a></h2>
              <div class="b_caption"><p>Bing only snippet.</p></div>
            </li>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("duckduckgo.com")) {
        return new Response(`
          <html><body>
            <div class="result">
              <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fshared%2F">Shared Duplicate</a>
              <a class="result__snippet">Duck duplicate snippet.</a>
            </div>
            <div class="result">
              <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.org%2Fduck-only">Duck Only</a>
              <a class="result__snippet">Duck only snippet.</a>
            </div>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({
      query: "deep merge unique",
      type: "deep",
      fetch_results: false,
      max_results: 5,
    });

    expect(result).toContain("Source: Bing + DuckDuckGo");
    expect(result).toContain("Bing lineclamp snippet.");
    expect(result).toContain("Bing Only");
    expect(result).toContain("Duck Only");
    expect(result.match(/shared/g)?.length).toBe(1);
  });

  it("falls back to DuckDuckGo when Bing fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) {
        throw new Error("connect timeout");
      }
      if (url.includes("duckduckgo.com")) {
        return new Response(`
          <html><body>
            <div class="result">
              <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fnews">Example News</a>
              <a class="result__snippet">Useful snippet &amp; context.</a>
            </div>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({
      query: "latest news",
      max_results: 1,
      timeout_ms: 1000,
    });

    expect(result).toContain("Source: DuckDuckGo");
    expect(result).toContain("Example News");
    expect(result).toContain("ref_id: web_");
    expect(result).toContain("https://example.com/news");
    expect(result).toContain("Bing");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("accepts q and search_query compatibility aliases", async () => {
    const duckHtml = `
      <html><body>
        <div class="result">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdeepseek">DeepSeek Result</a>
          <a class="result__snippet">Snippet text</a>
        </div>
      </body></html>
    `;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(duckHtml, { status: 200, headers: { "content-type": "text/html" } })
    );

    const qResult = await getRegistry().lookup("web_search")!.execute({ q: "deepseek" });
    const arrayResult = await getRegistry().lookup("web_search")!.execute({
      search_query: [{ q: "deepseek api", max_results: 1 }],
    });

    expect(qResult).toContain("DeepSeek Result");
    expect(qResult).toContain("https://example.com/deepseek");
    expect(arrayResult).toContain("DeepSeek Result");
  });

  it("fetches and extracts text from reachable HTTP pages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <html>
        <head><title>Local Title</title><style>.x{color:red}</style></head>
        <body><script>alert(1)</script><h1>Hello &amp; welcome</h1><p>Readable text.</p></body>
      </html>
    `, { status: 200, headers: { "content-type": "text/html" } }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "http://93.184.216.34/" });

    expect(result).toContain("Status: 200");
    expect(result).toContain("Local Title");
    expect(result).toContain("Hello & welcome");
    expect(result).toContain("Readable text.");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("color:red");
  });

  it("strips URL fragments before fetches, redirects, output, and cache keys", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).not.toContain("#");
      if (url === "https://example.com/fragment") {
        return new Response("", {
          status: 302,
          headers: { location: "https://example.com/final#secret" },
        });
      }
      if (url === "https://example.com/final") {
        return new Response("<html><body><h1>Fragment Clean</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const first = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/fragment#one" });
    const second = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/fragment#two" });

    expect(first).toContain("URL: https://example.com/final");
    expect(first).toContain("Fragment Clean");
    expect(first).not.toContain("#secret");
    expect(second).toContain("Fragment Clean");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches search results by ref_id", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) {
        return new Response(`
          <html><body>
            <li class="b_algo">
              <h2><a href="https://example.com/ref-page">Ref Page</a></h2>
              <div class="b_caption"><p>Ref snippet</p></div>
            </li>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.includes("example.com/ref-page")) {
        return new Response("<html><body><h1>Fetched by ref</h1><p>Body text</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const search = await getRegistry().lookup("web_search")!.execute({ query: "ref test", max_results: 1 });
    const ref = search.match(/ref_id: (web_[a-z0-9]+)/)?.[1];
    const fetched = await getRegistry().lookup("web_fetch")!.execute({ ref_id: ref, format: "markdown" });

    expect(ref).toBeTruthy();
    expect(fetched).toContain("# Fetched by ref");
    expect(fetched).toContain("Body text");
  });

  it("can include fetched page context in search results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) {
        return new Response(`
          <html><body>
            <li class="b_algo">
              <h2><a href="https://example.com/context-page">Context Page</a></h2>
              <div class="b_caption"><p>Search snippet</p></div>
            </li>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://example.com/context-page") {
        return new Response(`
          <html>
            <head><title>Context Title</title></head>
            <body><main><h1>Fetched Context</h1><p>Important page body for the model.</p></main></body>
          </html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({
      query: "context fetch unique",
      engine: "bing",
      fetch_results: true,
      context_results: 1,
    });

    expect(result).toContain("Context Page");
    expect(result).toContain("# Fetched Context");
    expect(result).toContain("Important page body for the model.");
  });

  it("retries transient search failures before falling back", async () => {
    let bingCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("bing.com")) {
        bingCalls++;
        if (bingCalls === 1) throw new Error("fetch failed");
        return new Response(`
          <html><body>
            <li class="b_algo">
              <h2><a href="https://example.com/retry">Retry Result</a></h2>
              <div class="b_caption"><p>Retried successfully</p></div>
            </li>
          </body></html>
        `, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "retry", engine: "bing" });

    expect(result).toContain("Retry Result");
    expect(bingCalls).toBe(2);
  });

  it("returns non-2xx fetch bodies instead of hiding useful content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    }));

    const result = await getRegistry().lookup("fetch_url")!.execute({ url: "https://example.com/missing", json: true });
    const parsed = JSON.parse(result);

    expect(parsed.status).toBe(404);
    expect(parsed.content).toContain("not found");
  });

  it("caches repeated direct URL fetches during the session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html><body><h1>Cached page</h1></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));

    const first = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/cache-test" });
    const second = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/cache-test" });

    expect(first).toContain("Cached page");
    expect(second).toContain("Cached page");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches fetches even when the engine passes an abort signal", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("cached with signal", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));
    const controller = new AbortController();

    const first = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/cache-signal-test" }, { signal: controller.signal });
    const second = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/cache-signal-test" }, { signal: controller.signal });

    expect(first).toContain("cached with signal");
    expect(second).toContain("cached with signal");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-progress response body reader when aborted", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    let resolvePull!: () => void;
    let resolveCancel!: () => void;
    const pullStarted = new Promise<void>(resolve => { resolvePull = resolve; });
    const cancelled = new Promise<void>(resolve => { resolveCancel = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode("partial"));
      },
      pull() {
        resolvePull();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        resolveCancel();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    const resultPromise = getRegistry().lookup("web_fetch")!.execute(
      { url: "https://example.com/abort-body", timeout_ms: 1000 },
      { signal: controller.signal },
    );
    await pullStarted;
    controller.abort();
    const result = await resultPromise;

    await cancelled;
    expect(result).toContain("aborted");
  });

  it("does not wait for an extra response chunk after reaching the byte cap", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode("0123456789"));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    const result = await getRegistry().lookup("web_fetch")!.execute({
      url: "https://example.com/exact-cap",
      max_bytes: 10,
      timeout_ms: 200,
      json: true,
      format: "raw",
    });
    const parsed = JSON.parse(result);

    expect(parsed.content).toBe("0123456789");
    expect(parsed.truncated).toBe(true);
  });

  it("applies fetch timeout while waiting for a per-host concurrency slot", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (String(input).includes("queued-0")) {
        await new Promise<void>(resolve => setTimeout(resolve, 60));
        return new Response("held", { status: 200, headers: { "content-type": "text/plain" } });
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 500);
        signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      return new Response("held", { status: 200, headers: { "content-type": "text/plain" } });
    });

    const held = Array.from({ length: 4 }, (_, index) =>
      getRegistry().lookup("web_fetch")!.execute({
        url: `https://queue.example/queued-${index}`,
        timeout_ms: 500,
      })
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    const queued = await getRegistry().lookup("web_fetch")!.execute({
      url: "https://queue.example/queued-late",
      timeout_ms: 20,
    });
    await Promise.all(held);

    expect(queued).toContain("request timed out after 20 ms");
    expect(fetchMock.mock.calls.map(call => String(call[0]))).not.toContain("https://queue.example/queued-late");
  });

  it("blocks redirects to restricted hosts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/redirect" });

    expect(result).toContain("blocked restricted host");
  });

  it("rejects localhost fetches to avoid SSRF", async () => {
    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "http://localhost:1234" });

    expect(result).toContain("blocked restricted host");
  });

  it("rejects IPv4-mapped IPv6 localhost fetches", async () => {
    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "http://[::ffff:127.0.0.1]/admin" });

    expect(result).toContain("blocked restricted host");
  });

  it("rejects alternate IPv6 loopback and link-local fetches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));

    const loopback = await getRegistry().lookup("web_fetch")!.execute({ url: "http://[0:0:0:0:0:0:0:1]/admin" });
    const compatibleLoopback = await getRegistry().lookup("web_fetch")!.execute({ url: "http://[::127.0.0.1]/admin" });
    const linkLocal = await getRegistry().lookup("web_fetch")!.execute({ url: "http://[fe90::1]/admin" });
    const multicast = await getRegistry().lookup("web_fetch")!.execute({ url: "http://[ff02::1]/admin" });

    expect(loopback).toContain("blocked restricted host");
    expect(compatibleLoopback).toContain("blocked restricted host");
    expect(linkLocal).toContain("blocked restricted host");
    expect(multicast).toContain("blocked restricted host");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache failed direct fetch responses", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not found yet", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }))
      .mockResolvedValueOnce(new Response("recovered", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }));

    const first = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/transient", timeout_ms: 1 });
    const second = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/transient", timeout_ms: 1 });

    expect(first).toContain("Status: 404");
    expect(second).toContain("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors web disabled config", async () => {
    getRegistry().clear();
    registerWebTools({ enabled: false, mode: "off" });

    const search = await getRegistry().lookup("web_search")!.execute({ query: "anything" });
    const fetch = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com" });

    expect(search).toContain("disabled by configuration");
    expect(fetch).toContain("disabled by configuration");
  });

  it("enforces allowed domains for direct fetch", async () => {
    getRegistry().clear();
    registerWebTools({ allowed_domains: ["example.com"] });

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://blocked.test/page" });

    expect(result).toContain("blocked by web.allowed_domains");
  });

  it("applies allowed domain filters to search results", async () => {
    getRegistry().clear();
    registerWebTools({ allowed_domains: ["allowed.example"] });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain("site%3Aallowed.example");
      return new Response(`
        <html><body>
          <li class="b_algo">
            <h2><a href="https://allowed.example/ok">Allowed Result</a></h2>
            <div class="b_caption"><p>Allowed snippet</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="https://blocked.example/no">Blocked Result</a></h2>
            <div class="b_caption"><p>Blocked snippet</p></div>
          </li>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } });
    });

    const result = await getRegistry().lookup("web_search")!.execute({ query: "domain filter", engine: "bing", max_results: 5 });

    expect(result).toContain("Allowed Result");
    expect(result).toContain("https://allowed.example/ok");
    expect(result).not.toContain("Blocked Result");
  });

  it("decodes Bing redirect URLs and skips Bing-internal results", async () => {
    const target = Buffer.from("https://example.com/decoded").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(`
        <html><body>
          <li class="b_algo">
            <h2><a href="https://www.bing.com/ck/a?u=a1${target}">Decoded Result</a></h2>
            <p class="b_lineclamp">Line clamp snippet</p>
          </li>
          <li class="b_algo">
            <h2><a href="/search?q=internal">Internal Result</a></h2>
            <div class="b_caption"><p>Should not appear</p></div>
          </li>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } })
    );

    const result = await getRegistry().lookup("web_search")!.execute({ query: "bing redirect unique", engine: "bing", max_results: 5 });

    expect(result).toContain("Decoded Result");
    expect(result).toContain("https://example.com/decoded");
    expect(result).toContain("Line clamp snippet");
    expect(result).not.toContain("Internal Result");
  });

  it("skips search-engine internal links from generic fallback parsing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(`
        <html><body>
          <a href="/search?q=internal">Internal Search Link</a>
          <a href="https://example.com/generic">Generic Public Link</a>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } })
    );

    const result = await getRegistry().lookup("web_search")!.execute({ query: "generic fallback", engine: "duckduckgo" });

    expect(result).toContain("Generic Public Link");
    expect(result).not.toContain("Internal Search Link");
  });

  it("applies blocked domain filters to search results", async () => {
    getRegistry().clear();
    registerWebTools({ blocked_domains: ["blocked.example"] });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(`
        <html><body>
          <li class="b_algo">
            <h2><a href="https://allowed.example/ok">Allowed Result</a></h2>
            <div class="b_caption"><p>Allowed snippet</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="https://blocked.example/no">Blocked Result</a></h2>
            <div class="b_caption"><p>Blocked snippet</p></div>
          </li>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } })
    );

    const result = await getRegistry().lookup("web_search")!.execute({ query: "domain filter", engine: "bing", max_results: 5 });

    expect(result).toContain("Allowed Result");
    expect(result).not.toContain("Blocked Result");
    expect(result).not.toContain("https://blocked.example/no");
  });

  it("rejects requested search domains outside allowed domains before fetching", async () => {
    getRegistry().clear();
    registerWebTools({ allowed_domains: ["allowed.example"] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));

    const result = await getRegistry().lookup("web_search")!.execute({
      query: "domain filter",
      domains: ["blocked.example"],
      json: true,
    });
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(0);
    expect(parsed.failures[0]).toContain("outside web.allowed_domains");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed requested search domains before building a bogus site filter", async () => {
    getRegistry().clear();
    registerWebTools();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const tool = getRegistry().lookup("web_search")!;

    expect(await tool.validateInput?.(
      { query: "domain filter", domains: [{ nested: true }] as any },
      { tool_name: "web_search", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("domains must be an array of strings"),
    });

    const result = await tool.execute({
      query: "domain filter",
      domains: [{ nested: true }] as any,
    });

    expect(result).toContain("domains must be an array of strings");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed optional web_search inputs before executing a fallback search", async () => {
    getRegistry().clear();
    registerWebTools();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));
    const tool = getRegistry().lookup("web_search")!;

    expect(await tool.execute({
      query: "domain filter",
      max_results: { nested: true } as any,
    })).toContain("max_results must be a number");
    expect(await tool.execute({
      query: "domain filter",
      json: { nested: true } as any,
    })).toContain("json must be a boolean");
    expect(await tool.execute({
      search_query: [{ q: "domain filter", max_results: { nested: true } as any }],
    })).toContain("search_query max_results must be a number");
    expect(await tool.execute({
      query: "domain filter",
      max_results: "2abc",
    })).toContain("max_results must be a number");
    expect(await tool.execute({
      query: "domain filter",
      timeout_ms: "1000ms",
    })).toContain("timeout_ms must be a number");
    expect(await tool.execute({
      query: "domain filter",
      json: "maybe",
    })).toContain("json must be a boolean");
    expect(await tool.execute({
      search_query: [{ q: "domain filter", context_results: "2.5" }],
    })).toContain("search_query context_results must be a number");
    expect(await tool.execute({
      search_query: [{ q: "domain filter", timeout_ms: "1000ms" }],
    })).toContain("search_query timeout_ms must be a number");
    expect(await tool.execute({
      search_query: [{ q: "domain filter", include_content: "maybe" }],
    })).toContain("search_query include_content must be a boolean");
    expect(await tool.execute({
      query: { nested: true } as any,
    })).toContain("query must be a string");
    expect(await tool.execute({
      q: `bad\u0000query`,
    })).toContain("q contains unsupported control characters");
    expect(await tool.execute({
      query: "domain filter",
      max_results: 0,
    })).toContain("max_results must be a positive integer");
    expect(await tool.execute({
      query: "domain filter",
      engine: "not-real",
    })).toContain("engine must be a supported search engine");
    expect(await tool.execute({
      query: "domain filter",
      type: "massive",
    })).toContain("type must be auto, fast, or deep");
    expect(await tool.execute({
      search_query: Array.from({ length: 9 }, () => ({ q: "domain filter" })),
    })).toContain("search_query must contain 8 entries or fewer");
    expect(await tool.execute({
      search_query: [{ q: "domain filter", context_results: 0 }],
    })).toContain("search_query context_results must be a positive integer");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors nested search_query timeout aliases during execution", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(signal?.aborted).toBe(true);
      return new Response("", { status: 200 });
    });

    const result = await getRegistry().lookup("web_search")!.execute({
      search_query: [{ q: "nested timeout", timeout_ms: 1 }],
      engine: "bing",
    });

    expect(result).toContain("No results for 'nested timeout'");
    expect(result).toContain("request timed out after 1 ms");
  });

  it("blocks direct fetches to blocked domains", async () => {
    getRegistry().clear();
    registerWebTools({ blocked_domains: ["blocked.example"] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://blocked.example/page" });

    expect(result).toContain("blocked by web.blocked_domains");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects direct fetch URLs with credentials before issuing network requests", async () => {
    getRegistry().clear();
    registerWebTools();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://user:pass@example.com/private" });

    expect(result).toContain("URL credentials are not supported");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects localhost with a trailing root label", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "http://localhost./admin" });

    expect(result).toContain("blocked restricted host");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects documentation and benchmark IPv4 ranges before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));

    const doc = await getRegistry().lookup("web_fetch")!.execute({ url: "http://192.0.2.10/page" });
    const benchmark = await getRegistry().lookup("web_fetch")!.execute({ url: "http://198.18.0.1/page" });
    const testNet = await getRegistry().lookup("web_fetch")!.execute({ url: "http://203.0.113.10/page" });

    expect(doc).toContain("blocked restricted host");
    expect(benchmark).toContain("blocked restricted host");
    expect(testNet).toContain("blocked restricted host");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed optional web_fetch inputs before issuing a fetch", async () => {
    getRegistry().clear();
    registerWebTools();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const tool = getRegistry().lookup("web_fetch")!;

    expect(await tool.execute({
      url: "https://example.com/page",
      max_bytes: { nested: true } as any,
    })).toContain("max_bytes must be a number");
    expect(await tool.execute({
      url: "https://example.com/page",
      json: { nested: true } as any,
    })).toContain("json must be a boolean");
    expect(await tool.execute({
      url: "https://example.com/page",
      format: { nested: true } as any,
    })).toContain("format must be a string");
    expect(await tool.execute({
      url: "https://example.com/page",
      max_bytes: "128kb",
    })).toContain("max_bytes must be a number");
    expect(await tool.execute({
      url: "https://example.com/page",
      timeout_ms: "1000ms",
    })).toContain("timeout_ms must be a number");
    expect(await tool.execute({
      url: "https://example.com/page",
      extract_text: "maybe",
    })).toContain("extract_text must be a boolean");
    expect(await tool.execute({
      url: { nested: true } as any,
    })).toContain("url must be a string");
    expect(await tool.execute({
      url: `https://example.com/page\u0000`,
    })).toContain("url contains unsupported control characters");
    expect(await tool.execute({
      url: "https://example.com/page",
      format: "pdf",
    })).toContain("format must be markdown, text, or raw");
    expect(await tool.execute({
      url: "https://example.com/page",
      max_bytes: 0,
    })).toContain("max_bytes must be a positive integer");
    expect(await tool.execute({
      ref_id: `web_bad\u0000`,
    })).toContain("ref_id contains unsupported control characters");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports unknown ref_id fetches explicitly instead of degrading them to missing-url errors", async () => {
    getRegistry().clear();
    registerWebTools();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ ref_id: "web_missing" });

    expect(result).toContain("unknown ref_id 'web_missing'");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sanitizes fetch error messages before returning them", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("bad\u0000network\nwith\tcontrols"));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/error" });

    expect(result).toContain("bad network with controls");
    expect(result).not.toContain("\u0000");
  });

  it("rejects unsafe requested search domain patterns before fetching", async () => {
    getRegistry().clear();
    registerWebTools();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));
    const tool = getRegistry().lookup("web_search")!;

    expect(await tool.execute({ query: "unsafe", domains: ["localhost"] })).toContain("valid public domain names");
    expect(await tool.execute({ query: "unsafe", domains: ["example.com/path"] })).toContain("valid public domain names");
    expect(await tool.execute({
      search_query: [{ q: "unsafe", domains: ["*.example.com"] }],
      engine: "bing",
    })).not.toContain("valid public domain names");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes explicit proxy dispatcher to fetch", async () => {
    getRegistry().clear();
    registerWebTools({ proxy: "http://proxy.example:8080" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/page" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeTruthy();
  });

  it("honors no_proxy for explicit proxy configuration", async () => {
    getRegistry().clear();
    registerWebTools({ proxy: "http://proxy.example:8080", no_proxy: ["example.com"] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/page" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeTruthy();
    expect(init.dispatcher?.constructor?.name).not.toBe("ProxyAgent");
  });

  it("ignores invalid explicit proxy configuration instead of constructing a dispatcher", async () => {
    getRegistry().clear();
    registerWebTools({ proxy: "file:///tmp/proxy.sock" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/page" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeTruthy();
    expect(init.dispatcher?.constructor?.name).not.toBe("ProxyAgent");
  });

  it("normalizes no_proxy entries with trailing dots", async () => {
    getRegistry().clear();
    registerWebTools({ proxy: "http://proxy.example:8080", no_proxy: ["example.com."] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com./no-proxy-trailing-dot" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
    expect(init.dispatcher).toBeTruthy();
    expect(init.dispatcher?.constructor?.name).not.toBe("ProxyAgent");
  });

  it("uses the final redirect URL and extracts the redirected body", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://example.com/redirect") {
        return new Response("", {
          status: 302,
          headers: { location: "https://example.com/final" },
        });
      }
      if (url === "https://example.com/final") {
        return new Response("<html><body><h1>Final page</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/redirect" });

    expect(result).toContain("URL: https://example.com/final");
    expect(result).toContain("# Final page");
  });

  it("cancels intermediate redirect bodies before following the next location", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode("unused redirect body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://example.com/redirect-body") {
        return new Response(body, {
          status: 302,
          headers: { location: "https://example.com/redirect-body-final" },
        });
      }
      if (url === "https://example.com/redirect-body-final") {
        return new Response("redirect body final", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/redirect-body" });

    expect(result).toContain("redirect body final");
    expect(cancelled).toBe(true);
  });

  it("truncates large pages at the configured byte cap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("a".repeat(200), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));

    const result = await getRegistry().lookup("web_fetch")!.execute({
      url: "https://example.com/large",
      max_bytes: 32,
      json: true,
      format: "raw",
    });
    const parsed = JSON.parse(result);

    expect(parsed.truncated).toBe(true);
    expect(parsed.content).toHaveLength(32);
    expect(parsed.content).toBe("a".repeat(32));
  });

  it("honors string boolean extract_text aliases and sanitizes raw fetch output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html><body><h1>Raw\u001b Page</h1></body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));

    const result = await getRegistry().lookup("web_fetch")!.execute({
      url: "https://example.com/raw-alias",
      extract_text: "false",
      json: true,
    });
    const parsed = JSON.parse(result);

    expect(parsed.content).toContain("<html>");
    expect(parsed.content).toContain("Raw  Page");
    expect(parsed.content).not.toContain("\u001b");
    expect(parsed.content).not.toContain("# Raw");
  });

  it("separates cached API search results by API key fingerprint", async () => {
    getRegistry().clear();
    registerWebTools({ brave_api_key: "brave-key-one" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toContain("api.search.brave.com");
      const token = (init?.headers as Record<string, string>)["X-Subscription-Token"];
      return new Response(JSON.stringify({
        web: {
          results: [
            { title: `Result for ${token}`, url: `https://example.com/${token}` },
          ],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const first = await getRegistry().lookup("web_search")!.execute({ query: "cache by key", engine: "brave" });
    getRegistry().clear();
    registerWebTools({ brave_api_key: "brave-key-two" });
    const second = await getRegistry().lookup("web_search")!.execute({ query: "cache by key", engine: "brave" });

    expect(first).toContain("Result for brave-key-one");
    expect(second).toContain("Result for brave-key-two");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops unsafe search result URLs before assigning refs", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(`
        <html><body>
          <li class="b_algo">
            <h2><a href="https://user:pass@example.com/credentialed">Credentialed Result</a></h2>
            <div class="b_caption"><p>Should not appear</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="javascript:alert(1)">Script Result</a></h2>
            <div class="b_caption"><p>Should not appear either</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="https://safe.example/page#section">Safe Result</a></h2>
            <div class="b_caption"><p>Safe snippet</p></div>
          </li>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } })
    );

    const result = await getRegistry().lookup("web_search")!.execute({ query: "safe urls", engine: "bing", max_results: 5 });

    expect(result).toContain("Safe Result");
    expect(result).toContain("https://safe.example/page");
    expect(result).not.toContain("#section");
    expect(result).not.toContain("Credentialed Result");
    expect(result).not.toContain("Script Result");
  });

  it("strips control characters from API search result fields", async () => {
    getRegistry().clear();
    registerWebTools({ brave_api_key: "brave-key" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      web: {
        results: [
          { title: "Brave\u0000 Result", url: "https://example.com/brave", description: "Snippet\u0007 text" },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await getRegistry().lookup("web_search")!.execute({ query: "control fields", engine: "brave" });

    expect(result).toContain("Brave Result");
    expect(result).toContain("Snippet text");
    expect(result).not.toContain("\u0000");
    expect(result).not.toContain("\u0007");
  });

  it("fails closed for hostile web tool argument getters", async () => {
    getRegistry().clear();
    registerWebTools({ brave_api_key: "brave-key" });
    const args: Record<string, unknown> = { query: "hostile args", engine: "brave" };
    Object.defineProperty(args, "max_results", {
      enumerable: true,
      get() {
        throw new Error("max getter failed");
      },
    });
    Object.defineProperty(args, "json", {
      enumerable: true,
      get() {
        throw new Error("json getter failed");
      },
    });
    const fetchArgs: Record<string, unknown> = { url: "https://example.com/hostile-args" };
    Object.defineProperty(fetchArgs, "format", {
      enumerable: true,
      get() {
        throw new Error("format getter failed");
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("api.search.brave.com")) {
        return new Response(JSON.stringify({
          web: { results: [{ title: "Hostile Args Result", url: "https://example.com/hostile-result" }] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("<html><body><h1>Hostile fetch args</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    const search = await getRegistry().lookup("web_search")!.execute(args);
    const fetched = await getRegistry().lookup("web_fetch")!.execute(fetchArgs);

    expect(search).toContain("max_results must be a number");
    expect(fetched).toContain("format must be a string");
    expect(search).not.toContain("getter failed");
    expect(fetched).not.toContain("getter failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips hostile API payload getters without failing the engine", async () => {
    getRegistry().clear();
    registerWebTools({ brave_api_key: "brave-key" });
    const originalParse = JSON.parse;
    const hostileResult: Record<string, unknown> = { title: "Bad" };
    Object.defineProperty(hostileResult, "url", {
      enumerable: true,
      get() {
        throw new Error("url getter failed");
      },
    });
    const payload = JSON.stringify({
      web: {
        results: [
          { title: "Good API Result", url: "https://example.com/good-api", description: "safe" },
        ],
      },
    });
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const parsed = originalParse(text, reviver);
      if (typeof text === "string" && text.includes("Good API Result")) {
        return { web: { results: [hostileResult, ...parsed.web.results] } };
      }
      return parsed;
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await getRegistry().lookup("web_search")!.execute({ query: "hostile api", engine: "brave" });

    expect(result).toContain("Good API Result");
    expect(result).not.toContain("url getter failed");
  });

  it("keeps fetch cache and JSON POST serialization stable for hostile headers and body getters", async () => {
    getRegistry().clear();
    registerWebTools({ exa_api_key: "exa-key" });
    const bodySeen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "https://api.exa.ai/search") {
        bodySeen.push(String(init?.body));
        return new Response(JSON.stringify({
          results: [{ title: "Exa Hostile Body", url: "https://example.com/exa-hostile" }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });

    await getRegistry().lookup("web_search")!.execute({ query: "hostile body", engine: "exa" });
    await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/cache-hostile", json: true });

    expect(bodySeen[0]).toContain("hostile body");
  });

  it("handles uppercase content types and escapes long markdown code fences", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <html><body><pre>const fence = \`\`\`;\nconsole.log(fence);</pre></body></html>
    `, { status: 200, headers: { "content-type": "TEXT/HTML; charset=utf-8" } }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/fence" });

    expect(result).toContain("````");
    expect(result).toContain("const fence");
  });

  it("reports fetch content profiles and cumulative web stats", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <html><head><title>Docs Page</title></head>
      <body><nav>noise</nav><main><h1>Docs Page</h1><p>Readable content for extraction.</p></main></body></html>
    `, { status: 200, headers: { "content-type": "text/html" } }));

    const fetched = JSON.parse(await getRegistry().lookup("web_fetch")!.execute({
      url: "https://example.com/docs",
      json: true,
    })) as { content_profile: { title?: string; format: string; word_count: number; main_content_ratio?: number } };
    const stats = JSON.parse(await getRegistry().lookup("web_stats")!.execute({})) as { fetch_calls: number; fetch_ms: number; cache_entries: { fetch: number } };

    expect(fetched.content_profile).toMatchObject({ title: "Docs Page", format: "html" });
    expect(fetched.content_profile.word_count).toBeGreaterThan(0);
    expect(fetched.content_profile.main_content_ratio).toBeGreaterThan(0);
    expect(stats.fetch_calls).toBeGreaterThan(0);
    expect(stats.cache_entries.fetch).toBeGreaterThanOrEqual(1);
  });

  it("applies current domain policy when fetching a stored ref_id", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(`
        <html><body>
          <li class="b_algo">
            <h2><a href="https://example.com/ref-page">Ref Page</a></h2>
            <div class="b_caption"><p>Ref snippet</p></div>
          </li>
        </body></html>
      `, { status: 200, headers: { "content-type": "text/html" } })
    );
    const search = await getRegistry().lookup("web_search")!.execute({ query: "ref policy", max_results: 1 });
    const ref = search.match(/ref_id: (web_[a-z0-9]+)/)?.[1];
    getRegistry().clear();
    registerWebTools({ blocked_domains: ["example.com"] });

    const fetched = await getRegistry().lookup("web_fetch")!.execute({ ref_id: ref });

    expect(ref).toBeTruthy();
    expect(fetched).toContain("blocked by web.blocked_domains");
  });

  it("does not reuse cached redirect fetches after domain policy changes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://example.com/redirect-policy-test") {
        return new Response("", {
          status: 302,
          headers: { location: "https://final.example/page" },
        });
      }
      if (url === "https://final.example/page") {
        return new Response("<html><body><h1>Redirected page</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const first = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/redirect-policy-test" });

    getRegistry().clear();
    registerWebTools({ blocked_domains: ["final.example"] });
    const second = await getRegistry().lookup("web_fetch")!.execute({ url: "https://example.com/redirect-policy-test" });

    expect(first).toContain("URL: https://final.example/page");
    expect(second).toContain("blocked by web.blocked_domains");
  });
});
