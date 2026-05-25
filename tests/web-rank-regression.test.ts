import { describe, expect, it } from "vitest";

import { canonicalSearchUrl, dedupeSearchResults, rankSearchResults } from "../src/tools/web/rank.js";

describe("web result ranking helpers", () => {
  it("rejects unsafe URL schemes and credentials when canonicalizing", () => {
    expect(canonicalSearchUrl("ftp://example.com/file")).toBeNull();
    expect(canonicalSearchUrl("https://user:pass@example.com/private")).toBeNull();
    expect(canonicalSearchUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalSearchUrl("https://example.com/\u0000bad")).toBeNull();
    expect(canonicalSearchUrl(`https://example.com/${"x".repeat(9000)}`)).toBeNull();
  });

  it("normalizes trailing host dots before deduping", () => {
    const results = dedupeSearchResults([
      { title: "A", url: "https://Example.com./docs/?utm_source=test#top" },
      { title: "B", url: "https://example.com/docs/" },
      { title: "C", url: "https://user:pass@example.com/private" },
    ], 10);

    expect(results).toEqual([
      { title: "A", url: "https://example.com/docs" },
    ]);
  });

  it("drops localhost URLs and broader tracking parameters while canonicalizing", () => {
    expect(canonicalSearchUrl("https://localhost/docs")).toBeNull();
    expect(canonicalSearchUrl("https://127.0.0.1/docs")).toBeNull();
    expect(canonicalSearchUrl("https://10.0.0.5/docs")).toBeNull();
    expect(canonicalSearchUrl("https://[::1]/docs")).toBeNull();
    expect(canonicalSearchUrl("https://[::ffff:127.0.0.1]/docs")).toBeNull();
    expect(canonicalSearchUrl("https://docs.example/page?utm_reader=x&gbraid=y&keep=1#top")).toBe("https://docs.example/page?keep=1");
  });

  it("bounds rank and dedupe result counts and breaks score ties by URL", () => {
    expect(dedupeSearchResults([{ title: "A", url: "https://example.com/a" }], 0)).toEqual([]);
    expect(rankSearchResults("docs", [
      { title: "Same", url: "https://example.com/b" },
      { title: "Same", url: "https://example.com/a" },
    ], 0)).toEqual([]);
    expect(rankSearchResults("zz", [
      { title: "Same", url: "https://example.com/b", snippet: "x" },
      { title: "Filler 1", url: "https://example.com/1" },
      { title: "Filler 2", url: "https://example.com/2" },
      { title: "Filler 3", url: "https://example.com/3" },
      { title: "Filler 4", url: "https://example.com/4" },
      { title: "Same", url: "https://example.com/a", snippet: "zz" },
    ], 6).map(item => item.url).slice(0, 2)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(rankSearchResults("", [
      { title: "Same", url: "https://example.com/b", snippet: "x" },
      { title: "Same", url: "https://example.com/a", snippet: "x" },
    ], 2).map(item => item.url)).toEqual(["https://example.com/b", "https://example.com/a"]);
  });

  it("sanitizes ranked result text and handles malformed result collections", () => {
    expect(dedupeSearchResults(null as any, 5)).toEqual([]);
    expect(rankSearchResults("docs\u0000api", null as any, 5)).toEqual([]);

    const results = dedupeSearchResults([
      { title: `Title\u0000${"x".repeat(3000)}`, url: "https://example.com/docs", snippet: `Snippet\u0007${"y".repeat(3000)}` },
    ], 5);

    expect(results[0].title).not.toContain("\u0000");
    expect(results[0].title.length).toBeLessThanOrEqual(2000);
    expect(results[0].snippet).not.toContain("\u0007");
    expect(results[0].snippet!.length).toBeLessThanOrEqual(2000);
  });

  it("skips search results with throwing URL getters while preserving valid neighbors", () => {
    const hostile: Record<string, unknown> = { title: "Bad" };
    Object.defineProperty(hostile, "url", {
      enumerable: true,
      get() {
        throw new Error("url getter failed");
      },
    });

    const deduped = dedupeSearchResults([
      hostile as any,
      { title: "Good", url: " https://Example.com/docs/?utm_source=x#top ", snippet: "safe" },
    ], 10);

    expect(deduped).toEqual([
      { title: "Good", url: "https://example.com/docs", snippet: "safe" },
    ]);
    expect(rankSearchResults("good", [hostile as any, ...deduped], 10)).toEqual([
      { title: "Good", url: "https://example.com/docs", snippet: "safe" },
    ]);
  });

  it("sanitizes ref ids and content profiles from ranked results", () => {
    const hostileProfile: Record<string, unknown> = {
      title: "Hostile profile",
      url: "https://example.com/hostile-profile",
    };
    Object.defineProperty(hostileProfile, "content_profile", {
      enumerable: true,
      get() {
        throw new Error("profile getter failed");
      },
    });

    const ranked = rankSearchResults("docs", [{
      title: "Docs",
      url: "https://example.com/docs",
      ref_id: "../bad" as any,
      content_profile: {
        title: "Profile\u0000Title",
        format: "html",
        character_count: Number.MAX_SAFE_INTEGER,
        word_count: -1,
        truncated: true,
        main_content_ratio: 2,
      },
    }, hostileProfile as any], 5);

    expect(ranked[0]).not.toHaveProperty("ref_id");
    expect(ranked[0].content_profile).toEqual({
      title: "Profile Title",
      format: "html",
      character_count: 1_000_000_000,
      word_count: 0,
      truncated: true,
    });
    expect(ranked[1]).toEqual({
      title: "Hostile profile",
      url: "https://example.com/hostile-profile",
    });
  });

  it("drops invalid URLs when ranking is called without a prior dedupe pass", () => {
    expect(rankSearchResults("docs", [
      { title: "Script", url: "javascript:alert(1)", snippet: "docs" },
      { title: "Credentialed", url: "https://user:pass@example.com/private", snippet: "docs" },
      { title: "Local", url: "http://localhost/docs", snippet: "docs" },
      { title: "Safe", url: "https://example.com/docs?utm_campaign=x#top", snippet: "docs" },
    ], 10)).toEqual([
      { title: "Safe", url: "https://example.com/docs", snippet: "docs" },
    ]);
  });

  it("caps rank output even when callers request excessive result counts", () => {
    const results = Array.from({ length: 1_200 }, (_, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
    }));

    expect(rankSearchResults("result", results, 10_000)).toHaveLength(1_000);
    expect(dedupeSearchResults(results, 10_000)).toHaveLength(1_000);
  });
});
