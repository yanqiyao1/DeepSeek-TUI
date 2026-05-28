import { describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

const { DeepSeekClient, sanitizeMessagesForThinkingMode } = await import("../src/client/deepseek.js");
const { StreamAccumulator } = await import("../src/client/streaming.js");
const {
  canonicalModelName,
  extractCachedInputTokens,
  isV4ProModel,
  normalizeModelName,
  parseProvider,
  providerCapability,
  shouldReplayReasoningContent,
} = await import("../src/client/capabilities.js");

describe("DeepSeekClient", () => {
  it("normalizes constructor credentials and rejects unsafe base URLs", () => {
    expect(() => new DeepSeekClient({ apiKey: " ", baseUrl: "http://localhost", model: "deepseek-v4-pro" })).toThrow(/apiKey/);
    expect(() => new DeepSeekClient({ apiKey: "key\u0000", baseUrl: "http://localhost", model: "deepseek-v4-pro" })).toThrow(/apiKey/);
    expect(() => new DeepSeekClient({ apiKey: "key\u0000", baseUrl: "http://localhost", model: "deepseek-v4-pro" })).toThrow(/apiKey/);
    expect(() => new DeepSeekClient({ apiKey: "key", baseUrl: "file:///tmp/api", model: "deepseek-v4-pro" })).toThrow(/baseUrl/);
    expect(() => new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost\u0000/v1", model: "deepseek-v4-pro" })).toThrow(/baseUrl/);
    expect(() => new DeepSeekClient({ apiKey: "key", baseUrl: "https://user:pass@example.com/v1", model: "deepseek-v4-pro" })).toThrow(/credentials/);
    expect(() => new DeepSeekClient({ apiKey: "key", baseUrl: "https://example.com/v1", model: "bad\u0000model" })).toThrow(/model/);

    new DeepSeekClient({ apiKey: " key ", baseUrl: "https://example.com/v1/?token=secret#frag", model: "deepseek-v4-pro" });
  });

  it("captures usage-only final stream chunks", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any, null, { max_tokens: 5 }));

    expect(events.at(-1)).toMatchObject({ type: "done", usage: { total_tokens: 5 }, content: "hi" });
  });

  it("omits tools from requests when there are no tool schemas", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null));

    expect(createMock).toHaveBeenLastCalledWith(expect.not.objectContaining({ tools: expect.anything() }));
  });

  it("emits tool_call_begin only once per streamed tool call", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: ":\"x\"}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { total_tokens: 1 } },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.filter(e => e.type === "tool_call_begin")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "x" } }],
    });
  });

  it("emits tool_call_args deltas with tool call identity", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write", arguments: "{\"path\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":\"src/app.ts\"}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { total_tokens: 1 } },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));
    const argEvents = events.filter(event => event.type === "tool_call_args");

    expect(argEvents).toEqual([
      expect.objectContaining({ tool_call_id: "call_1", name: "write", arguments: "{\"path\"" }),
      expect.objectContaining({ tool_call_id: "call_1", name: "write", arguments: ":\"src/app.ts\"}" }),
    ]);
  });

  it("ignores malformed stream delta fields instead of coercing objects into messages", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { content: { text: "bad" }, reasoning_content: { text: "bad" }, tool_calls: { index: 0 } } }], usage: "bad" },
      { choices: [{ delta: { content: "ok", tool_calls: [{ index: -1, id: { nested: true }, function: { name: { nested: true }, arguments: { path: "x" } } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "[]" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { total_tokens: 1 } },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.filter(event => event.type === "content")).toEqual([{ type: "content", text: "ok" }]);
    expect(events.filter(event => event.type === "thinking")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { total_tokens: 1 },
      content: "ok",
      reasoning_content: null,
      tool_calls: [{ id: "call_1", name: "read", arguments: {} }],
    });
  });

  it("drops unsafe streamed tool call identity fields and indexes", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { tool_calls: [{ index: -1, id: "call_bad", function: { name: "read", arguments: "{\"bad\":true}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1.5, id: "call_fraction", function: { name: "write", arguments: "{\"bad\":true}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 2, id: "call\nbad", function: { name: "read", arguments: "{\"path\":\"bad\"}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 3, id: "call_ok", function: { name: "bad name", arguments: "{\"path\":\"bad\"}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 4, id: "call_ok_2", function: { name: "read", arguments: "{\"path\":\"ok\"}" } }] }, finish_reason: "weird" }] },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.filter(e => e.type === "tool_call_begin")).toEqual([
      expect.objectContaining({ index: 4, tool_call_id: "call_ok_2", name: "read" }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      finish_reason: "stop",
      tool_calls: [{ id: "call_ok_2", name: "read", arguments: { path: "ok" } }],
    });
  });

  it("drops incomplete streamed tool calls instead of returning empty-name calls", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_missing_name", function: { arguments: "{\"path\":\"x\"}" } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { total_tokens: 1 } },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.at(-1)).toMatchObject({
      type: "done",
      tool_calls: [],
    });
  });

  it("replays buffered tool argument deltas once streamed tool identity arrives and deduplicates final ids", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":\"x\"}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_1", function: { name: "write", arguments: "{\"path\":\"duplicate\"}" } }] }, finish_reason: "tool_calls" }] },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));
    const argEvents = events.filter(event => event.type === "tool_call_args");

    expect(argEvents).toEqual([
      expect.objectContaining({ tool_call_id: "call_1", name: "read", arguments: "{\"path\"" }),
      expect.objectContaining({ tool_call_id: "call_1", name: "read", arguments: ":\"x\"}" }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "x" } }],
    });
  });

  it("fails closed for throwing stream usage, tool schemas, and token-count arguments", async () => {
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });
    const usageChunk: any = { choices: [{ delta: { content: "ok" } }] };
    Object.defineProperty(usageChunk, "usage", {
      enumerable: true,
      get() {
        throw new Error("usage getter failed");
      },
    });
    const toolSchema: Record<string, unknown> = { type: "function", function: { name: "read" } };
    Object.defineProperty(toolSchema, "bad", {
      enumerable: true,
      get() {
        throw new Error("schema getter failed");
      },
    });
    const message: Record<string, unknown> = { role: "assistant", content: "ok" };
    Object.defineProperty(message, "reasoning_content", {
      enumerable: true,
      get() {
        throw new Error("message reasoning getter failed");
      },
    });
    createMock.mockResolvedValueOnce(streamFrom([usageChunk, { choices: [], usage: { total_tokens: 1 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }, message] as any, [toolSchema]));
    const request = createMock.mock.calls.at(-1)?.[0] as any;

    expect(events.at(-1)).toMatchObject({ type: "done", content: "ok", usage: { total_tokens: 1 } });
    expect(request).not.toHaveProperty("tools");
    expect(request.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", reasoning_content: "(reasoning omitted)", content: "ok" }),
    ]));
    await expect(client.countTokens([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "write", arguments: throwing }] },
    ] as any)).resolves.toBeGreaterThanOrEqual(0);
  });

  it("ignores hostile provider chunk getters without dropping readable sibling fields", async () => {
    const choice: Record<string, unknown> = { finish_reason: "tool_calls" };
    Object.defineProperty(choice, "delta", {
      enumerable: true,
      value: {
        content: "hi",
        reasoning_content: "think",
        tool_calls: [{
          index: 0,
          id: "call_1",
          function: { name: "read", arguments: "{\"path\":\"ok\"}" },
        }],
      },
    });
    const chunk: Record<string, unknown> = { choices: [choice], usage: { total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } } };
    Object.defineProperty(chunk, "bad", {
      enumerable: true,
      get() {
        throw new Error("chunk getter failed");
      },
    });
    const hostileUsage: Record<string, unknown> = { total_tokens: 5 };
    Object.defineProperty(hostileUsage, "prompt_tokens", {
      enumerable: true,
      get() {
        throw new Error("usage getter failed");
      },
    });
    createMock.mockResolvedValueOnce(streamFrom([chunk, { choices: [], usage: hostileUsage }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.filter(event => event.type === "content")).toEqual([{ type: "content", text: "hi" }]);
    expect(events.filter(event => event.type === "thinking")).toEqual([{ type: "thinking", text: "think" }]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      finish_reason: "tool_calls",
      usage: { total_tokens: 5 },
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "ok" } }],
    });
  });

  it("skips hostile streamed tool call fields while preserving later valid deltas", async () => {
    const badToolCall: Record<string, unknown> = { index: 0, id: "call_bad" };
    Object.defineProperty(badToolCall, "function", {
      enumerable: true,
      get() {
        throw new Error("tool function getter failed");
      },
    });
    const badDelta: Record<string, unknown> = { content: "ok" };
    Object.defineProperty(badDelta, "tool_calls", {
      enumerable: true,
      value: [badToolCall],
    });
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: badDelta }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":\"x\"}" } }] }, finish_reason: "tool_calls" }] },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.filter(event => event.type === "content")).toEqual([{ type: "content", text: "ok" }]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "x" } }],
    });
  });

  it("serializes non-JSON usage telemetry before yielding done events", async () => {
    const usage: Record<string, unknown> = { total_tokens: 1n };
    usage.self = usage;
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [], usage },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { total_tokens: "1", self: "[Circular]" },
    });
  });

  it("filters unsafe usage telemetry values before yielding done events", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [], usage: {
        total_tokens: 8,
        negative_tokens: -1,
        fractional_tokens: 1.2,
        bad_array: [1],
        "bad key": 3,
        prompt_tokens_details: { cached_tokens: 2, bad: -3 },
      } },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));

    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { total_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } },
    });
    expect((events.at(-1) as any).usage).not.toHaveProperty("negative_tokens");
    expect((events.at(-1) as any).usage).not.toHaveProperty("fractional_tokens");
    expect((events.at(-1) as any).usage).not.toHaveProperty("bad_array");
    expect((events.at(-1) as any).usage).not.toHaveProperty("bad key");
  });

  it("sanitizes and bounds streamed content, reasoning, and tool argument buffers", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: { content: `hi\u0000${"x".repeat(2_000_010)}`, reasoning_content: `why\u0007${"r".repeat(2_000_010)}` } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_big", function: { name: "read", arguments: `{"text":"${"a".repeat(1_100_000)}` } }] }, finish_reason: "tool_calls" }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: `"}` } }] }, finish_reason: "tool_calls" }] },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));
    const done = events.at(-1) as any;

    expect(done.content).toHaveLength(2_000_000);
    expect(done.content).not.toContain("\u0000");
    expect(done.reasoning_content).toHaveLength(2_000_000);
    expect(done.reasoning_content).not.toContain("\u0007");
    expect(done.tool_calls).toEqual([{ id: "call_big", name: "read", arguments: {} }]);
    expect(events.some(event => event.type === "tool_call_args" && (event as any).arguments.length > 1_000_000)).toBe(false);
  });

  it("bounds streamed text and tool argument deltas on full grapheme boundaries", async () => {
    const family = "👨‍👩‍👧‍👦";
    createMock.mockResolvedValueOnce(streamFrom([
      { choices: [{ delta: {
        content: `${"x".repeat(1_999_995)}${family}tail`,
        reasoning_content: `${"r".repeat(1_999_995)}${family}tail`,
      } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_unicode", function: { name: "read", arguments: `${"a".repeat(999_995)}${family}tail` } }] }, finish_reason: "tool_calls" }] },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any));
    const done = events.at(-1) as any;
    const argDelta = events.find(event => event.type === "tool_call_args") as any;

    expect(done.content).not.toContain(family);
    expect(done.content).not.toContain("\u200d");
    expect(done.reasoning_content).not.toContain(family);
    expect(done.reasoning_content).not.toContain("\u200d");
    expect(argDelta.arguments).not.toContain(family);
    expect(argDelta.arguments).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(done.content)).toBe(false);
    expect(hasUnpairedSurrogate(done.reasoning_content)).toBe(false);
    expect(hasUnpairedSurrogate(argDelta.arguments)).toBe(false);
  });

  it("bounds streamed tool call count and request tool schemas", async () => {
    createMock.mockResolvedValueOnce(streamFrom([
      {
        choices: [{
          delta: {
            tool_calls: Array.from({ length: 120 }, (_, index) => ({
              index,
              id: `call_${index}`,
              function: { name: "read", arguments: "{}" },
            })),
          },
          finish_reason: "tool_calls",
        }],
      },
    ]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });
    const schema: Record<string, unknown> = { type: "function", function: { name: "read", parameters: { default: 1n } } };
    schema.self = schema;

    const events = await collect(client.send(
      [{ role: "user", content: "hello" }] as any,
      Array.from({ length: 300 }, () => schema),
    ));
    const request = createMock.mock.calls.at(-1)?.[0] as any;

    expect((events.at(-1) as any).tool_calls).toHaveLength(100);
    expect(request.tools).toHaveLength(256);
    expect(request.tools[0].function.parameters.default).toBe("1");
    expect(request.tools[0].self).toBe("[Circular]");
  });

  it("drops oversized tool schemas and caps usage telemetry traversal", async () => {
    const usage: Record<string, unknown> = { deep: nestedUsage(12) };
    for (let index = 0; index < 130; index++) usage[`k${index}`] = index;
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });
    const hugeSchema = { type: "function", function: { name: "huge", parameters: { blob: "x".repeat(260_000) } } };
    const okSchema = { type: "function", function: { name: "read", parameters: { type: "object" } } };

    const events = await collect(client.send([{ role: "user", content: "hello" }] as any, [hugeSchema, okSchema]));
    const request = createMock.mock.calls.at(-1)?.[0] as any;
    const done = events.at(-1) as any;

    expect(request.tools).toEqual([okSchema]);
    expect(done.usage.k98).toBe(98);
    expect(done.usage).not.toHaveProperty("k129");
    expect(done.usage).not.toHaveProperty("deep");
  });

  it("passes reasoning_effort through to the API request", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { reasoning_effort: "max", max_tokens: 7 }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({ reasoning_effort: "max", max_tokens: 7 }));
  });

  it("passes AbortSignal to the OpenAI request layer", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });
    const controller = new AbortController();

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { signal: controller.signal }));

    expect(createMock).toHaveBeenLastCalledWith(expect.any(Object), expect.objectContaining({ signal: controller.signal }));
  });

  it("cancels the upstream stream iterator when aborted mid-response", async () => {
    const controller = new AbortController();
    let returned = false;
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            controller.abort();
            return { done: false, value: { choices: [{ delta: { content: "partial" }, finish_reason: null }] } };
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    createMock.mockResolvedValueOnce(stream);
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await expect(collect(client.send([{ role: "user", content: "hello" }] as any, null, { signal: controller.signal }))).rejects.toThrow(/aborted/i);

    expect(returned).toBe(true);
  });

  it("maps local off to disabled thinking instead of pretending low reasoning is off", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { reasoning_effort: "off", max_tokens: 7 }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({ thinking: { type: "disabled" }, max_tokens: 7 }));
    expect(createMock).toHaveBeenLastCalledWith(expect.not.objectContaining({ reasoning_effort: expect.anything() }));
  });

  it("passes assistant reasoning_content back in follow-up requests", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([
      { role: "user", content: "hello" },
      { role: "assistant", content: "calling tool", reasoning_content: "need tools" },
      { role: "tool", content: "result", tool_call_id: "call_1", name: "ls" },
    ] as any, null, { reasoning_effort: "high" }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "calling tool",
          reasoning_content: "need tools",
        }),
      ]),
    }));
  });

  it("counts tokens for non-JSON tool arguments without throwing", async () => {
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });
    const args: Record<string, unknown> = { count: 1n, missing: undefined, fn: () => "ignored" };
    args.self = args;

    await expect(client.countTokens([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "write", arguments: args }] },
    ] as any)).resolves.toBeGreaterThan(0);
  });

  it("uses bounded fallback token estimates for very large token count inputs", async () => {
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await expect(client.countTokens([{ role: "user", content: "x".repeat(500_000) }] as any)).resolves.toBeGreaterThan(100_000);
  });

  it("adds placeholder reasoning_content to assistant messages in V4 thinking mode", () => {
    const messages = sanitizeMessagesForThinkingMode([
      { role: "user", content: "hello" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
    ], "deepseek-v4-pro", "high");

    expect(messages[1]).toMatchObject({ reasoning_content: "(reasoning omitted)", content: "" });
  });

  it("does not replay reasoning_content when thinking is off", () => {
    const messages = sanitizeMessagesForThinkingMode([
      { role: "assistant", content: "ok", reasoning_content: "" },
    ], "deepseek-v4-pro", "off");

    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("strips stored reasoning_content from all assistant messages when thinking is off", () => {
    const messages = sanitizeMessagesForThinkingMode([
      { role: "assistant", content: "ok", reasoning_content: "previous reasoning" },
      { role: "tool", content: "result", tool_call_id: "call_1", name: "read" },
    ], "deepseek-v4-pro", "off");

    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("clamps requested max tokens to provider capability", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "legacy-model" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { max_tokens: 10_000 }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 4096 }));
  });

  it("falls back to the default max token budget when max_tokens is invalid", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { max_tokens: Number.NaN }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({ max_tokens: 8192 }));
  });

  it("treats an explicit empty reasoning_effort as default thinking-on behavior", async () => {
    createMock.mockResolvedValueOnce(streamFrom([{ choices: [], usage: { total_tokens: 0 } }]));
    const client = new DeepSeekClient({ apiKey: "key", baseUrl: "http://localhost", model: "deepseek-v4-pro" });

    await collect(client.send([{ role: "user", content: "hello" }] as any, null, { reasoning_effort: "", max_tokens: 7 }));

    expect(createMock).toHaveBeenLastCalledWith(expect.objectContaining({
      reasoning_effort: "high",
      thinking: { type: "enabled" },
      max_tokens: 7,
    }));
  });
});

