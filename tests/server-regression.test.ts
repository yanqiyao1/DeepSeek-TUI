import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientSendMocks = vi.hoisted((): Array<() => AsyncIterable<any>> => []);

vi.mock("../src/client/deepseek.js", () => ({
  DeepSeekClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(() => {
      const mock = clientSendMocks.shift();
      if (mock) return mock();
      return defaultClientSend();
    }),
  })),
}));

async function* defaultClientSend() {
  yield { type: "content", text: "ok" };
  yield { type: "done", finish_reason: "stop", usage: { total_tokens: 1 }, content: "ok", reasoning_content: null, tool_calls: [] };
}

const { createApp } = await import("../src/server/app.js");
const { serve } = await import("@hono/node-server");
const {
  appendEvent,
  appendRuntimeItem,
  clearRuntimeStoreForTests,
  createTurn,
  deleteRuntimeRecordBySession,
  forkRuntimeThread,
  getRuntimeRecord,
  getRuntimeRecordBySession,
  reloadRuntimeStoreForTests,
  replayRuntimeEvents,
  replayRuntimeItems,
  subscribeRuntimeEvents,
  updateRuntimeThread,
  updateTurn,
} = await import("../src/server/runtime-store.js");
const { clearArtifactsForTests, listArtifactLinks } = await import("../src/artifacts/store.js");
const { parseSSEFrames } = await import("../src/server/transport.js");
const { RuntimeApiClient } = await import("../src/server/runtime-client.js");

