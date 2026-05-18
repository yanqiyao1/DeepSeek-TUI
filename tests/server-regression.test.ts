import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
const {
  appendEvent,
  appendRuntimeItem,
  clearRuntimeStoreForTests,
  createTurn,
  getRuntimeRecord,
  reloadRuntimeStoreForTests,
  subscribeRuntimeEvents,
  updateTurn,
} = await import("../src/server/runtime-store.js");
const { clearArtifactsForTests, listArtifactLinks } = await import("../src/artifacts/store.js");
const { parseSSEFrames } = await import("../src/server/transport.js");

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

    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: "invalid JSON body" });
    expect(nonString.status).toBe(400);
    expect(await nonString.json()).toMatchObject({ error: "message must be a string" });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toMatchObject({ error: "message required" });
    expect(getRuntimeRecord(created.thread_id)!.turns).toHaveLength(0);
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
    expect(items.items.some(item => item.type === "artifact_test" && item.artifact_ids.includes("log_m123456_deadbeef00"))).toBe(true);
    expect(fork.thread.id).not.toBe(created.thread_id);
    expect(deleted.deleted).toBe(true);
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
      body: JSON.stringify({ model: "\tdeepseek-v4-pro\n", mode: "agent", workspace: `  ${tmp}  ` }),
    });
    const created = await createResp.json() as { thread: { id: string; model: string; mode: string; workspace: string } };
    const record = getRuntimeRecord(created.thread.id)!;

    expect(createResp.status).toBe(200);
    expect(created.thread).toMatchObject({
      model: "deepseek-v4-pro",
      workspace: tmp,
    });
    expect(record.session.model).toBe("deepseek-v4-pro");
    expect(record.session.workspace_path).toBe(tmp);
    expect(record.config.model).toBe("deepseek-v4-pro");
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
      body: JSON.stringify({ model: "\tdeepseek-v4-flash\n", workspace: `  ${tmp}  ` }),
    });
    const patched = await patchResp.json() as { thread: { model: string; workspace: string } };
    const record = getRuntimeRecord(created.thread_id)!;

    expect(patchResp.status).toBe(200);
    expect(patched.thread).toMatchObject({
      model: "deepseek-v4-flash",
      workspace: tmp,
    });
    expect(record.session.model).toBe("deepseek-v4-flash");
    expect(record.session.workspace_path).toBe(tmp);
    expect(record.config.model).toBe("deepseek-v4-flash");
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
      "",
    ].join("\n"), "utf-8");
    writeFileSync(itemsFile, [
      readFileSync(itemsFile, "utf-8").trim(),
      JSON.stringify({ seq: -1, id: "bad_seq", thread_id: created.thread_id, type: "bad_item", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 100.5, id: "bad_fractional_seq", thread_id: created.thread_id, type: "bad_fractional_item", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 101, id: "", thread_id: created.thread_id, type: "bad_id", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 101, id: "bad_other_thread", thread_id: "other_thread", type: "bad_other_thread_item", data: {}, artifact_ids: [], created_at: new Date().toISOString() }),
      JSON.stringify({ seq: 102, id: "bad_type", thread_id: created.thread_id, type: "   ", data: {}, artifact_ids: [7], created_at: new Date().toISOString() }),
      "",
    ].join("\n"), "utf-8");

    reloadRuntimeStoreForTests();

    const events = await (await app.request(`/v1/threads/${created.thread_id}/events?since_seq=0`)).json() as { events: Array<{ event: string }> };
    const items = await (await app.request(`/v1/threads/${created.thread_id}/items?since_seq=0`)).json() as { items: Array<{ type: string }> };

    expect(events.events.map(event => event.event)).toEqual(expect.arrayContaining(["thread.started", "custom.keep", "item.keep_item"]));
    expect(events.events.map(event => event.event)).not.toEqual(expect.arrayContaining(["bad_nan", "bad_fractional", "bad_thread", "bad_other_thread", "bad_empty"]));
    expect(items.items.map(item => item.type)).toContain("keep_item");
    expect(items.items.map(item => item.type)).not.toEqual(expect.arrayContaining(["bad_item", "bad_fractional_item", "bad_id", "bad_other_thread_item"]));
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
    (source.session.messages.at(-1)!.tool_calls![0].arguments as Record<string, unknown>).path = "mutated.txt";
    source.session.turns[0].artifact_ids!.push("log_m999999_badbadbad0");

    expect(fork.thread.id).not.toBe(created.thread_id);
    expect(forked.session.id).toBe(fork.session_id);
    expect(forked.session.messages.at(-1)).toMatchObject({
      reasoning_content: "forked reasoning",
      tool_calls: [{ arguments: { path: "original.txt" } }],
    });
    expect(forked.session.turns[0].artifact_ids).toEqual(["log_m123456_deadbeef00"]);
    expect(forked.session.artifact_index["turn:1"]).toEqual(["log_m123456_deadbeef00"]);
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