describe("DeepSeek capabilities", () => {
  it("models V4 context, output, thinking, and cache telemetry", () => {
    expect(providerCapability("deepseek", "deepseek-v4-pro")).toMatchObject({
      resolved_model: "deepseek-v4-pro",
      context_window: 1_000_000,
      max_output: 262_144,
      thinking_supported: true,
      cache_telemetry_supported: true,
    });
  });

  it("normalizes legacy aliases and provider-specific model ids", () => {
    expect(providerCapability("nvidia-nim", "deepseek-chat")).toMatchObject({
      resolved_model: "deepseek-ai/deepseek-v4-flash",
      deprecation: expect.objectContaining({ alias: "deepseek-chat" }),
    });
    expect(providerCapability("deepseek", "deepseek/deepseek-v4-flash")).toMatchObject({
      resolved_model: "deepseek-v4-flash",
      context_window: 1_000_000,
    });
    expect(providerCapability("openrouter", "deepseek-ai/deepseek-v4-pro")).toMatchObject({
      resolved_model: "deepseek/deepseek-v4-pro",
      context_window: 1_000_000,
    });
    expect(providerCapability("nvidia-nim", "accounts/fireworks/models/deepseek-v4-flash")).toMatchObject({
      resolved_model: "deepseek-ai/deepseek-v4-flash",
      context_window: 1_000_000,
    });
  });

  it("bounds provider aliases and model names before capability matching", () => {
    expect(parseProvider("open_router")).toBe("openrouter");
    expect(parseProvider(`openrouter${String.fromCharCode(0)}`)).toBe("deepseek");
    expect(providerCapability("openrouter" as any, `deepseek-v4-pro${String.fromCharCode(0)}`)).toMatchObject({
      provider: "openrouter",
      resolved_model: "deepseek/deepseek-v4-pro",
      context_window: 1_000_000,
      max_output: 262_144,
    });
    expect(providerCapability("not-a-provider" as any, "deepseek-v4-flash")).toMatchObject({
      provider: "deepseek",
      resolved_model: "deepseek-v4-flash",
    });
    expect(normalizeModelName("x".repeat(600))).toBe("deepseek-v4-pro");
    expect(canonicalModelName("deepseek-v4-flash\u0007")).toBeNull();
    expect(isV4ProModel("prefix/deepseek-v4-pro")).toBe(true);
    expect(shouldReplayReasoningContent("deepseek-v4-pro\u0000", "high")).toBe(false);
    expect(shouldReplayReasoningContent("deepseek-v4-pro", "bad\u0000effort")).toBe(false);
  });

  it("extracts prompt cache telemetry from common response shapes", () => {
    expect(extractCachedInputTokens({ prompt_cache_hit_tokens: 12 })).toBe(12);
    expect(extractCachedInputTokens({ prompt_tokens_details: { cached_tokens: 7 } })).toBe(7);
    expect(extractCachedInputTokens({ cached_tokens: 1.5 })).toBe(0);
    expect(extractCachedInputTokens({ prompt_tokens_details: { cached_tokens: Number.POSITIVE_INFINITY } })).toBe(0);
  });

  it("fails closed when prompt cache telemetry fields throw", () => {
    const usage: Record<string, unknown> = {};
    Object.defineProperty(usage, "prompt_cache_hit_tokens", {
      enumerable: true,
      get() {
        throw new Error("cache getter failed");
      },
    });
    Object.defineProperty(usage, "prompt_tokens_details", {
      enumerable: true,
      get() {
        throw new Error("details getter failed");
      },
    });

    expect(extractCachedInputTokens(usage)).toBe(0);
  });
});