describe("HTTP/SSE server", () => {
  const oldApiKey = process.env.DEEPSEEK_API_KEY;
  let tmp: string;
  let oldRuntimeDir: string | undefined;
  let oldArtifactsDir: string | undefined;
  let oldServerToken: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "seek-code-server-runtime-"));
    oldRuntimeDir = process.env.DEEPCODE_RUNTIME_DIR;
    oldArtifactsDir = process.env.DEEPCODE_ARTIFACTS_DIR;
    oldServerToken = process.env.SEEKCODE_SERVER_TOKEN;
    process.env.DEEPCODE_RUNTIME_DIR = tmp;
    process.env.DEEPCODE_ARTIFACTS_DIR = join(tmp, "artifacts");
    delete process.env.SEEKCODE_SERVER_TOKEN;
    clientSendMocks.length = 0;
    clearRuntimeStoreForTests();
    clearArtifactsForTests();
  });

  afterEach(() => {
    if (oldApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldApiKey;
    clearRuntimeStoreForTests();
    clearArtifactsForTests();
    if (oldRuntimeDir === undefined) delete process.env.DEEPCODE_RUNTIME_DIR;
    else process.env.DEEPCODE_RUNTIME_DIR = oldRuntimeDir;
    if (oldArtifactsDir === undefined) delete process.env.DEEPCODE_ARTIFACTS_DIR;
    else process.env.DEEPCODE_ARTIFACTS_DIR = oldArtifactsDir;
    if (oldServerToken === undefined) delete process.env.SEEKCODE_SERVER_TOKEN;
    else process.env.SEEKCODE_SERVER_TOKEN = oldServerToken;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fails closed when the runtime data root is a symlink", async () => {
    const outside = join(tmp, "outside-runtime");
    const runtimeLink = join(tmp, "runtime-link");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, runtimeLink, "dir");
    process.env.DEEPCODE_RUNTIME_DIR = runtimeLink;
    reloadRuntimeStoreForTests();

    const app = createApp();
    const response = await app.request("/v1/session", { method: "POST" });

    expect(response.status).toBe(200);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("serves OpenAPI metadata and enforces optional bearer auth on runtime routes", async () => {
    let app = createApp();
    const openapi = await (await app.request("/v1/openapi.json")).json() as { openapi: string; paths: Record<string, unknown> };

    expect(openapi.openapi).toBe("3.1.0");
    expect(openapi.paths["/v1/threads"]).toBeTruthy();

    process.env.SEEKCODE_SERVER_TOKEN = "secret";
    app = createApp();
    const health = await app.request("/v1/health");
    const unauthorized = await app.request("/v1/tools");
    const authorized = await app.request("/v1/tools", { headers: { authorization: "Bearer secret" } });

    expect(health.status).toBe(200);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ error: "unauthorized" });
    expect(authorized.status).toBe(200);
  });

  it("executes tool calls and emits tool_result events", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    clientSendMocks.push(
      async function* () {
        yield { type: "tool_call_begin", index: 0, tool_call_id: "call_1", name: "read" };
        yield { type: "done", finish_reason: "tool_calls", usage: null, content: "", reasoning_content: null, tool_calls: [{ id: "call_1", name: "read", arguments: { path: "package.json" } }] };
      },
      async function* () {
        yield { type: "content", text: "read complete" };
        yield { type: "done", finish_reason: "stop", usage: { total_tokens: 1 }, content: "read complete", reasoning_content: null, tool_calls: [] };
      },
    );
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const { session_id, thread_id } = await createResp.json() as { session_id: string; thread_id: string };

    const chatResp = await app.request(`/v1/session/${session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "read package" }),
    });
    const body = await chatResp.text();
    const items = await (await app.request(`/v1/threads/${thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string; data: any }> };

    expect(body).toContain("event: tool_call");
    expect(body).toContain("event: tool_result");
    expect(body).toContain("event: content");
    expect(body).toContain("event: done");
    expect(items.items.map(item => item.type)).toEqual(expect.arrayContaining(["user_message", "tool_call_begin", "tool_call", "tool_result", "content_delta"]));
    expect(items.items.find(item => item.type === "tool_result")?.data).toMatchObject({ name: "read", is_error: false });
  });

  it("rejects malformed chat request bodies before creating turns or entering the engine path", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };

    const invalidJson = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const nonString = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { nested: true } }),
    });
    const blank = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    const nulMessage = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "keep\u0000bad" }),
    });

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: "invalid JSON body" });
    expect(nonString.status).toBe(400);
    expect(await nonString.json()).toMatchObject({ error: "message must be a string" });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toMatchObject({ error: "message required" });
    expect(nulMessage.status).toBe(400);
    expect(await nulMessage.json()).toMatchObject({ error: "message must not contain control characters" });
    expect(getRuntimeRecord(created.thread_id)!.turns).toHaveLength(0);
  });

  it("rejects oversized chat and JSON request bodies before mutating runtime state", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };

    const oversizedMessage = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(200_001) }),
    });
    const oversizedJson = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "1000001" },
      body: JSON.stringify({ model: "deepseek-v4-pro" }),
    });

    expect(oversizedMessage.status).toBe(400);
    expect(await oversizedMessage.json()).toMatchObject({ error: "message is too long" });
    expect(oversizedJson.status).toBe(400);
    expect(await oversizedJson.json()).toMatchObject({ error: "invalid JSON body" });
    expect(getRuntimeRecord(created.thread_id)!.turns).toHaveLength(0);
  });

  it("preserves non-empty chat message whitespace in runtime turns, input items, and history", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    const rawMessage = "\n  keep this exact input \t ";

    const chatResp = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: rawMessage }),
    });
    await chatResp.text();
    const record = getRuntimeRecord(created.thread_id)!;
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as {
      items: Array<{ type: string; data: { message?: string } }>;
    };

    expect(chatResp.status).toBe(200);
    expect(record.turns.at(-1)?.message).toBe(rawMessage);
    expect(record.session.messages.some(message => message.role === "user" && message.content === rawMessage)).toBe(true);
    expect(items.items.find(item => item.type === "turn_input")?.data.message).toBe(rawMessage);
  });

  it("rejects array chat bodies instead of treating them like object payloads with a missing message field", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };

    const arrayBody = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["bad"]),
    });

    expect(arrayBody.status).toBe(400);
    expect(await arrayBody.json()).toMatchObject({ error: "invalid JSON body" });
    expect(getRuntimeRecord(created.thread_id)!.turns).toHaveLength(0);
  });

  it("exposes session/thread runtime APIs including replay, fork, resume, and delete", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { session_id: string; thread_id: string };

    const sessions = await (await app.request("/v1/sessions")).json() as { sessions: Array<{ id: string }> };
    const resumed = await (await app.request(`/v1/sessions/${created.session_id}/resume-thread`, { method: "POST" })).json() as { thread_id: string };
    const thread = await (await app.request(`/v1/threads/${created.thread_id}`)).json() as { thread: { id: string } };
    const patched = await (await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    })).json() as { thread: { archived: boolean } };
    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as { events: unknown[] };
    mkdirSync(join(tmp, "skills", "api-skill"), { recursive: true });
    writeFileSync(join(tmp, "skills", "api-skill", "SKILL.md"), "---\nname: api-skill\ndescription: runtime skill\n---\n\nUse runtime skill.\n");
    const skills = await (await app.request(`/v1/skills?workspace=${encodeURIComponent(tmp)}`)).json() as { skills: Array<{ name: string }> };
    const badSkillsWorkspace = await app.request(`/v1/skills?workspace=${encodeURIComponent(`${tmp}\u0000bad`)}`);
    appendRuntimeItem(getRuntimeRecord(created.thread_id)!, "artifact_test", { artifact_id: "log_m123456_deadbeef00" });
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string; artifact_ids: string[] }> };
    const fork = await (await app.request(`/v1/threads/${created.thread_id}/fork`, { method: "POST" })).json() as { thread: { id: string } };
    const deleted = await (await app.request(`/v1/sessions/${created.session_id}`, { method: "DELETE" })).json() as { deleted: boolean };

    expect(sessions.sessions.some(session => session.id === created.session_id)).toBe(true);
    expect(resumed.thread_id).toBe(created.thread_id);
    expect(thread.thread.id).toBe(created.thread_id);
    expect(patched.thread.archived).toBe(true);
    expect(events.events.length).toBeGreaterThan(0);
    expect(skills.skills.some(skill => skill.name === "api-skill")).toBe(true);
    expect(badSkillsWorkspace.status).toBe(400);
    expect(await badSkillsWorkspace.json()).toMatchObject({ error: "workspace must not contain control characters" });
    expect(items.items.some(item => item.type === "artifact_test" && item.artifact_ids.includes("log_m123456_deadbeef00"))).toBe(true);
    expect(fork.thread.id).not.toBe(created.thread_id);
    expect(deleted.deleted).toBe(true);
  });

  it("normalizes non-JSON runtime item and event payloads before persistence and replay", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const circular: any = { count: 7n, nested: { keep: true }, skipped: undefined };
    circular.self = circular;

    appendRuntimeItem(record, "json_safe", circular);
    appendEvent(record, "json.safe", { count: 9n, fn: () => "ignored", circular });
    reloadRuntimeStoreForTests();

    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as {
      items: Array<{ type: string; data: any }>;
    };
    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as {
      events: Array<{ event: string; data: any }>;
    };
    const item = items.items.find(entry => entry.type === "json_safe");
    const event = events.events.find(entry => entry.event === "json.safe");

    expect(item?.data).toMatchObject({ count: "7", nested: { keep: true }, skipped: null, self: "[Circular]" });
    expect(event?.data).toMatchObject({
      count: "9",
      fn: null,
      circular: { count: "7", self: "[Circular]" },
    });
  });

  it("creates threads with overridden mode/model reflected in runtime config and prefix", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();

    const createResp = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "yolo", model: "deepseek-v4-flash", workspace: tmp }),
    });
    const created = await createResp.json() as { thread: { id: string; mode: string; model: string }; prefix_hash: string };
    const record = getRuntimeRecord(created.thread.id)!;

    expect(created.thread.mode).toBe("yolo");
    expect(created.thread.model).toBe("deepseek-v4-flash");
    expect(record.config.mode).toBe("yolo");
    expect(record.config.model).toBe("deepseek-v4-flash");
    expect(record.prefix?.hash).toBe(created.prefix_hash);
    expect(record.prefix?.systemPrompt).toContain("## YOLO Mode");
  });

  it("rejects malformed create-thread overrides instead of persisting non-string runtime config state", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();

    const badModel = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: { nested: true } }),
    });
    const badMode = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: 7 }),
    });
    const badWorkspace = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: { nested: true } }),
    });
    const blankModel = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "   " }),
    });
    const badModeName = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "debug" }),
    });
    const blankWorkspace = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "   " }),
    });
    const nulWorkspace = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: `${tmp}\u0000bad` }),
    });

    expect(badModel.status).toBe(400);
    expect(await badModel.json()).toMatchObject({ error: "model must be a string" });
    expect(badMode.status).toBe(400);
    expect(await badMode.json()).toMatchObject({ error: "mode must be a string" });
    expect(badWorkspace.status).toBe(400);
    expect(await badWorkspace.json()).toMatchObject({ error: "workspace must be a string" });
    expect(blankModel.status).toBe(400);
    expect(await blankModel.json()).toMatchObject({ error: "model must be a non-empty string" });
    expect(badModeName.status).toBe(400);
    expect(await badModeName.json()).toMatchObject({ error: "mode must be one of plan, agent, or yolo" });
    expect(blankWorkspace.status).toBe(400);
    expect(await blankWorkspace.json()).toMatchObject({ error: "workspace must be a non-empty string" });
    expect(nulWorkspace.status).toBe(400);
    expect(await nulWorkspace.json()).toMatchObject({ error: "workspace must not contain control characters" });
  });

  it("rejects invalid JSON for thread creation instead of silently creating a default thread", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();

    const invalidJson = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const threads = await (await app.request("/v1/threads")).json() as { threads: Array<{ id: string }> };

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: "invalid JSON body" });
    expect(threads.threads).toEqual([]);
  });

  it("rejects array bodies for thread creation instead of treating them like empty object payloads", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();

    const arrayBody = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["bad"]),
    });
    const threads = await (await app.request("/v1/threads")).json() as { threads: Array<{ id: string }> };

    expect(arrayBody.status).toBe(400);
    expect(await arrayBody.json()).toMatchObject({ error: "invalid JSON body" });
    expect(threads.threads).toEqual([]);
  });

  it("trims create-thread string overrides before persisting runtime state", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();

    const createResp = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "\tdeepseek-v4-pro\n", mode: "\tagent\n", workspace: `  ${tmp}  ` }),
    });
    const created = await createResp.json() as { thread: { id: string; model: string; mode: string; workspace: string } };
    const record = getRuntimeRecord(created.thread.id)!;

    expect(createResp.status).toBe(200);
    expect(created.thread).toMatchObject({
      model: "deepseek-v4-pro",
      mode: "agent",
      workspace: tmp,
    });
    expect(record.session.model).toBe("deepseek-v4-pro");
    expect(record.session.mode).toBe("agent");
    expect(record.session.workspace_path).toBe(tmp);
    expect(record.config.model).toBe("deepseek-v4-pro");
    expect(record.config.mode).toBe("agent");
  });

  it("rejects malformed thread patch fields instead of returning a misleading successful update", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };

    const badArchived = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: "yes" }),
    });
    const badMode = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: 7 }),
    });
    const badModel = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: { nested: true } }),
    });
    const badWorkspace = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: { nested: true } }),
    });
    const blankModel = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "   " }),
    });
    const badModeName = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "debug" }),
    });
    const blankWorkspace = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "   " }),
    });
    const nulWorkspace = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: `${tmp}\u0000bad` }),
    });

    expect(badArchived.status).toBe(400);
    expect(await badArchived.json()).toMatchObject({ error: "archived must be a boolean" });
    expect(badMode.status).toBe(400);
    expect(await badMode.json()).toMatchObject({ error: "mode must be a string" });
    expect(badModel.status).toBe(400);
    expect(await badModel.json()).toMatchObject({ error: "model must be a string" });
    expect(badWorkspace.status).toBe(400);
    expect(await badWorkspace.json()).toMatchObject({ error: "workspace must be a string" });
    expect(blankModel.status).toBe(400);
    expect(await blankModel.json()).toMatchObject({ error: "model must be a non-empty string" });
    expect(badModeName.status).toBe(400);
    expect(await badModeName.json()).toMatchObject({ error: "mode must be one of plan, agent, or yolo" });
    expect(blankWorkspace.status).toBe(400);
    expect(await blankWorkspace.json()).toMatchObject({ error: "workspace must be a non-empty string" });
    expect(nulWorkspace.status).toBe(400);
    expect(await nulWorkspace.json()).toMatchObject({ error: "workspace must not contain control characters" });
  });

  it("rejects invalid JSON for thread patches instead of treating it like an empty successful update", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const before = getRuntimeRecord(created.thread_id)!.thread.updated_at;

    const invalidJson = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    const after = getRuntimeRecord(created.thread_id)!.thread.updated_at;

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: "invalid JSON body" });
    expect(after).toBe(before);
  });

  it("rejects array bodies for thread patches instead of accepting a no-op update", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const before = getRuntimeRecord(created.thread_id)!.thread.updated_at;

    const arrayBody = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["bad"]),
    });
    const after = getRuntimeRecord(created.thread_id)!.thread.updated_at;

    expect(arrayBody.status).toBe(400);
    expect(await arrayBody.json()).toMatchObject({ error: "invalid JSON body" });
    expect(after).toBe(before);
  });

  it("trims thread patch string fields before updating runtime state", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };

    const patchResp = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "\tdeepseek-v4-flash\n", mode: "\tplan\n", workspace: `  ${tmp}  ` }),
    });
    const patched = await patchResp.json() as { thread: { model: string; mode: string; workspace: string } };
    const record = getRuntimeRecord(created.thread_id)!;

    expect(patchResp.status).toBe(200);
    expect(patched.thread).toMatchObject({
      model: "deepseek-v4-flash",
      mode: "plan",
      workspace: tmp,
    });
    expect(record.session.model).toBe("deepseek-v4-flash");
    expect(record.session.mode).toBe("plan");
    expect(record.session.workspace_path).toBe(tmp);
    expect(record.config.model).toBe("deepseek-v4-flash");
    expect(record.config.mode).toBe("plan");
  });

  it("falls back to default list and replay bounds when numeric query params are invalid", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();

    const sessionA = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    const sessionB = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    appendEvent(getRuntimeRecord(sessionA.thread_id)!, "custom.one", { ok: 1 });
    appendRuntimeItem(getRuntimeRecord(sessionA.thread_id)!, "custom_item", { ok: 1 });

    const sessions = await (await app.request("/v1/sessions?limit=bogus")).json() as { sessions: Array<{ id: string }> };
    const threads = await (await app.request("/v1/threads?limit=bogus")).json() as { threads: Array<{ id: string }> };
    const events = await (await app.request(`/v1/threads/${sessionA.thread_id}/events?since_seq=bogus`)).json() as { events: Array<{ event: string }> };
    const items = await (await app.request(`/v1/threads/${sessionA.thread_id}/items?since_seq=bogus`)).json() as { items: Array<{ type: string }> };

    expect(sessions.sessions.map(session => session.id)).toEqual(expect.arrayContaining([sessionA.session_id, sessionB.session_id]));
    expect(threads.threads.map(thread => thread.id)).toEqual(expect.arrayContaining([sessionA.thread_id, sessionB.thread_id]));
    expect(events.events.map(event => event.event)).toEqual(expect.arrayContaining(["thread.started", "custom.one", "item.custom_item"]));
    expect(items.items.map(item => item.type)).toContain("custom_item");
  });

  it("keeps bounded query text on grapheme boundaries", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const query = encodeURIComponent(`${"x".repeat(4095)}👨‍👩‍👧‍👦`);

    const sessions = await (await app.request(`/v1/sessions?search=${query}`)).json() as { sessions: Array<{ id: string }> };
    const threads = await (await app.request(`/v1/threads?workspace=${query}`)).json() as { threads: Array<{ id: string }> };

    expect(sessions.sessions).toEqual([]);
    expect(threads.threads).toEqual([]);
  });

  it("rejects unsafe runtime path ids before store lookup", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const longId = "x".repeat(129);

    const thread = await app.request(`/v1/threads/${longId}`);
    const session = await app.request(`/v1/sessions/${longId}`);
    const items = await app.request(`/v1/threads/${longId}/items`);

    expect(thread.status).toBe(400);
    expect(await thread.json()).toMatchObject({ error: "invalid thread id" });
    expect(session.status).toBe(400);
    expect(await session.json()).toMatchObject({ error: "invalid session id" });
    expect(items.status).toBe(400);
    expect(await items.json()).toMatchObject({ error: "invalid thread id" });
  });

  it("parses include_archived query booleans without hiding explicit true variants", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });

    const omitted = await (await app.request("/v1/threads")).json() as { threads: Array<{ id: string }> };
    const uppercaseTrue = await (await app.request("/v1/threads?include_archived=TRUE")).json() as { threads: Array<{ id: string }> };
    const oneTrue = await (await app.request("/v1/threads?include_archived=1")).json() as { threads: Array<{ id: string }> };
    const explicitFalse = await (await app.request("/v1/threads?include_archived=false")).json() as { threads: Array<{ id: string }> };
    const invalid = await (await app.request("/v1/threads?include_archived=maybe")).json() as { threads: Array<{ id: string }> };

    expect(omitted.threads.map(thread => thread.id)).not.toContain(created.thread_id);
    expect(uppercaseTrue.threads.map(thread => thread.id)).toContain(created.thread_id);
    expect(oneTrue.threads.map(thread => thread.id)).toContain(created.thread_id);
    expect(explicitFalse.threads.map(thread => thread.id)).not.toContain(created.thread_id);
    expect(invalid.threads.map(thread => thread.id)).not.toContain(created.thread_id);
  });

  it("treats blank or fractional numeric query params as defaults instead of coercing them", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const sessionA = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    const sessionB = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    appendEvent(getRuntimeRecord(sessionA.thread_id)!, "custom.one", { ok: 1 });
    appendRuntimeItem(getRuntimeRecord(sessionA.thread_id)!, "custom_item", { ok: 1 });

    const blankLimit = await (await app.request("/v1/sessions?limit=")).json() as { sessions: Array<{ id: string }> };
    const fractionalLimit = await (await app.request("/v1/threads?limit=1.9")).json() as { threads: Array<{ id: string }> };
    const fractionalEvents = await (await app.request(`/v1/threads/${sessionA.thread_id}/events?since_seq=1.5`)).json() as { events: Array<{ event: string }> };

    expect(blankLimit.sessions.map(session => session.id)).toEqual(expect.arrayContaining([sessionA.session_id, sessionB.session_id]));
    expect(fractionalLimit.threads.map(thread => thread.id)).toEqual(expect.arrayContaining([sessionA.thread_id, sessionB.thread_id]));
    expect(fractionalEvents.events.map(event => event.event)).toEqual(expect.arrayContaining(["thread.started", "custom.one", "item.custom_item"]));
  });

  it("rebuilds prefix when thread mode changes so prompt behavior matches runtime mode", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "agent", workspace: tmp }),
    });
    const created = await createResp.json() as { thread: { id: string }; prefix_hash: string };
    const recordBefore = getRuntimeRecord(created.thread.id)!;
    const oldPrefixHash = recordBefore.prefix?.hash;
    const oldPrompt = recordBefore.prefix?.systemPrompt || "";

    const patchResp = await app.request(`/v1/threads/${created.thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "plan" }),
    });
    const patched = await patchResp.json() as { thread: { mode: string }; prefix_hash: string };
    const recordAfter = getRuntimeRecord(created.thread.id)!;

    expect(patched.thread.mode).toBe("plan");
    expect(recordAfter.config.mode).toBe("plan");
    expect(recordAfter.session.mode).toBe("plan");
    expect(recordAfter.prefix?.systemPrompt).toContain("## Plan Mode");
    expect(recordAfter.prefix?.systemPrompt).not.toBe(oldPrompt);
    expect(recordAfter.prefix?.hash).toBe(patched.prefix_hash);
    expect(recordAfter.prefix?.hash).not.toBe(oldPrefixHash);
    expect(recordAfter.session.messages[0]?.role).toBe("system");
    expect(recordAfter.session.messages[0]?.content).toBe(recordAfter.prefix?.systemPrompt);
    expect(recordAfter.events.some(event => event.event === "prefix.pinned")).toBe(true);
  });

  it("rejects runtime mode, model, or workspace changes while a turn is running", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    let continueStream: (() => void) | undefined;
    clientSendMocks.push(async function* () {
      yield { type: "content", text: "in progress" };
      await new Promise<void>(resolve => { continueStream = resolve; });
      yield { type: "done", finish_reason: "stop", usage: null, content: "in progress", reasoning_content: null, tool_calls: [] };
    });
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    const chatPromise = app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hold turn" }),
    });

    await waitFor(() => {
      const record = getRuntimeRecord(created.thread_id);
      const turn = record?.turns.at(-1);
      return turn?.status === "in_progress" ? turn : null;
    });
    const patchResp = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "plan", model: "other-model", workspace: "other-workspace" }),
    });
    expect(patchResp.status).toBe(409);
    expect(await patchResp.json()).toMatchObject({ error: "Cannot change mode, model, or workspace while a turn is running" });
    expect(getRuntimeRecord(created.thread_id)?.config.mode).toBe("agent");
    expect(getRuntimeRecord(created.thread_id)?.config.model).toBe("deepseek-v4-pro");

    continueStream?.();
    expect((await (await chatPromise).text())).toContain("event: done");
  });

  it("persists event/item replay and marks active turns interrupted after runtime reload", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { session_id: string; thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "persist me");

    updateTurn(record, turn, "in_progress");
    appendEvent(record, "custom.event", { ok: true }, turn.id);
    appendRuntimeItem(record, "artifact_link", { nested: { artifact_id: "log_m123456_deadbeef00" } }, { turnId: turn.id });

    expect(listArtifactLinks({ scope: "session", target_id: created.session_id })[0].artifact_id).toBe("log_m123456_deadbeef00");
    expect(listArtifactLinks({ scope: "turn", target_id: turn.id })[0].artifact_id).toBe("log_m123456_deadbeef00");

    reloadRuntimeStoreForTests();

    const reloadedThread = await (await app.request(`/v1/threads/${created.thread_id}`)).json() as {
      turns: Array<{ id: string; status: string; error?: string; artifact_ids: string[] }>;
    };
    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as { events: Array<{ event: string }> };
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string; artifact_ids: string[] }> };
    const resumed = await (await app.request(`/v1/sessions/${created.session_id}/resume-thread`, { method: "POST" })).json() as { thread_id: string };

    expect(reloadedThread.turns.find(item => item.id === turn.id)).toMatchObject({
      status: "interrupted",
      error: "Interrupted by process restart",
      artifact_ids: ["log_m123456_deadbeef00"],
    });
    expect(events.events.map(event => event.event)).toEqual(expect.arrayContaining(["custom.event", "item.artifact_link", "turn.interrupted"]));
    expect(items.items.some(item => item.type === "artifact_link" && item.artifact_ids.includes("log_m123456_deadbeef00"))).toBe(true);
    expect(resumed.thread_id).toBe(created.thread_id);
  });

  it("skips malformed persisted event and item lines instead of dropping the whole replay stream", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { session_id: string; thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;

    appendEvent(record, "custom.keep", { ok: true });
    appendRuntimeItem(record, "keep_item", { ok: true });

    const eventsFile = join(tmp, "events", `${created.thread_id}.jsonl`);
    const itemsFile = join(tmp, "items", `${created.thread_id}.jsonl`);
    writeFileSync(eventsFile, `${readFileSync(eventsFile, "utf-8")}not json\n`, "utf-8");
    writeFileSync(itemsFile, `${readFileSync(itemsFile, "utf-8")}{"broken":\n`, "utf-8");

    reloadRuntimeStoreForTests();

    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as {
      events: Array<{ event: string }>;
    };
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as {
      items: Array<{ type: string }>;
    };

    expect(events.events.map(event => event.event)).toEqual(expect.arrayContaining(["thread.started", "custom.keep", "item.keep_item"]));
    expect(items.items.map(item => item.type)).toContain("keep_item");
  });

  it("does not read or write runtime thread, event, or item files through symlinks", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const persisted = JSON.parse(readFileSync(join(tmp, "threads", `${created.thread_id}.json`), "utf-8"));
    const outsideThread = join(tmp, "outside-thread.json");
    const outsideEvent = join(tmp, "outside-event.jsonl");
    const outsideItem = join(tmp, "outside-item.jsonl");
    writeFileSync(outsideThread, "outside thread\n", "utf-8");
    writeFileSync(outsideEvent, "outside event\n", "utf-8");
    writeFileSync(outsideItem, "outside item\n", "utf-8");

    writeFileSync(join(tmp, "threads", "thr_linked.json"), JSON.stringify({
      ...persisted,
      session: { ...persisted.session, id: "ses_linked" },
      thread: { ...persisted.thread, id: "thr_linked", session_id: "ses_linked" },
    }), "utf-8");
    rmSync(join(tmp, "threads", "thr_linked.json"));
    symlinkSync(outsideThread, join(tmp, "threads", "thr_linked.json"));
    rmSync(join(tmp, "threads", `${created.thread_id}.json`));
    symlinkSync(outsideThread, join(tmp, "threads", `${created.thread_id}.json`));
    rmSync(join(tmp, "events", `${created.thread_id}.jsonl`), { force: true });
    rmSync(join(tmp, "items", `${created.thread_id}.jsonl`), { force: true });
    symlinkSync(outsideEvent, join(tmp, "events", `${created.thread_id}.jsonl`));
    mkdirSync(join(tmp, "items"), { recursive: true });
    symlinkSync(outsideItem, join(tmp, "items", `${created.thread_id}.jsonl`));

    updateRuntimeThread(created.thread_id, { model: "deepseek-v4-flash" });
    appendEvent(record, "symlink.event", { ok: true });
    appendRuntimeItem(record, "symlink_item", { ok: true });
    reloadRuntimeStoreForTests();

    expect(readFileSync(outsideThread, "utf-8")).toBe("outside thread\n");
    expect(readFileSync(outsideEvent, "utf-8")).toBe("outside event\n");
    expect(readFileSync(outsideItem, "utf-8")).toBe("outside item\n");
    expect(getRuntimeRecord("thr_linked")).toBeUndefined();
    expect(getRuntimeRecord(created.thread_id)).toBeUndefined();
  });

  it("persists runtime thread snapshots atomically and ignores orphan temp records on reload", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const orphanTemp = `.${created.thread_id}.json.123.tmp`;

    writeFileSync(join(tmp, "threads", orphanTemp), "{bad", "utf-8");
    createTurn(record, "atomic turn");
    reloadRuntimeStoreForTests();

    expect(getRuntimeRecord(created.thread_id)?.turns.map(turn => turn.message)).toContain("atomic turn");
    expect(getRuntimeRecord(orphanTemp)).toBeUndefined();
    expect(readdirSync(join(tmp, "threads")).filter(name => name.endsWith(".tmp"))).toEqual([orphanTemp]);
  });

  it("fails closed for throwing runtime payload objects and returns defensive replay snapshots", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "throwing payload");
    const throwing: Record<string, unknown> = {};
    Object.defineProperty(throwing, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter failed");
      },
    });

    const event = appendEvent(record, "throwing.event", throwing, turn.id);
    const item = appendRuntimeItem(record, "throwing_item", throwing, { turnId: turn.id, artifactIds: ["log_m123456_deadbeef00"] });
    updateTurn(record, turn, "completed", { usage: throwing as any, artifact_ids: ["log_m123456_deadbeef00"] });
    const replayedEvents = replayRuntimeEvents(created.thread_id, 0);
    const replayedItems = replayRuntimeItems(created.thread_id, 0);
    const replayEvent = replayedEvents.find(entry => entry.event === "throwing.event")!;
    const replayItem = replayedItems.find(entry => entry.type === "throwing_item")!;
    replayEvent.event = "mutated.event";
    (replayEvent.data as any).mutated = true;
    replayItem.type = "mutated_item";
    replayItem.artifact_ids.push("log_m999999_badbadbad0");

    expect(event.data).toEqual({ truncated: true });
    expect(item.data).toEqual({ truncated: true });
    expect(turn.usage).toEqual({ truncated: true });
    expect(replayRuntimeEvents(created.thread_id, 0).some(entry => entry.event === "throwing.event")).toBe(true);
    expect(replayRuntimeEvents(created.thread_id, 0).find(entry => entry.event === "throwing.event")?.data).toEqual({ truncated: true });
    expect(replayRuntimeItems(created.thread_id, 0).find(entry => entry.type === "throwing_item")?.artifact_ids).toEqual(["log_m123456_deadbeef00"]);
  });

  it("handles hostile runtime store getters while preserving readable state", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "hostile getters");
    const validArtifact = "log_m123456_deadbeef00";
    const artifactIds: any[] = [validArtifact, "drop"];
    Object.defineProperty(artifactIds, "1", {
      enumerable: true,
      get() {
        throw new Error("artifact getter failed");
      },
    });
    const data: Record<string, unknown> = { nested: { artifact_id: validArtifact } };
    Object.defineProperty(data, "bad", {
      enumerable: true,
      get() {
        throw new Error("data getter failed");
      },
    });
    const patch: Record<string, unknown> = { usage: { total_tokens: 1 }, artifact_ids: artifactIds };
    Object.defineProperty(patch, "error", {
      enumerable: true,
      get() {
        throw new Error("error getter failed");
      },
    });
    const options: Record<string, unknown> = { turnId: turn.id, artifactIds };
    Object.defineProperty(options, "ignored", {
      enumerable: true,
      get() {
        throw new Error("option getter failed");
      },
    });

    const item = appendRuntimeItem(record, "hostile_item", data, options as any);
    updateTurn(record, turn, "completed", patch as any);
    const replayed = replayRuntimeItems(created.thread_id, 0).find(entry => entry.type === "hostile_item")!;

    expect(item.artifact_ids).toEqual([validArtifact]);
    expect(turn.usage).toEqual({ total_tokens: 1 });
    expect(turn.artifact_ids).toEqual([validArtifact]);
    expect(replayed.artifact_ids).toEqual([validArtifact]);
    expect(replayed.data).toEqual({ truncated: true });
  });

  it("skips structurally invalid persisted event and item records during runtime reload", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;

    appendEvent(record, "custom.keep", { ok: true });
    appendRuntimeItem(record, "keep_item", { ok: true });
    const eventsFile = join(tmp, "events", `${created.thread_id}.jsonl`);
    const itemsFile = join(tmp, "items", `${created.thread_id}.jsonl`);
    writeFileSync(eventsFile, [
      readFileSync(eventsFile, "utf-8").trim(),
      JSON.stringify({ seq: Number.NaN, thread_id: created.thread_id, event: "bad_nan", data: {}, created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 98.5, thread_id: created.thread_id, event: "bad_fractional", data: {}, created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 99, thread_id: { nested: true }, event: "bad_thread", data: {}, created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 100, thread_id: "other_thread", event: "bad_other_thread", data: {}, created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 100, thread_id: created.thread_id, event: "   ", data: {}, created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 101, thread_id: created.thread_id, event: "bad event name", data: {}, created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 102, thread_id: created.thread_id, event: "bad_date", data: {}, created_at: "not-a-date" }),
      JSON.stringify({ seq: 103, thread_id: created.thread_id, turn_id: "turn_missing", event: "bad_turn", data: {}, created_at: new Date().toISOString() }),
      "",
    ].join("\n"), "utf-8");
    writeFileSync(itemsFile, [
      readFileSync(itemsFile, "utf-8").trim(),
      JSON.stringify({ seq: -1, id: "bad_seq", thread_id: created.thread_id, type: "bad_item", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 100.5, id: "bad_fractional_seq", thread_id: created.thread_id, type: "bad_fractional_item", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 101, id: "", thread_id: created.thread_id, type: "bad_id", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 101, id: "bad_other_thread", thread_id: "other_thread", type: "bad_other_thread_item", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 102, id: "bad_type", thread_id: created.thread_id, type: "   ", data: {}, artifact_ids: [7], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 103, id: "bad_type_name", thread_id: created.thread_id, type: "bad type", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 104, id: "bad_item_date", thread_id: created.thread_id, type: "bad_item_date", data: {}, artifact_ids: [], created_at: "not-a-date" }),
      JSON.stringify({ seq: 105, id: "bad_item_turn", thread_id: created.thread_id, turn_id: "turn_missing", type: "bad_item_turn", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      "",
    ].join("\n"), "utf-8");

    reloadRuntimeStoreForTests();

    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as { events: Array<{ event: string }> };
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string }> };

    expect(events.events.map(event => event.event)).toEqual(expect.arrayContaining(["thread.started", "custom.keep", "item.keep_item"]));
    expect(events.events.map(event => event.event)).not.toEqual(expect.arrayContaining([
      "bad_nan",
      "bad_fractional",
      "bad_thread",
      "bad_other_thread",
      "bad_empty",
      "bad event name",
      "bad_date",
      "bad_turn",
    ]));
    expect(items.items.map(item => item.type)).toContain("keep_item");
    expect(items.items.map(item => item.type)).not.toEqual(expect.arrayContaining([
      "bad_item",
      "bad_fractional_item",
      "bad_id",
      "bad_other_thread_item",
      "bad type",
      "bad_item_date",
      "bad_item_turn",
    ]));
  });

  it("rejects mismatched or unsafe persisted runtime thread/session metadata on reload", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const originalFile = JSON.parse(readFileSync(join(tmp, "threads", `${created.thread_id}.json`), "utf-8"));

    writeFileSync(join(tmp, "threads", "thr_mismatch_file.json"), JSON.stringify({
      ...originalFile,
      thread: { ...originalFile.thread, id: "thr_other_file" },
    }), "utf-8");
    writeFileSync(join(tmp, "threads", "thr_session_mismatch.json"), JSON.stringify({
      ...originalFile,
      thread: { ...originalFile.thread, id: "thr_session_mismatch", session_id: "ses_other" },
    }), "utf-8");
    writeFileSync(join(tmp, "threads", "thr_bad_mode.json"), JSON.stringify({
      ...originalFile,
      session: { ...originalFile.session, id: "ses_bad_mode" },
      thread: { ...originalFile.thread, id: "thr_bad_mode", session_id: "ses_bad_mode", mode: "debug" },
    }), "utf-8");
    writeFileSync(join(tmp, "threads", "thr_bad_date.json"), JSON.stringify({
      ...originalFile,
      session: { ...originalFile.session, id: "ses_bad_date" },
      thread: { ...originalFile.thread, id: "thr_bad_date", session_id: "ses_bad_date", updated_at: "not-a-date" },
    }), "utf-8");
    writeFileSync(join(tmp, "threads", "thr_bad_workspace.json"), JSON.stringify({
      ...originalFile,
      session: { ...originalFile.session, id: "ses_bad_workspace" },
      thread: { ...originalFile.thread, id: "thr_bad_workspace", session_id: "ses_bad_workspace", workspace: `${tmp}\u0000bad` },
    }), "utf-8");

    reloadRuntimeStoreForTests();

    expect(getRuntimeRecord(created.thread_id)).toBeTruthy();
    expect(getRuntimeRecord("thr_mismatch_file")).toBeUndefined();
    expect(getRuntimeRecord("thr_session_mismatch")).toBeUndefined();
    expect(getRuntimeRecord("thr_bad_mode")).toBeUndefined();
    expect(getRuntimeRecord("thr_bad_date")).toBeUndefined();
    expect(getRuntimeRecord("thr_bad_workspace")).toBeUndefined();
  });

  it("normalizes runtime store API inputs before writing live events, items, patches, and replay bounds", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "normalize live store");

    const event = appendEvent(record, "bad event name", { ok: true }, "bad/turn");
    const item = appendRuntimeItem(record, "bad item type", { artifact_id: "log_m123456_deadbeef00" }, {
      turnId: "bad/turn",
      artifactIds: [" log_m123456_deadbeef00 ", "../secret"],
    });
    const beforePatchUpdatedAt = record.thread.updated_at;
    const noOpPatch = updateRuntimeThread(created.thread_id, { mode: "debug" as any, model: "   ", workspace: `${tmp}\u0000bad` });
    const afterNoOpUpdatedAt = noOpPatch?.updated_at;
    const validPatch = updateRuntimeThread(created.thread_id, { mode: "plan", model: "\tdeepseek-v4-flash\n", workspace: ` ${tmp} ` });
    updateTurn(record, turn, "interrupted", {
      error: "bad\u0000error",
      interrupted_at: "not-a-date",
      resumed_from_turn_id: "../bad",
      usage: { total_tokens: 1n } as any,
      artifact_ids: [" log_m123456_deadbeef00 ", "../secret"],
    });

    expect(event).toMatchObject({ event: "runtime.event" });
    expect(event.turn_id).toBeUndefined();
    expect(item.type).toBe("unknown");
    expect(item.turn_id).toBeUndefined();
    expect(item.artifact_ids).toEqual(["log_m123456_deadbeef00"]);
    expect(afterNoOpUpdatedAt).toBe(beforePatchUpdatedAt);
    expect(validPatch).toMatchObject({ mode: "plan", model: "deepseek-v4-flash", workspace: tmp });
    expect(record.config.mode).toBe("plan");
    expect(record.session.workspace_path).toBe(tmp);
    expect(turn).toMatchObject({ status: "interrupted", usage: { total_tokens: "1" }, artifact_ids: ["log_m123456_deadbeef00"] });
    expect(turn.error).toBeUndefined();
    expect(turn.interrupted_at).toBeUndefined();
    expect(replayRuntimeEvents(created.thread_id, Number.NaN).some(entry => entry.event === "runtime.event")).toBe(true);
    expect(replayRuntimeItems(created.thread_id, -1).some(entry => entry.type === "unknown")).toBe(true);
    expect(getRuntimeRecordBySession(`../${created.session_id}`)).toBeUndefined();
  });

  it("bounds runtime replay payloads and normalizes persisted session counters", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "dirty persisted state");
    const large = "x".repeat(1_000_001);
    appendEvent(record, "large.payload", { text: large }, turn.id);
    appendRuntimeItem(record, "large.payload", { text: large, artifact_id: "log_m123456_deadbeef00" }, { turnId: turn.id });

    const threadFile = join(tmp, "threads", `${created.thread_id}.json`);
    const persisted = JSON.parse(readFileSync(threadFile, "utf-8"));
    persisted.session.cumulative_tokens_in = 3.5;
    persisted.session.cumulative_tokens_out = -1;
    persisted.session.turns = [{
      index: 1,
      user_message: "bad\u0000message",
      assistant_messages: [{
        role: "assistant",
        content: "ok\u0000content",
        tool_calls: [{ id: "bad id", name: "bad name", arguments: { count: 1n } }],
      }],
      tool_calls: [{ id: "call_good", name: "read", arguments: { path: "ok.ts" } }],
      tool_results: [
        { tool_call_id: "bad id", name: "bad name", content: "drop" },
        { tool_call_id: "call_good", name: "read", content: "ok\u0000result" },
      ],
      tokens_in: 1.5,
      tokens_out: -2,
      cost: 0.01,
      duration_s: 2,
      artifact_ids: Array.from({ length: 600 }, () => "log_m123456_deadbeef00"),
    }];
    writeFileSync(threadFile, JSON.stringify(persisted, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2), "utf-8");

    reloadRuntimeStoreForTests();

    const reloaded = getRuntimeRecord(created.thread_id)!;
    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as { events: Array<{ event: string; data: unknown }> };
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string; data: unknown; artifact_ids: string[] }> };

    expect(reloaded.session.cumulative_tokens_in).toBe(0);
    expect(reloaded.session.cumulative_tokens_out).toBe(0);
    expect(reloaded.session.turns[0]).toMatchObject({ tokens_in: 0, tokens_out: 0 });
    expect(reloaded.session.turns[0]?.assistant_messages[0]?.content).toBe("ok content");
    expect(reloaded.session.turns[0]?.assistant_messages[0]?.tool_calls).toBeNull();
    expect(reloaded.session.turns[0]?.tool_results).toEqual([
      { tool_call_id: "call_good", name: "read", content: "ok result", is_error: false },
    ]);
    expect(events.events.find(event => event.event === "large.payload")?.data).toEqual({ truncated: true });
    expect(items.items.find(item => item.type === "large.payload")?.data).toEqual({ truncated: true });
    expect(items.items.find(item => item.type === "large.payload")?.artifact_ids).toEqual(["log_m123456_deadbeef00"]);
  });

  it("normalizes persisted runtime artifact ids and drops unsafe replay ids", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const validArtifact = "log_m123456_deadbeef00";
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "artifact ids");
    appendRuntimeItem(record, "artifact_keep", { ok: true }, {
      turnId: turn.id,
      artifactIds: [validArtifact, ` ${validArtifact} `, "../secret", ""],
    });

    const threadsFile = join(tmp, "threads", `${created.thread_id}.json`);
    const itemsFile = join(tmp, "items", `${created.thread_id}.jsonl`);
    const persisted = JSON.parse(readFileSync(threadsFile, "utf-8"));
    persisted.turns[0].artifact_ids = [validArtifact, ` ${validArtifact} `, "../secret", ""];
    writeFileSync(threadsFile, JSON.stringify(persisted, null, 2), "utf-8");
    writeFileSync(itemsFile, [
      readFileSync(itemsFile, "utf-8").trim(),
      JSON.stringify({
        seq: 999,
        id: "item_extra",
        thread_id: created.thread_id,
        turn_id: turn.id,
        type: "artifact_extra",
        data: { artifact_id: ` ${validArtifact} ` },
        artifact_ids: [validArtifact, ` ${validArtifact} `, "../secret", ""],
        created_at: new Date().toISOString(),
      }),
      "",
    ].join("\n"), "utf-8");

    reloadRuntimeStoreForTests();

    const reloaded = getRuntimeRecord(created.thread_id)!;
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string; artifact_ids: string[] }> };

    expect(reloaded.turns[0].artifact_ids).toEqual([validArtifact]);
    expect(items.items.find(item => item.type === "artifact_keep")?.artifact_ids).toEqual([validArtifact]);
    expect(items.items.find(item => item.type === "artifact_extra")?.artifact_ids).toEqual([validArtifact]);
  });

  it("persists runtime items even when artifact link indexing fails", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    process.env.DEEPCODE_ARTIFACTS_DIR = join(tmp, "artifact-file");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(process.env.DEEPCODE_ARTIFACTS_DIR, "not a directory", "utf-8");
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "artifact link failure");

    const item = appendRuntimeItem(record, "artifact_link_failure", { artifact_id: "log_m123456_deadbeef00" }, { turnId: turn.id });

    expect(item.artifact_ids).toEqual(["log_m123456_deadbeef00"]);
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string; artifact_ids: string[] }> };
    expect(items.items.find(entry => entry.type === "artifact_link_failure")?.artifact_ids).toEqual(["log_m123456_deadbeef00"]);
  });

  it("skips malformed persisted runtime thread records instead of reloading fake thread metadata", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const validThread = getRuntimeRecord(created.thread_id)!.thread;

    writeFileSync(join(tmp, "threads", "broken.json"), JSON.stringify({
      config: { model: "deepseek-v4-pro" },
      session: { id: "broken-session" },
      thread: {
        id: { nested: true },
        session_id: "broken-session",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        model: "deepseek-v4-pro",
        mode: "agent",
        workspace: tmp,
        archived: false,
      },
      turns: [],
    }, null, 2), "utf-8");

    reloadRuntimeStoreForTests();

    const threads = await (await app.request("/v1/threads")).json() as { threads: Array<{ id: string }> };

    expect(threads.threads.map(thread => thread.id)).toContain(validThread.id);
    expect(threads.threads.map(thread => thread.id)).not.toContain("broken");
    expect(getRuntimeRecord("broken")).toBeUndefined();
  });

  it("forks sessions with independent thinking, turn, and artifact state", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { thread_id: string };
    const source = getRuntimeRecord(created.thread_id)!;
    source.session.messages.push({ role: "user", content: "fork me" });
    source.session.messages.push({
      role: "assistant",
      content: "done",
      reasoning_content: "forked reasoning",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "original.txt" } }],
    });
    source.session.turns.push({
      index: 1,
      user_message: "fork me",
      assistant_messages: [{
        role: "assistant",
        content: "done",
        reasoning_content: "forked reasoning",
        tool_calls: [{ id: "call_1", name: "read", arguments: { path: "original.txt" } }],
      }],
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "original.txt" } }],
      tool_results: [{ tool_call_id: "call_1", name: "read", content: "ok", is_error: false }],
      tokens_in: 1,
      tokens_out: 2,
      cost: 0.003,
      duration_s: 0.4,
      artifact_ids: ["log_m123456_deadbeef00"],
    });
    source.session.artifact_index = { session: ["log_m123456_deadbeef00"], "turn:1": ["log_m123456_deadbeef00"] };

    const fork = await (await app.request(`/v1/threads/${created.thread_id}/fork`, { method: "POST" })).json() as { thread: { id: string }; session_id: string };
    const forked = getRuntimeRecord(fork.thread.id)!;
    source.config.web.no_proxy.push("mutated.local");
    (source.session.messages.at(-1)!.tool_calls![0].arguments as Record<string, unknown>).path = "mutated.txt";
    source.session.turns[0].artifact_ids!.push("log_m999999_badbadbad0");

    expect(fork.thread.id).not.toBe(created.thread_id);
    expect(forked.session.id).toBe(fork.session_id);
    expect(forked.session.messages.at(-1)).toMatchObject({
      reasoning_content: "forked reasoning",
      tool_calls: [{ arguments: { path: "original.txt" } }],
    });
    expect(forked.config.web.no_proxy).not.toContain("mutated.local");
    expect(forked.session.turns[0].artifact_ids).toEqual(["log_m123456_deadbeef00"]);
    expect(forked.session.artifact_index["turn:1"]).toEqual(["log_m123456_deadbeef00"]);
  });

  it("forks runtime threads without invoking hostile session getters", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { thread_id: string };
    const source = getRuntimeRecord(created.thread_id)!;
    const messages: any[] = [
      { role: "user", content: "keep me" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a.txt" } }] },
    ];
    Object.defineProperty(messages, "0", {
      enumerable: true,
      get() {
        throw new Error("message getter failed");
      },
    });
    const turnRecord: Record<string, unknown> = {
      index: 1,
      user_message: "turn",
      assistant_messages: [{ role: "assistant", content: "ok" }],
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a.txt" } }],
      tool_results: [{ tool_call_id: "call_1", name: "read", content: "ok", is_error: false }],
      artifact_ids: ["log_m123456_deadbeef00"],
    };
    Object.defineProperty(turnRecord, "cost", {
      enumerable: true,
      get() {
        throw new Error("turn getter failed");
      },
    });
    source.session.messages = messages;
    source.session.turns = [turnRecord as any];
    Object.defineProperty(source.session, "artifact_index", {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error("artifact index getter failed");
      },
    });

    const fork = forkRuntimeThread(created.thread_id)!;

    expect(fork.thread.id).not.toBe(created.thread_id);
    expect(fork.session.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: "ok", tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a.txt" } }] }),
    ]);
    expect(fork.session.turns[0]).toMatchObject({
      user_message: "turn",
      tool_calls: [{ id: "call_1", name: "read", arguments: { path: "a.txt" } }],
      tool_results: [{ tool_call_id: "call_1", name: "read", content: "ok", is_error: false }],
      artifact_ids: ["log_m123456_deadbeef00"],
    });
    expect(fork.session.artifact_index).toEqual({});
  });

  it("interrupts only active turns and records interrupt replay evidence", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "stop me");
    const abortController = new AbortController();
    record.abortController = abortController;
    updateTurn(record, turn, "in_progress");

    const interruptedResp = await app.request(`/v1/threads/${created.thread_id}/turns/${turn.id}/interrupt`, { method: "POST" });
    const interrupted = await interruptedResp.json() as { interrupted: boolean; turn: { status: string; error?: string } };
    const duplicateResp = await app.request(`/v1/threads/${created.thread_id}/turns/${turn.id}/interrupt`, { method: "POST" });
    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as { events: Array<{ event: string }> };
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string }> };

    expect(interruptedResp.status).toBe(200);
    expect(interrupted).toMatchObject({ interrupted: true, turn: { status: "interrupted", error: "Interrupted by API request" } });
    expect(abortController.signal.aborted).toBe(true);
    expect(duplicateResp.status).toBe(409);
    expect(events.events.map(event => event.event)).toEqual(expect.arrayContaining(["turn.interrupt_requested", "item.interrupt", "turn.interrupted"]));
    expect(items.items.some(item => item.type === "interrupt")).toBe(true);
  });

  it("keeps chat aborts as interrupted instead of failed", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    let continueStream: (() => void) | undefined;
    clientSendMocks.push(async function* () {
      yield { type: "content", text: "partial" };
      await new Promise<void>(resolve => { continueStream = resolve; });
      yield { type: "content", text: "late" };
      yield { type: "done", finish_reason: "stop", usage: null, content: "partiallate", reasoning_content: null, tool_calls: [] };
    });
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { session_id: string; thread_id: string };
    const chatRespPromise = app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "abort stream" }),
    });

    await waitFor(() => {
      const turn = getRuntimeRecord(created.thread_id)?.turns.at(-1);
      return turn?.status === "in_progress" ? turn : null;
    });
    const turnId = getRuntimeRecord(created.thread_id)!.turns.at(-1)!.id;
    const interruptResp = await app.request(`/v1/threads/${created.thread_id}/turns/${turnId}/interrupt`, { method: "POST" });
    continueStream?.();
    const chatBody = await (await chatRespPromise).text();
    const thread = await (await app.request(`/v1/threads/${created.thread_id}`)).json() as { turns: Array<{ id: string; status: string }> };

    expect(interruptResp.status).toBe(200);
    expect(chatBody).toContain("event: interrupted");
    expect(thread.turns.find(turn => turn.id === turnId)?.status).toBe("interrupted");
    expect(thread.turns.find(turn => turn.id === turnId)?.status).not.toBe("failed");
  });

  it("rejects concurrent chat turns on the same thread without cross-interrupting the active turn", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    let continueStream: (() => void) | undefined;
    clientSendMocks.push(async function* () {
      yield { type: "content", text: "first" };
      await new Promise<void>(resolve => { continueStream = resolve; });
      yield { type: "done", finish_reason: "stop", usage: null, content: "first", reasoning_content: null, tool_calls: [] };
    });
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    const firstResponsePromise = app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first turn" }),
    });

    await waitFor(() => {
      const turn = getRuntimeRecord(created.thread_id)?.turns.at(-1);
      return turn?.status === "in_progress" ? turn : null;
    });
    const secondResponse = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second turn" }),
    });
    expect(secondResponse.status).toBe(409);
    expect(await secondResponse.json()).toMatchObject({ error: "A turn is already running" });

    continueStream?.();
    const firstResponse = await firstResponsePromise;
    expect(await firstResponse.text()).toContain("event: done");
    const record = getRuntimeRecord(created.thread_id)!;
    expect(record.turns).toHaveLength(1);
    expect(record.turns[0]?.status).toBe("completed");
  });

  it("keeps a thread reserved until an interrupted chat engine has fully unwound", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    let continueStream: (() => void) | undefined;
    clientSendMocks.push(async function* () {
      yield { type: "content", text: "first" };
      await new Promise<void>(resolve => { continueStream = resolve; });
      yield { type: "done", finish_reason: "stop", usage: null, content: "first", reasoning_content: null, tool_calls: [] };
    });
    const app = createApp();
    const created = await (await app.request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    const firstResponsePromise = app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "first turn" }),
    });
    await waitFor(() => getRuntimeRecord(created.thread_id)?.turns.at(-1)?.status === "in_progress" ? true : null);
    const turnId = getRuntimeRecord(created.thread_id)!.turns.at(-1)!.id;
    const interruptResponse = await app.request(`/v1/threads/${created.thread_id}/turns/${turnId}/interrupt`, { method: "POST" });
    expect(interruptResponse.status).toBe(200);

    const patchResponse = await app.request(`/v1/threads/${created.thread_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "plan" }),
    });
    expect(patchResponse.status).toBe(409);
    expect(await patchResponse.json()).toMatchObject({
      error: "Cannot change mode, model, or workspace while a turn is running",
      turn_id: turnId,
    });

    const secondResponse = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second turn" }),
    });
    expect(secondResponse.status).toBe(409);
    expect(await secondResponse.json()).toMatchObject({ error: "A turn is already running", turn_id: turnId });

    continueStream?.();
    expect(await (await firstResponsePromise).text()).toContain("event: interrupted");
    clientSendMocks.push(async function* () {
      yield { type: "content", text: "second" };
      yield { type: "done", finish_reason: "stop", usage: null, content: "second", reasoning_content: null, tool_calls: [] };
    });
    const thirdResponse = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second turn" }),
    });
    expect(thirdResponse.status).toBe(200);
    expect(await thirdResponse.text()).toContain("event: done");
  });

  it("marks chat turns interrupted when the HTTP SSE client disconnects", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    let continueStream: (() => void) | undefined;
    clientSendMocks.push(async function* () {
      yield { type: "content", text: "partial" };
      await new Promise<void>(resolve => { continueStream = resolve; });
      yield { type: "content", text: "late" };
      yield { type: "done", finish_reason: "stop", usage: null, content: "partiallate", reasoning_content: null, tool_calls: [] };
    });
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { session_id: string; thread_id: string };
    const { server, port } = await listenTestServer(app.fetch);
    let turnId = "";

    try {
      const client = await openStreamingPost({
        port,
        path: `/v1/session/${created.session_id}/chat`,
        body: JSON.stringify({ message: "disconnect stream" }),
      });
      await client.waitFor("partial");
      turnId = getRuntimeRecord(created.thread_id)!.turns.at(-1)!.id;
      client.destroy();
      await waitFor(() => {
        const turn = getRuntimeRecord(created.thread_id)?.turns.find(item => item.id === turnId);
        return turn?.status === "interrupted" ? turn : null;
      });
      continueStream?.();
    } finally {
      continueStream?.();
      await closeServer(server);
    }
    const thread = await (await app.request(`/v1/threads/${created.thread_id}`)).json() as { turns: Array<{ id: string; status: string }> };

    expect(thread.turns.find(turn => turn.id === turnId)?.status).toBe("interrupted");
    expect(thread.turns.find(turn => turn.id === turnId)?.status).not.toBe("completed");
  });

  it("does not persist partial streamed assistant state when the upstream stream fails mid-turn", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    clientSendMocks.push(async function* () {
      yield { type: "thinking", text: "drafting" };
      yield { type: "content", text: "partial answer" };
      yield { type: "tool_call_begin", index: 0, tool_call_id: "call_partial_1", name: "read" };
      throw new Error("upstream stream failed");
    });
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { session_id: string; thread_id: string };

    const chatResp = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "trigger upstream failure" }),
    });
    const body = await chatResp.text();
    const thread = await (await app.request(`/v1/threads/${created.thread_id}`)).json() as {
      turns: Array<{ id: string; status: string; error?: string }>;
      session: { messages: Array<{ role: string; content?: string | null }> };
    };
    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as {
      events: Array<{ event: string; turn_id?: string }>;
    };
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as {
      items: Array<{ type: string; turn_id?: string; data?: { text?: string; name?: string } }>;
    };
    const turnId = thread.turns.at(-1)!.id;

    expect(body).toContain("event: thinking");
    expect(body).toContain("event: content");
    expect(body).toContain("event: tool_call");
    expect(body).toContain("event: error");
    expect(thread.turns.find(turn => turn.id === turnId)).toMatchObject({
      status: "failed",
      error: "upstream stream failed",
    });
    expect(thread.session.messages.some(message => message.role === "assistant" && (message.content || "").includes("partial answer"))).toBe(false);
    expect(items.items.filter(item => item.turn_id === turnId).map(item => item.type)).not.toEqual(
      expect.arrayContaining(["thinking_delta", "content_delta", "tool_call_begin"]),
    );
    expect(events.events.filter(event => event.turn_id === turnId).map(event => event.event)).not.toEqual(
      expect.arrayContaining(["thinking", "content", "tool_call"]),
    );
    expect(items.items.filter(item => item.turn_id === turnId).map(item => item.type)).toEqual(
      expect.arrayContaining(["turn_input"]),
    );
    expect(events.events.filter(event => event.turn_id === turnId).map(event => event.event)).toEqual(
      expect.arrayContaining(["turn.queued", "turn.in_progress", "item.turn_input", "turn.failed"]),
    );
  });

  it("persists approval_required across SSE replay, thread events, items, and runtime reload", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    clientSendMocks.push(
      async function* () {
        yield { type: "tool_call_begin", index: 0, tool_call_id: "call_write_1", name: "write" };
        yield {
          type: "done",
          finish_reason: "tool_calls",
          usage: null,
          content: "",
          reasoning_content: null,
          tool_calls: [{ id: "call_write_1", name: "write", arguments: { path: "draft.txt", content: "hello" } }],
        };
      },
      async function* () {
        yield { type: "content", text: "write denied" };
        yield { type: "done", finish_reason: "stop", usage: { total_tokens: 1 }, content: "write denied", reasoning_content: null, tool_calls: [] };
      },
    );

    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { session_id: string; thread_id: string };

    const chatResp = await app.request(`/v1/session/${created.session_id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "please write a draft file" }),
    });
    const body = await chatResp.text();
    const turnId = getRuntimeRecord(created.thread_id)!.turns.at(-1)!.id;

    const eventsBefore = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as {
      events: Array<{ event: string; turn_id?: string; data?: { tool?: string; args?: Record<string, unknown>; description?: string } }>;
    };
    const itemsBefore = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as {
      items: Array<{ type: string; turn_id?: string; data?: { tool?: string; args?: Record<string, unknown>; description?: string } }>;
    };

    const approvalEvent = eventsBefore.events.find(event => event.event === "approval_required");
    const approvalItem = itemsBefore.items.find(item => item.type === "approval_required");

    expect(body).toContain("event: tool_call");
    expect(body).toContain("event: approval_required");
    expect(body).toContain("event: content");
    expect(body).toContain("event: done");
    expect(approvalEvent).toMatchObject({
      event: "approval_required",
      turn_id: turnId,
      data: {
        tool: "write",
        args: { path: "draft.txt", content: "hello" },
      },
    });
    expect(approvalEvent?.data?.description).toContain("Write content to a file.");
    expect(approvalItem).toMatchObject({
      type: "approval_required",
      turn_id: turnId,
      data: {
        tool: "write",
        args: { path: "draft.txt", content: "hello" },
      },
    });
    expect(approvalItem?.data?.description).toContain("Write content to a file.");
    expect(eventsBefore.events.map(event => event.event)).toEqual(expect.arrayContaining([
      "tool_call",
      "item.approval_required",
      "approval_required",
      "item.approval_audit",
    ]));
    expect(itemsBefore.items.map(item => item.type)).toEqual(expect.arrayContaining([
      "tool_call_begin",
      "tool_call",
      "approval_required",
      "approval_audit",
      "tool_result",
    ]));

    reloadRuntimeStoreForTests();

    const eventsAfter = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as {
      events: Array<{ event: string; turn_id?: string; data?: { tool?: string; args?: Record<string, unknown> } }>;
    };
    const itemsAfter = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as {
      items: Array<{ type: string; turn_id?: string; data?: { tool?: string; args?: Record<string, unknown> } }>;
    };

    expect(eventsAfter.events.find(event => event.event === "approval_required")).toMatchObject({
      event: "approval_required",
      turn_id: turnId,
      data: { tool: "write", args: { path: "draft.txt", content: "hello" } },
    });
    expect(itemsAfter.items.find(item => item.type === "approval_required")).toMatchObject({
      type: "approval_required",
      turn_id: turnId,
      data: { tool: "write", args: { path: "draft.txt", content: "hello" } },
    });
  });

  it("deletes runtime threads, replay files, and session resume targets", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { session_id: string; thread_id: string };
    appendEvent(getRuntimeRecord(created.thread_id)!, "delete.marker", { ok: true });
    appendRuntimeItem(getRuntimeRecord(created.thread_id)!, "delete_item", { ok: true });

    const deleted = await (await app.request(`/v1/sessions/${created.session_id}`, { method: "DELETE" })).json() as { deleted: boolean };
    const threadResp = await app.request(`/v1/threads/${created.thread_id}`);
    const resumeResp = await app.request(`/v1/sessions/${created.session_id}/resume-thread`, { method: "POST" });
    const eventsResp = await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`);
    const secondDeleteResp = await app.request(`/v1/sessions/${created.session_id}`, { method: "DELETE" });

    expect(deleted.deleted).toBe(true);
    expect(threadResp.status).toBe(404);
    expect(resumeResp.status).toBe(404);
    expect(eventsResp.status).toBe(404);
    expect(secondDeleteResp.status).toBe(404);
    expect(existsSync(join(tmp, "threads", `${created.thread_id}.json`))).toBe(false);
    expect(existsSync(join(tmp, "events", `${created.thread_id}.jsonl`))).toBe(false);
    expect(existsSync(join(tmp, "items", `${created.thread_id}.jsonl`))).toBe(false);
  });

  it("does not let an in-flight deleted turn recreate runtime files", async () => {
    const created = await (await createApp().request("/v1/session", { method: "POST" })).json() as { session_id: string; thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    const turn = createTurn(record, "delete while running");
    record.activeTurn = { turnId: turn.id, abortController: new AbortController() };
    const threadFile = join(tmp, "threads", `${record.thread.id}.json`);
    const eventFile = join(tmp, "events", `${record.thread.id}.jsonl`);
    const itemFile = join(tmp, "items", `${record.thread.id}.jsonl`);

    expect(deleteRuntimeRecordBySession(created.session_id)).toBe(true);
    updateTurn(record, turn, "interrupted", { error: "late completion" });
    appendRuntimeItem(record, "late.item", { ignored: true }, { turnId: turn.id });
    appendEvent(record, "late.event", { ignored: true }, turn.id);

    expect(existsSync(threadFile)).toBe(false);
    expect(existsSync(eventFile)).toBe(false);
    expect(existsSync(itemFile)).toBe(false);
  });

  it("subscribes to live runtime events after backlog replay", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { thread_id: string };
    const live = new Promise(resolve => {
      const unsubscribe = subscribeRuntimeEvents(created.thread_id, event => {
        if (event.event === "test.live") {
          unsubscribe();
          resolve(event);
        }
      });
    });
    appendEvent(getRuntimeRecord(created.thread_id)!, "test.live", { ok: true });

    await expect(live).resolves.toMatchObject({ event: "test.live", data: { ok: true } });
  });

  it("streams SSE backlog followed by live events from the HTTP handler", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { thread_id: string };
    appendEvent(getRuntimeRecord(created.thread_id)!, "backlog.event", { ok: "backlog" });

    const response = await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`, {
      headers: { Accept: "text/event-stream" },
    });
    const reader = response.body!.getReader();
    try {
      let streamText = await readStreamUntil(reader, "backlog.event");
      appendEvent(getRuntimeRecord(created.thread_id)!, "live.event", { ok: "live" });
      streamText = await readStreamUntil(reader, "live.event", streamText);
      const parsed = parseSSEFrames(streamText);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(parsed.frames.map(frame => frame.event)).toEqual(expect.arrayContaining(["thread.started", "backlog.event", "live.event"]));
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it("replays events that exceed the SSE initialization pending bound", async () => {
    process.env.DEEPSEEK_API_KEY = "test";
    const app = createApp();
    const createResp = await app.request("/v1/session", { method: "POST" });
    const created = await createResp.json() as { thread_id: string };
    const record = getRuntimeRecord(created.thread_id)!;
    for (let index = 0; index < 1_100; index++) {
      appendEvent(record, `seed.${index}`, { index });
    }
    const responsePromise = app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`, {
      headers: { Accept: "text/event-stream" },
    });
    await Promise.resolve();
    await Promise.resolve();
    for (let index = 0; index < 1_200; index++) {
      appendEvent(record, `burst.${index}`, { index });
    }

    const response = await responsePromise;
    const reader = response.body!.getReader();
    try {
      const streamText = await readStreamUntil(reader, "burst.1199", "", 5_000);
      const frames: ReturnType<typeof parseSSEFrames>["frames"] = [];
      let remaining = streamText;
      while (remaining) {
        const parsed = parseSSEFrames(remaining);
        frames.push(...parsed.frames);
        if (parsed.remaining === remaining) break;
        remaining = parsed.remaining;
      }
      const burstEvents = frames
        .filter(frame => frame.event?.startsWith("burst."))
        .map(frame => Number(frame.event!.slice("burst.".length)));

      expect(burstEvents).toHaveLength(1_200);
      expect(burstEvents).toEqual(Array.from({ length: 1_200 }, (_, index) => index));
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });

  it("bounds SSE parser frames and runtime client inputs", async () => {
    const parsed = parseSSEFrames(`event: huge\ndata: ${"x".repeat(300_000)}\n\n`);
    const family = "👨‍👩‍👧‍👦";
    const boundary = parseSSEFrames(`event: boundary\ndata: ${"b".repeat(199_999)}${family}tail\n\n`);

    expect(parsed.frames).toHaveLength(0);
    expect(boundary.frames[0]?.data).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(boundary.frames[0]?.data ?? "")).toBe(false);
    expect(() => new RuntimeApiClient({ baseUrl: `http://example.com/${"x".repeat(9000)}` })).toThrow(/baseUrl/);
    const client = new RuntimeApiClient({
      baseUrl: "http://runtime.example",
      headers: Object.fromEntries([
        ["Ok", "1"],
        ["Bad\nName", "drop"],
        ...Array.from({ length: 80 }, (_, index) => [`H${index}`, "v"]),
      ]),
      fetchImpl: (async () => new Response("{}", { status: 200 })) as any,
    });

    await expect(client.getThread("x".repeat(129))).rejects.toThrow(/id is invalid/);
    await expect(client.chat("session", "x".repeat(200_001)).next()).rejects.toThrow(/message is invalid/);
  });
});

