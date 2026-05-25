import { describe, expect, it } from "vitest";

import { emitRuntimeEvent } from "../src/engine/events.js";
import { generateTaskId, isActiveStatus, isTerminalStatus } from "../src/engine/task-lifecycle.js";
import { RuntimeApiClient } from "../src/server/runtime-client.js";
import { parseRuntimeSSEFrame, parseRuntimeSSEMessage, runtimeEventToSSE } from "../src/server/runtime-protocol.js";
import { formatJob } from "../src/tools/jobs.js";
import { runtimeItemToEngineRuntimeEvent, runtimeItemsToEngineRuntimeEvents, sessionMessagesToRuntimeEvents } from "../src/tui/runtime-replay.js";

describe("runtime replay helpers", () => {
  it("converts tool progress runtime items with artifact ids", () => {
    const event = runtimeItemToEngineRuntimeEvent({
      type: "tool_progress",
      data: {
        tool: "write",
        tool_call_id: "call-1",
        progress: { message: "halfway", percent: 50 },
      },
      artifact_ids: ["art-1"],
    });

    expect(event).toMatchObject({
      type: "tool_progress",
      artifact_ids: ["art-1"],
      data: {
        tool: "write",
        tool_call_id: "call-1",
        progress: { message: "halfway", percent: 50 },
      },
    });
  });

  it("filters unsafe runtime tool metadata and progress percentages during replay conversion", () => {
    const circular: Record<string, unknown> = { count: 1n, fn: () => "ignored" };
    circular.self = circular;
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "tool_call_begin", data: { name: "bad name", tool_call_id: "call-1" } },
      { type: "tool_call_begin", data: { name: "read", tool_call_id: "bad id", index: 1.5 } },
      { type: "tool_call", data: { id: "bad id", name: "read", arguments: { path: "bad.ts" } } },
      { type: "tool_call", data: { id: "call_good", name: "write", arguments: ["bad"] as any } },
      { type: "approval_required", data: { tool: "write", args: circular, description: "bad\0description" } },
      { type: "tool_result", data: { tool_call_id: "bad id", name: "write", content: "bad" } },
      { type: "tool_progress", data: { tool: "write", tool_call_id: "call_good", progress: { message: "ok", percent: 120, data: circular } } },
    ]);

    expect(events).toEqual([
      { type: "tool_call_begin", data: { name: "read" } },
      { type: "tool_call", data: { id: "call_good", name: "write", arguments: {} } },
      {
        type: "approval_required",
        data: { tool: "write", args: { count: "1", fn: null, self: "[Circular]" }, description: "bad description" },
      },
      {
        type: "tool_progress",
        data: {
          tool: "write",
          tool_call_id: "call_good",
          progress: { message: "ok", data: { count: "1", fn: null, self: "[Circular]" } },
        },
      },
    ]);
  });

  it("fails closed for throwing replay payloads without dropping useful progress events", () => {
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });

    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "approval_required", data: { tool: "write", args: throwing, description: "approve" } },
      { type: "tool_progress", data: { tool: "write", tool_call_id: "call_throw", progress: { message: "working", data: throwing } } },
      { type: "assistant_message", data: { role: "assistant", content: "ok", tool_calls: [{ id: "call_throw", name: "read", arguments: throwing }] } },
    ]);

    expect(events).toEqual([
      { type: "approval_required", data: { tool: "write", args: {}, description: "approve" } },
      { type: "tool_progress", data: { tool: "write", tool_call_id: "call_throw", progress: { message: "working", data: {} } } },
      {
        type: "assistant_message",
        data: {
          role: "assistant",
          content: "ok",
          tool_calls: [{ id: "call_throw", name: "read", arguments: {} }],
          tool_call_id: null,
          name: null,
          reasoning_content: null,
          is_error: null,
        },
      },
    ]);
  });

  it("replays assistant tool call order after assistant messages", () => {
    const events = sessionMessagesToRuntimeEvents([
      {
        role: "assistant",
        content: "calling tools",
        tool_calls: [
          { id: "call-1", name: "read", arguments: { path: "a.ts" } },
          { id: "call-2", name: "read", arguments: { path: "b.ts" } },
        ],
        tool_call_id: null,
        name: null,
        reasoning_content: null,
      },
    ]);

    expect(events.map(event => event.type)).toEqual(["assistant_message", "tool_call", "tool_call"]);
    expect(events.slice(1).map(event => (event as any).data.id)).toEqual(["call-1", "call-2"]);
  });

  it("limits session message replay to the most recent configured messages", () => {
    const events = sessionMessagesToRuntimeEvents([
      { role: "user", content: "one", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      { role: "user", content: "two", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      { role: "user", content: "three", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
    ], { maxMessages: 2 });

    expect(events).toMatchObject([
      { type: "user_message", data: { text: "two" } },
      { type: "user_message", data: { text: "three" } },
    ]);
  });

  it("preserves artifact ids when converting arrays of runtime items", () => {
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "tool_call", data: { id: "call-1", name: "read", arguments: {} }, artifact_ids: ["art-1", "../bad", "art-1"] },
      { type: "tool_result", data: { tool_call_id: "call-1", name: "read", content: "ok", is_error: false }, artifact_ids: ["art-2"] },
    ]);

    expect(events).toMatchObject([
      { type: "tool_call", artifact_ids: ["art-1"] },
      { type: "tool_result", artifact_ids: ["art-2"] },
    ]);
  });

  it("bounds persisted runtime replay arrays and artifact id fanout", () => {
    const events = runtimeItemsToEngineRuntimeEvents([
      ...Array.from({ length: 10_005 }, (_, index) => ({
        type: "content_delta",
        data: { text: `drop-${index}` },
      })),
      {
        type: "tool_result",
        data: { tool_call_id: "call-1", name: "read", content: "ok", is_error: false },
        artifact_ids: [
          ...Array.from({ length: 120 }, (_, index) => `art_${index}`),
          "../bad",
          "bad id",
        ],
      },
    ]);

    expect(events).toHaveLength(10_000);
    expect(events[0]).toMatchObject({ type: "content_delta", data: { text: "drop-6" } });
    expect(events.at(-1)?.artifact_ids).toHaveLength(100);
    expect(events.at(-1)?.artifact_ids).not.toContain("../bad");
  });

  it("converts tool call args runtime items", () => {
    const event = runtimeItemToEngineRuntimeEvent({
      type: "tool_call_args",
      data: {
        tool_call_id: "call-1",
        name: "write",
        index: 0,
        arguments: "{\"path\":\"a.ts\"",
      },
    });

    expect(event).toMatchObject({
      type: "tool_call_args",
      data: {
        tool_call_id: "call-1",
        name: "write",
        index: 0,
        arguments: "{\"path\":\"a.ts\"",
      },
    });
  });

  it("skips malformed persisted runtime items instead of stringifying objects into fake replay content", () => {
    const events = runtimeItemsToEngineRuntimeEvents([
      { type: "thinking_delta", data: { text: { nested: true } as any } },
      { type: "content_delta", data: { text: { nested: true } as any } },
      { type: "user_message", data: { text: { nested: true } as any } },
      { type: "tool_call_begin", data: { name: { nested: true } as any, tool_call_id: "call-1" } },
      { type: "approval_required", data: { tool: { nested: true } as any, args: { path: "draft.txt" } } },
      { type: "tool_call", data: { id: "call-1", name: { nested: true } as any, arguments: {} } },
      { type: "tool_result", data: { tool_call_id: "call-1", name: { nested: true } as any, content: "ok", is_error: false } },
      { type: "tool_progress", data: { tool: { nested: true } as any, tool_call_id: "call-1", progress: { message: "halfway" } } },
      { type: "content_delta", data: { text: "kept" } },
    ]);

    expect(events).toEqual([
      { type: "content_delta", data: { text: "kept" } },
    ]);
  });

  it("keeps replay compaction metrics finite when persisted runtime items are malformed", () => {
    const events = runtimeItemsToEngineRuntimeEvents([
      {
        type: "context_intervention",
        data: {
          compaction: {
            finalTokens: Number.NaN,
            removed_messages: Number.POSITIVE_INFINITY,
            preserved_messages: "7",
          },
        },
      },
      {
        type: "prefix_invalidated",
        data: {
          compaction: {
            finalTokens: Number.NaN,
            original_tokens: Number.POSITIVE_INFINITY,
            removed_messages: "3",
          },
        },
      },
    ]);

    expect((events[0] as any).data.compaction).toMatchObject({
      finalTokens: 0,
    });
    expect((events[0] as any).data.compaction).not.toHaveProperty("removed_messages");
    expect((events[0] as any).data.compaction).not.toHaveProperty("preserved_messages");
    expect((events[1] as any).data.compaction).toMatchObject({
      finalTokens: 0,
    });
    expect((events[1] as any).data.compaction).not.toHaveProperty("original_tokens");
    expect((events[1] as any).data.compaction).not.toHaveProperty("removed_messages");
  });

  it("bounds replay compaction action lists from persisted items and boundaries", () => {
    const actions = Array.from({ length: 150 }, (_, index) => `action-${index}`);
    const events = runtimeItemsToEngineRuntimeEvents([
      {
        type: "prefix_invalidated",
        data: {
          compaction: {
            actions,
            finalTokens: 1,
          },
        },
      },
    ]);
    const boundaryEvents = sessionMessagesToRuntimeEvents([
      {
        role: "system",
        name: "context_compaction_boundary",
        content: [
          "[Context compaction boundary]",
          "boundary_id: compact_test",
          "projected_tokens_after: 120",
          "actions:",
          ...actions.map(action => `- ${action}`),
        ].join("\n"),
        tool_calls: null,
        tool_call_id: null,
        reasoning_content: null,
      },
    ]);

    expect((events[0] as any).data.compaction.actions).toHaveLength(100);
    expect((boundaryEvents[0] as any).data.compaction.actions).toHaveLength(100);
  });

  it("sanitizes malformed replay session messages instead of fabricating fake tool and transcript content", () => {
    const events = sessionMessagesToRuntimeEvents([
      { role: "user", content: { nested: true } as any, tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      {
        role: "assistant",
        content: { nested: true } as any,
        tool_calls: [{ id: "call-1", name: { nested: true } as any, arguments: "bad" as any }],
        tool_call_id: null,
        name: null,
        reasoning_content: { nested: true } as any,
      } as any,
      { role: "tool", content: { nested: true } as any, tool_calls: null, tool_call_id: null, name: { nested: true } as any, reasoning_content: null } as any,
      { role: "assistant", content: "kept", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
    ]);

    expect(events).toEqual([
      {
        type: "assistant_message",
        data: {
          role: "assistant",
          content: null,
          tool_calls: [],
          tool_call_id: null,
          name: null,
          reasoning_content: null,
          is_error: null,
        },
      },
      {
        type: "assistant_message",
        data: {
          role: "assistant",
          content: "kept",
          tool_calls: null,
          tool_call_id: null,
          name: null,
          reasoning_content: null,
          is_error: null,
        },
      },
    ]);
  });

  it("sanitizes replay session messages while filtering unsafe tool ids and names", () => {
    const events = sessionMessagesToRuntimeEvents([
      { role: "user", content: "bad\0user", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null },
      {
        role: "assistant",
        content: "ok",
        tool_calls: [
          { id: "call_good", name: "read", arguments: { path: "ok.ts" } },
          { id: "bad id", name: "read", arguments: { path: "bad.ts" } },
        ],
        tool_call_id: null,
        name: null,
        reasoning_content: "bad\0reason",
      },
      { role: "tool", content: "bad", tool_calls: null, tool_call_id: "bad id", name: "read", reasoning_content: null, is_error: false },
      { role: "tool", content: "ok", tool_calls: null, tool_call_id: "call_good", name: "read", reasoning_content: null, is_error: false },
    ]);

    expect(events).toEqual([
      {
        type: "user_message",
        data: {
          text: "bad user",
        },
      },
      {
        type: "assistant_message",
        data: {
          role: "assistant",
          content: "ok",
          tool_calls: [{ id: "call_good", name: "read", arguments: { path: "ok.ts" } }],
          tool_call_id: null,
          name: null,
          reasoning_content: "bad reason",
          is_error: null,
        },
      },
      { type: "tool_call", data: { id: "call_good", name: "read", arguments: { path: "ok.ts" } } },
      {
        type: "tool_result",
        data: { tool_call_id: "call_good", name: "read", content: "ok", is_error: false },
        preview: "ok",
      },
    ]);
  });
});

