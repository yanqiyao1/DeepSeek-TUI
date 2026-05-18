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
      { type: "tool_call", data: { id: "call-1", name: "read", arguments: {} }, artifact_ids: ["art-1"] },
      { type: "tool_result", data: { tool_call_id: "call-1", name: "read", content: "ok", is_error: false }, artifact_ids: ["art-2"] },
    ]);

    expect(events).toMatchObject([
      { type: "tool_call", artifact_ids: ["art-1"] },
      { type: "tool_result", artifact_ids: ["art-2"] },
    ]);
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
      data: JSON.stringify({ seq: Number.NaN, thread_id: "thread-1", event: "content", data: {}, created_at: "now" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: -1, thread_id: "thread-1", event: "content", data: {}, created_at: "now" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8, thread_id: { nested: true }, event: "content", data: {}, created_at: "now" }),
    })).toBeNull();
    expect(parseRuntimeSSEFrame({
      id: "8",
      event: "content",
      data: JSON.stringify({ seq: 8, thread_id: "thread-1", event: "   ", data: {}, created_at: "now" }),
    })).toBeNull();
  });

  it("normalizes non-persisted runtime SSE frame ids and event names", () => {
    expect(parseRuntimeSSEFrame({ id: "3.7", event: " content ", data: JSON.stringify({ text: "ok" }) })).toMatchObject({
      seq: 3,
      event: "content",
      data: { text: "ok" },
    });
    expect(parseRuntimeSSEFrame({ id: "-9", event: "   ", data: JSON.stringify({ text: "ok" }) })).toMatchObject({
      seq: 0,
      event: "message",
    });
  });

  it("rejects nameless runtime SSE messages", () => {
    expect(parseRuntimeSSEMessage({ event: "   ", data: "{}" })).toBeNull();
    expect(parseRuntimeSSEMessage({ event: " content ", data: "{}" })).toEqual({ event: "content", data: {} });
  });

  it("streams runtime events through the shared API client parser", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("id: 1\nevent: content\ndata: {\"seq\":1,\"thread_id\":\"thread-1\",\"event\":\"content\",\"data\":{\"text\":\"Hi\"},\"created_at\":\"now\"}\n\n"));
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