async function readStreamUntil(reader: any, needle: string, existing = "", timeoutMs = 1500): Promise<string> {
  const decoder = new TextDecoder();
  let output = existing;
  const deadline = Date.now() + timeoutMs;
  while (!output.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for ${needle}`);
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${needle}`)), remaining)),
    ]) as { done: boolean; value?: Uint8Array };
    if (chunk.done) break;
    if (chunk.value) output += decoder.decode(chunk.value, { stream: true });
  }
  if (!output.includes(needle)) throw new Error(`Stream ended before ${needle}`);
  return output;
}

function listenTestServer(fetch: Parameters<typeof serve>[0]["fetch"]): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  return new Promise(resolve => {
    const server = serve({ fetch, hostname: "127.0.0.1", port: 0 }, () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
  });
}

function openStreamingPost(options: { port: number; path: string; body: string; timeoutMs?: number }): Promise<{
  waitFor(needle: string, timeoutMs?: number): Promise<string>;
  destroy(): void;
}> {
  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const waiters: Array<{ needle: string; resolve(value: string): void; reject(error: Error): void; timer: NodeJS.Timeout }> = [];
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: options.port,
      path: options.path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(options.body),
      },
    }, (res) => {
      settled = true;
      if (res.statusCode !== 200) {
        reject(new Error(`Unexpected SSE status ${res.statusCode}`));
        res.resume();
        return;
      }
      res.setEncoding("utf-8");
      res.on("data", chunk => {
        output += chunk;
        for (const waiter of [...waiters]) {
          if (!output.includes(waiter.needle)) continue;
          clearTimeout(waiter.timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(output);
        }
      });
      res.on("error", error => {
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      resolve({
        waitFor(needle: string, timeoutMs = options.timeoutMs ?? 1500) {
          if (output.includes(needle)) return Promise.resolve(output);
          return new Promise<string>((waitResolve, waitReject) => {
            const timer = setTimeout(() => {
              const index = waiters.findIndex(waiter => waiter.needle === needle);
              if (index >= 0) waiters.splice(index, 1);
              waitReject(new Error(`Timed out waiting for ${needle}`));
            }, timeoutMs);
            waiters.push({ needle, resolve: waitResolve, reject: waitReject, timer });
          });
        },
        destroy() {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on("error", error => {
      if (!settled) reject(error);
    });
    req.end(options.body);
  });
}

function closeServer(server: { close(callback?: (err?: Error) => void): void }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 1500): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for condition");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