describe("StreamAccumulator", () => {
  it("sanitizes and bounds streamed UI accumulator buffers", () => {
    const acc = new StreamAccumulator();

    acc.addContent(`hi\u0000${"x".repeat(2_000_010)}`);
    acc.addReasoning(`why\u0007${"r".repeat(2_000_010)}`);
    for (let index = 0; index < 120; index++) {
      acc.addToolCallDelta(index, ` call_${index} `, " read ", index === 0 ? "a".repeat(1_100_000) : "{}");
    }
    acc.addToolCallDelta(-1, "bad", "read", "{}");
    acc.addToolCallDelta(1.5, "bad", "read", "{}");

    expect(acc.content).toHaveLength(2_000_000);
    expect(acc.content).not.toContain("\u0000");
    expect(acc.reasoning).toHaveLength(2_000_000);
    expect(acc.reasoning).not.toContain("\u0007");
    expect(acc.toolCalls.size).toBe(100);
    expect(acc.toolCalls.get(0)?.id).toBe("call_0");
    expect(acc.toolCalls.get(0)?.name).toBe("read");
    expect(acc.toolCalls.get(0)?.arguments).toHaveLength(1_000_000);
  });

  it("keeps accumulated UI stream buffers on full grapheme boundaries", () => {
    const acc = new StreamAccumulator();
    const family = "👨‍👩‍👧‍👦";

    acc.addContent(`${"x".repeat(1_999_995)}${family}tail`);
    acc.addReasoning(`${"r".repeat(1_999_995)}${family}tail`);
    acc.addToolCallDelta(0, "call_unicode", "read", `${"a".repeat(999_995)}${family}tail`);

    expect(acc.content).not.toContain(family);
    expect(acc.content).not.toContain("\u200d");
    expect(acc.reasoning).not.toContain(family);
    expect(acc.reasoning).not.toContain("\u200d");
    expect(acc.toolCalls.get(0)?.arguments).not.toContain(family);
    expect(acc.toolCalls.get(0)?.arguments).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(acc.content)).toBe(false);
    expect(hasUnpairedSurrogate(acc.reasoning)).toBe(false);
    expect(hasUnpairedSurrogate(acc.toolCalls.get(0)?.arguments || "")).toBe(false);
  });
});

async function* streamFrom(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

async function collect(iterable: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function nestedUsage(depth: number): Record<string, unknown> {
  let root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index++) {
    const next: Record<string, unknown> = {};
    cursor.child = next;
    cursor = next;
  }
  cursor.total_tokens = 1;
  return root;
}

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
