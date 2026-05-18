import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("web tools", () => {
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
        return new Response(JSON.stringify({ esearchresult: { idlist: ["123", { bad: true }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("esummary.fcgi")) {
        expect(url).toContain("id=123");
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
      search_query: [{ q: "domain filter", include_content: "maybe" }],
    })).toContain("search_query include_content must be a boolean");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks direct fetches to blocked domains", async () => {
    getRegistry().clear();
    registerWebTools({ blocked_domains: ["blocked.example"] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("should not fetch", { status: 200 }));

    const result = await getRegistry().lookup("web_fetch")!.execute({ url: "https://blocked.example/page" });

    expect(result).toContain("blocked by web.blocked_domains");
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