describe("runtime event emission", () => {
  it("fans out runtime events to both unified and legacy callbacks", async () => {
    const calls: string[] = [];

    await emitRuntimeEvent({
      onRuntimeEvent: async (event) => { calls.push(`runtime:${event.type}`); },
      onRuntimeItem: async (event) => { calls.push(`item:${event.type}`); },
      onToolExecuted: async (name, preview) => { calls.push(`tool:${name}:${preview}`); },
    }, {
      type: "tool_result",
      data: { tool_call_id: "call-1", name: "write", content: "ok", is_error: false },
      preview: "preview text",
    });

    expect(calls).toEqual([
      "runtime:tool_result",
      "item:tool_result",
      "tool:write:preview text",
    ]);
  });

  it("does nothing when no callbacks are registered", async () => {
    await expect(emitRuntimeEvent(undefined, { type: "content_delta", data: { text: "ok" } })).resolves.toBeUndefined();
  });
});

describe("server runtime protocol", () => {
  it("shares SSE event mapping outside HTTP handlers", () => {
    const streamed = new Set<string>();

    expect(runtimeEventToSSE({ type: "content_delta", data: { text: "ok" } }, streamed)).toEqual({
      event: "content",
      data: { text: "ok" },
    });
    expect(runtimeEventToSSE({ type: "tool_call_begin", data: { name: "read", tool_call_id: "call-1" } }, streamed)).toEqual({
      event: "tool_call",
      data: { name: "read", tool_call_id: "call-1" },
    });
    expect(runtimeEventToSSE({ type: "tool_call", data: { id: "call-1", name: "read", arguments: {} } }, streamed)).toBeNull();
  });

  it("sanitizes runtime events before mapping them to public SSE frames", () => {
    const streamed = new Set<string>();
    const large = "x".repeat(250_000);

    expect(runtimeEventToSSE({ type: "content_delta", data: { text: `hi\u0000${large}` } }, streamed as Set<string>)).toEqual({
      event: "content",
      data: { text: `hi ${"x".repeat(199_997)}` },
    });
    expect(runtimeEventToSSE({ type: "tool_call_begin", data: { name: "bad name", tool_call_id: "call_1" } }, streamed)).toBeNull();
    expect(runtimeEventToSSE({ type: "tool_call", data: { id: "bad id", name: "read", arguments: {} } }, streamed)).toEqual({
      event: "tool_call",
      data: { name: "read" },
    });
    expect(runtimeEventToSSE({
      type: "tool_result",
      data: { tool_call_id: "call_1", name: "read", content: "ok", is_error: false },
      preview: `ok\u0000${large}`,
      artifact_ids: ["art_1", "../bad", "art_1", ...Array.from({ length: 120 }, (_, index) => `art_${index + 2}`)],
    }, streamed)).toEqual({
      event: "tool_result",
      data: {
        name: "read",
        preview: `ok ${"x".repeat(199_997)}`,
        artifact_ids: ["art_1", ...Array.from({ length: 99 }, (_, index) => `art_${index + 2}`)],
      },
    });
    expect(runtimeEventToSSE({
      type: "tool_progress",
      data: { tool: "write", tool_call_id: "call_1", progress: { message: "half\u0000way", percent: 120, data: { payload: "x".repeat(600_000) } } },
    }, streamed)).toEqual({
      event: "tool_progress",
      data: {
        tool: "write",
        tool_call_id: "call_1",
        progress: { message: "half way", data: { truncated: true } },
      },
    });
  });

  it("parses persisted runtime events from SSE frames", () => {
    const event = parseRuntimeSSEFrame({
      id: "7",
      event: "content",
      data: JSON.stringify({
        seq: 7,
        thread_id: "thread-1",
        event: "content",
        data: { text: "ok" },
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    });

    expect(event).toMatchObject({
      seq: 7,
      thread_id: "thread-1",
      event: "content",
      data: { text: "ok" },
    });
  });

  it("rejects malformed persisted runtime events from SSE frames", () => {
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8, event: "content", data: {}, created_at: "2026-01-01T00:00:00.000Z" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: Number.NaN, thread_id: "thread-1", event: "content", data: {}, created_at: "2026-01-01T00:00:00.000Z" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: -1, thread_id: "thread-1", event: "content", data: {}, created_at: "2026-01-01T00:00:00.000Z" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8.7, thread_id: "thread-1", event: "content", data: {}, created_at: "2026-01-01T00:00:00.000Z" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8, thread_id: { nested: true }, event: "content", data: {}, created_at: "2026-01-01T00:00:00.000Z" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8, thread_id: "thread-1", event: "   ", data: {}, created_at: "2026-01-01T00:00:00.000Z" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8, thread_id: "thread-1", event: "bad event", data: {}, created_at: "2026-01-01T00:00:00.000Z" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8, thread_id: "thread/1", event: "content", data: {}, created_at: "2026-01-01T00:00:00.000Z" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8, thread_id: "thread-1", event: "content", data: {}, created_at: "now" }),
    })).toBeNull();
  });

  it("normalizes non-persisted runtime SSE frame ids and rejects unsafe event names", () => {
    expect(parseRuntimeSSEFrame({ id: "3", event: " content ", data: JSON.stringify({ text: "ok" }) })).toMatchObject({
      seq: 3,
      event: "content",
      data: { text: "ok" },
    });
    expect(parseRuntimeSSEFrame({ id: "3.7", event: " content ", data: JSON.stringify({ text: "ok" }) })).toMatchObject({
      seq: 0,
      event: "content",
    });
    expect(parseRuntimeSSEFrame({ id: "-9", event: "bad event", data: JSON.stringify({ text: "ok" }) })).toMatchObject({
      seq: 0,
      event: "message",
    });
  });

  it("rejects nameless runtime SSE messages", () => {
    expect(parseRuntimeSSEMessage({ event: "   ", data: "{}" })).toBeNull();
    expect(parseRuntimeSSEMessage({ event: "bad event", data: "{}" })).toBeNull();
    expect(parseRuntimeSSEMessage({ event: " content ", data: "{}" })).toEqual({ event: "content", data: {} });
  });

  it("bounds parsed SSE frame payloads before handing them to runtime consumers", () => {
    const large = "x".repeat(1_000_001);

    expect(parseRuntimeSSEMessage({ event: "content", data: "x".repeat(2_000_001) })).toEqual({
      event: "content",
      data: { truncated: true },
    });
    expect(parseRuntimeSSEMessage({ event: "content", data: JSON.stringify({ text: large }) })).toEqual({
      event: "content",
      data: { truncated: true },
    });
    expect(parseRuntimeSSEFrame({
      id: "9",
      event: "content",
      data: JSON.stringify({
        seq: 9,
        thread_id: "thread-1",
        event: "content",
        data: { text: large },
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    })).toMatchObject({ seq: 9, data: { truncated: true } });
  });

  it("fails closed when SSE frame payload normalization throws", () => {
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });

    expect(parseRuntimeSSEMessage({ event: "content", data: throwing as any })).toEqual({
      event: "content",
      data: { truncated: true },
    });
    expect(runtimeEventToSSE({
      type: "tool_progress",
      data: { tool: "write", progress: { data: throwing } },
    }, new Set())).toEqual({
      event: "tool_progress",
      data: { tool: "write", progress: { data: { truncated: true } } },
    });
  });

  it("streams runtime events through the shared API client parser", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 1\nevent: content\ndata: {\"seq\":1,\"thread_id\":\"thread-1\",\"event\":\"content\",\"data\":{\"text\":\"Hi\"},\"created_at\":\"2026-01-01T00:00:00.000Z\"}\n\n"));
        controller.close();
      },
    });
    const client = new RuntimeApiClient({
      baseUrl: "http://runtime.test",
      fetchImpl: async () => new Response(body, { status: 200 }) as any,
    });

    const events = [];
    for await (const event of client.streamThreadEvents("thread-1")) events.push(event);

    expect(events).toMatchObject([
      { seq: 1, thread_id: "thread-1", event: "content", data: { text: "Hi" } },
    ]);
  });

  it("normalizes runtime API client URLs, ids, headers, json, and sequence values", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = new RuntimeApiClient({
      baseUrl: " http://runtime.test/root/?drop=1#frag ",
      headers: {
        authorization: "Bearer ok",
        " bad\nheader": "drop",
        "x-bad": "drop\r\nvalue",
      },
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), headers: init?.headers as Record<string, string> });
        return Response.json(String(input).includes("/events")
          ? { events: "not-array" }
          : { items: [{ seq: 1, id: "item_1", thread_id: "thread-1", type: "content", data: {}, artifact_ids: [], created_at: "2026-01-01T00:00:00.000Z" }] });
      },
    });

    const items = await client.getThreadItems(" thread/one ", -1);
    const events = await client.getThreadEvents(" thread/one ", 3.7);

    expect(items).toHaveLength(1);
    expect(events).toEqual([]);
    expect(seen[0].url).toBe("http://runtime.test/root/v1/threads/thread%2Fone/items?since_seq=0");
    expect(seen[1].url).toBe("http://runtime.test/root/v1/threads/thread%2Fone/events?since_seq=0");
    expect(seen[0].headers).toMatchObject({ authorization: "Bearer ok" });
    expect(Object.keys(seen[0].headers)).not.toEqual(expect.arrayContaining([" bad\nheader", "x-bad"]));
  });

  it("normalizes runtime API client array responses and bounds SSE tail chunks", async () => {
    const largeTail = "event: content\ndata: " + "x".repeat(256_001);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(largeTail));
        controller.close();
      },
    });
    const client = new RuntimeApiClient({
      baseUrl: "http://runtime.test",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/items")) return Response.json({ items: [{ bad: true }, { seq: 1, id: "item_1", thread_id: "thread-1", type: "content_delta", data: { text: "ok" }, artifact_ids: [], created_at: "2026-01-01T00:00:00.000Z" }] });
        if (url.includes("/events")) return new Response(body, { status: 200 });
        return Response.json({});
      },
    });

    await expect(client.getThreadItems("thread-1")).resolves.toEqual([
      { seq: 1, id: "item_1", thread_id: "thread-1", type: "content_delta", data: { text: "ok" }, artifact_ids: [], created_at: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(async () => {
      for await (const _event of client.streamThreadEvents("thread-1")) {
        // consume
      }
    }).rejects.toThrow(/chunk is too large/);
  });

  it("allows multiline runtime chat messages but rejects unsafe controls", async () => {
    const seen: string[] = [];
    const client = new RuntimeApiClient({
      baseUrl: "http://runtime.test",
      fetchImpl: async (_input, init) => {
        seen.push(String(init?.body));
        return new Response("event: done\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const events = [];
    for await (const event of client.chat("session-1", "line one\nline two")) events.push(event);

    expect(events).toEqual([{ event: "done", data: {} }]);
    expect(JSON.parse(seen[0]!).message).toBe("line one\nline two");
    await expect(client.chat("session-1", "bad\u0000message").next()).rejects.toThrow(/message is invalid/);
  });

  it("rejects unsafe runtime API client base URLs and invalid JSON responses", async () => {
    expect(() => new RuntimeApiClient({ baseUrl: "ftp://runtime.test" })).toThrow(/http or https/);
    expect(() => new RuntimeApiClient({ baseUrl: "http://user:pass@runtime.test" })).toThrow(/credentials/);
    expect(() => new RuntimeApiClient({ baseUrl: "not a url" })).toThrow(/valid URL/);

    const client = new RuntimeApiClient({
      baseUrl: "http://runtime.test",
      fetchImpl: async () => new Response("{", { status: 200 }),
    });

    await expect(client.getThreadEvents("thread-1")).rejects.toThrow(/invalid JSON/);
  });

  it("streams runtime chat messages through the shared API client parser while dropping malformed frames", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: content\ndata: {\"text\":\"Hi\"}\n\n"));
        controller.enqueue(encoder.encode("event: bad event\ndata: {\"text\":\"drop\"}\n\n"));
        controller.enqueue(encoder.encode("event: done\ndata: {\"ok\":true}\n\n"));
        controller.close();
      },
    });
    const client = new RuntimeApiClient({
      baseUrl: "http://runtime.test",
      fetchImpl: async () => new Response(body, { status: 200 }) as any,
    });

    const events = [];
    for await (const event of client.chat(" session-1 ", "hello")) events.push(event);

    expect(events).toEqual([
      { event: "content", data: { text: "Hi" } },
      { event: "done", data: { ok: true } },
    ]);
  });
});

describe("task lifecycle helpers", () => {
  it("generates stable task ids with the expected prefixes", () => {
    expect(generateTaskId("bash")).toMatch(/^b[a-z0-9]{8}$/);
    expect(generateTaskId("background")).toMatch(/^bg[a-z0-9]{8}$/);
    expect(generateTaskId("remote_agent")).toMatch(/^r[a-z0-9]{8}$/);
  });

  it("classifies active and terminal statuses consistently", () => {
    expect(isActiveStatus("pending")).toBe(true);
    expect(isActiveStatus("running")).toBe(true);
    expect(isActiveStatus("completed")).toBe(false);
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("killed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("job formatting", () => {
  it("formats job details and trims output tails", () => {
    const text = formatJob({
      id: "job_123",
      command: "printf hello",
      workdir: "/tmp/workspace",
      status: "completed",
      exitCode: 0,
      signal: null,
      startedAt: 1_000,
      endedAt: 4_500,
      output: "abcdef",
      pid: 42,
      logFile: "/tmp/job.log",
      inputFile: "/tmp/job.in",
      pty: false,
      reattachable: false,
    }, 3);

    expect(text).toContain("status: completed");
    expect(text).toContain("elapsed: 3.5s");
    expect(text).toContain("exit_code: 0");
    expect(text).toContain("pty: no");
    expect(text).toContain("reattachable: no");
    expect(text).toContain("def");
    expect(text).not.toContain("abc");
  });
});
