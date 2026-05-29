import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: createMock } },
  })),
}));

const OpenAIMock = (await import("openai")).default as any;
const { getRegistry } = await import("../src/tools/registry.js");
const { registerSubAgentTool, clearAgentState } = await import("../src/tools/sub-agent.js");
const { registerRLMTool } = await import("../src/tools/rlm-query.js");

beforeEach(() => {
  getRegistry().clear();
  clearAgentState();
  OpenAIMock.mockClear();
  createMock.mockReset();
});

afterEach(() => {
  getRegistry().clear();
  clearAgentState();
  vi.useRealTimers();
});

describe("meta tool regressions", () => {
  it("enforces spawn_agent timeout_ms instead of hanging until the upstream client returns", async () => {
    vi.useFakeTimers();
    createMock.mockImplementation((_request, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        reject(new DOMException("Request aborted", "AbortError"));
      }, { once: true });
    }));
    registerSubAgentTool();

    const run = getRegistry().lookup("spawn_agent")!.execute({
      task: "wait forever",
      timeout_ms: 10_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await run;

    expect(result).toContain("<deepseek:subagent.error>");
    expect(result).toContain("timed out after 10000ms");
  });

  it("clamps non-positive spawn_agent timeout_ms to the documented minimum", async () => {
    vi.useFakeTimers();
    createMock.mockImplementation((_request, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => {
        reject(new DOMException("Request aborted", "AbortError"));
      }, { once: true });
    }));
    registerSubAgentTool();

    const run = getRegistry().lookup("spawn_agent")!.execute({
      task: "min timeout clamp",
      timeout_ms: 0,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await run;

    expect(result).toContain("timed out after 10000ms");
  });

  it("coerces non-positive spawn_agent max_turns to one turn instead of defaulting to fifteen", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "partial" }, finish_reason: "length" }],
    });
    registerSubAgentTool();

    const result = await getRegistry().lookup("spawn_agent")!.execute({
      task: "single turn only",
      max_turns: 0,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result).toContain("<deepseek:subagent.done>");
    expect(result).toContain("partial");
  });

  it("returns a normal task-required error for legacy sub_agent when task is missing", async () => {
    registerSubAgentTool();

    expect(await getRegistry().lookup("sub_agent")!.validateInput?.(
      {},
      { tool_name: "sub_agent", workspace_path: "/tmp/workspace", tool_def: getRegistry().lookup("sub_agent")! },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("task is required"),
    });

    await expect(getRegistry().lookup("sub_agent")!.execute({})).resolves.toBe("Error: task is required.");
  });

  it("rejects malformed legacy sub_agent controls during validation instead of deferring failure to execution", async () => {
    registerSubAgentTool();
    const tool = getRegistry().lookup("sub_agent")!;
    const throwingTask = { get task() { throw new Error("task getter should not leak"); } };
    const throwingSystemPrompt = {
      task: "legacy task",
      get system_prompt() { throw new Error("system_prompt getter should not leak"); },
    };
    const throwingMaxTurns = {
      task: "legacy task",
      get max_turns() { throw new Error("max_turns getter should not leak"); },
    };

    expect(await tool.validateInput?.(
      { task: "legacy task", system_prompt: { nested: true } as any },
      { tool_name: "sub_agent", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("system_prompt must be a string"),
    });
    expect(await tool.validateInput?.(
      { task: "legacy task", max_turns: { nested: true } as any },
      { tool_name: "sub_agent", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_turns must be a number"),
    });

    expect(await tool.execute({ task: "legacy task", system_prompt: { nested: true } as any })).toBe("Error: system_prompt must be a string.");
    expect(await tool.execute({ task: "legacy task", max_turns: { nested: true } as any })).toBe("Error: max_turns must be a number.");
    for (const args of [throwingTask as any, throwingSystemPrompt as any, throwingMaxTurns as any]) {
      expect(await tool.validateInput?.(
        args,
        { tool_name: "sub_agent", workspace_path: "/tmp/workspace", tool_def: tool },
      )).toMatchObject({
        ok: false,
        message: expect.not.stringContaining("getter should not leak"),
      });
      expect(await tool.execute(args)).not.toContain("getter should not leak");
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects non-string spawn_agent tasks without sending malformed content upstream", async () => {
    registerSubAgentTool();

    const result = await getRegistry().lookup("spawn_agent")!.execute({
      task: { prompt: "not a string" } as any,
    });

    expect(result).toBe("Error: task is required.");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only spawn_agent tasks before calling upstream", async () => {
    registerSubAgentTool();

    const result = await getRegistry().lookup("spawn_agent")!.execute({
      task: "   ",
    });

    expect(result).toBe("Error: task is required.");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("tolerates non-string spawn_agent task_name values without crashing", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    registerSubAgentTool();

    const result = await getRegistry().lookup("spawn_agent")!.execute({
      task: "coerce name",
      task_name: 42,
    });

    expect(result).toContain("<deepseek:subagent.done>");
    expect(result).toContain("nickname: agent_");
  });

  it("trims spawn_agent task names and ignores blank string overrides instead of sending whitespace upstream", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    registerSubAgentTool();
    const oldSeekModel = process.env.SEEKCODE_MODEL;
    const oldModel = process.env.DEEPSEEK_MODEL;
    delete process.env.SEEKCODE_MODEL;
    process.env.DEEPSEEK_MODEL = "env-model";

    try {
      const result = await getRegistry().lookup("spawn_agent")!.execute({
        task: "trim spawn config",
        task_name: "  padded name  ",
        system_prompt: "   ",
        model: "   ",
      });

      expect(result).toContain("<deepseek:subagent.done>");
      expect(result).toContain("nickname: padded_name");

      const request = createMock.mock.calls[0]?.[0] as { model: string; messages: Array<{ role: string; content: string }> };
      expect(request.model).toBe("env-model");
      expect(request.messages[0]?.role).toBe("system");
      expect(request.messages[0]?.content).toContain("You are a specialized sub-agent.");
    } finally {
      if (oldSeekModel === undefined) delete process.env.SEEKCODE_MODEL;
      else process.env.SEEKCODE_MODEL = oldSeekModel;
      if (oldModel === undefined) delete process.env.DEEPSEEK_MODEL;
      else process.env.DEEPSEEK_MODEL = oldModel;
    }
  });

  it("uses registered runtime config for spawn_agent credentials and default model", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    registerSubAgentTool({
      api_key: "config-key",
      base_url: "https://config.example/v1",
      model: "configured-model",
    });

    const result = await getRegistry().lookup("spawn_agent")!.execute({
      task: "use configured runtime",
    });

    expect(result).toContain("<deepseek:subagent.done>");
    expect(OpenAIMock).toHaveBeenCalledWith({
      apiKey: "config-key",
      baseURL: "https://config.example/v1",
    });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      model: "configured-model",
    });
  });

  it("falls back to canonical SEEKCODE env vars for spawn_agent when no runtime config is registered", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    const oldSeekApiKey = process.env.SEEKCODE_API_KEY;
    const oldSeekBaseUrl = process.env.SEEKCODE_BASE_URL;
    const oldSeekModel = process.env.SEEKCODE_MODEL;
    const oldDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
    const oldDeepseekBaseUrl = process.env.DEEPSEEK_BASE_URL;
    const oldDeepseekModel = process.env.DEEPSEEK_MODEL;

    process.env.SEEKCODE_API_KEY = "seekcode-key";
    process.env.SEEKCODE_BASE_URL = "https://seekcode.example/v1";
    process.env.SEEKCODE_MODEL = "seekcode-model";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.DEEPSEEK_MODEL;

    try {
      registerSubAgentTool();

      const result = await getRegistry().lookup("spawn_agent")!.execute({
        task: "use seekcode env",
      });

      expect(result).toContain("<deepseek:subagent.done>");
      expect(OpenAIMock).toHaveBeenCalledWith({
        apiKey: "seekcode-key",
        baseURL: "https://seekcode.example/v1",
      });
      expect(createMock.mock.calls[0]?.[0]).toMatchObject({
        model: "seekcode-model",
      });
    } finally {
      if (oldSeekApiKey === undefined) delete process.env.SEEKCODE_API_KEY;
      else process.env.SEEKCODE_API_KEY = oldSeekApiKey;
      if (oldSeekBaseUrl === undefined) delete process.env.SEEKCODE_BASE_URL;
      else process.env.SEEKCODE_BASE_URL = oldSeekBaseUrl;
      if (oldSeekModel === undefined) delete process.env.SEEKCODE_MODEL;
      else process.env.SEEKCODE_MODEL = oldSeekModel;
      if (oldDeepseekApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldDeepseekApiKey;
      if (oldDeepseekBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
      else process.env.DEEPSEEK_BASE_URL = oldDeepseekBaseUrl;
      if (oldDeepseekModel === undefined) delete process.env.DEEPSEEK_MODEL;
      else process.env.DEEPSEEK_MODEL = oldDeepseekModel;
    }
  });

  it("rejects non-string spawn_agent client overrides before constructing malformed upstream config", async () => {
    registerSubAgentTool();

    expect(await getRegistry().lookup("spawn_agent")!.execute({
      task: "bad system prompt",
      system_prompt: { nested: true } as any,
    })).toBe("Error: system_prompt must be a string.");
    expect(await getRegistry().lookup("spawn_agent")!.execute({
      task: "bad api key",
      api_key: { nested: true } as any,
    })).toBe("Error: api_key must be a string.");
    expect(await getRegistry().lookup("spawn_agent")!.execute({
      task: "bad base url",
      base_url: { nested: true } as any,
    })).toBe("Error: base_url must be a string.");
    expect(await getRegistry().lookup("spawn_agent")!.execute({
      task: "bad model",
      model: { nested: true } as any,
    })).toBe("Error: model must be a string.");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects malformed spawn_agent numeric controls instead of silently defaulting them", async () => {
    registerSubAgentTool();
    const tool = getRegistry().lookup("spawn_agent")!;
    const hostileArgs = [
      { get task() { throw new Error("task getter should not leak"); } },
      { task: "bad system prompt", get system_prompt() { throw new Error("system_prompt getter should not leak"); } },
      { task: "bad profile", get profile() { throw new Error("profile getter should not leak"); } },
      { task: "bad api key", get api_key() { throw new Error("api_key getter should not leak"); } },
      { task: "bad base url", get base_url() { throw new Error("base_url getter should not leak"); } },
      { task: "bad model", get model() { throw new Error("model getter should not leak"); } },
      { task: "bad timeout", get timeout_ms() { throw new Error("timeout_ms getter should not leak"); } },
      { task: "bad turns", get max_turns() { throw new Error("max_turns getter should not leak"); } },
    ];

    expect(await tool.validateInput?.(
      { task: "bad system prompt", system_prompt: { nested: true } as any },
      { tool_name: "spawn_agent", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("system_prompt must be a string"),
    });
    expect(await tool.validateInput?.(
      { task: "bad timeout", timeout_ms: { nested: true } as any },
      { tool_name: "spawn_agent", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("timeout_ms must be a number"),
    });
    expect(await tool.validateInput?.(
      { task: "bad turns", max_turns: { nested: true } as any },
      { tool_name: "spawn_agent", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_turns must be a number"),
    });
    for (const [key, value] of [
      ["timeout_ms", "10000.5"],
      ["timeout_ms", "10000ms"],
      ["timeout_ms", "0x2710"],
      ["timeout_ms", ""],
      ["max_turns", "2.5"],
      ["max_turns", "2turns"],
      ["max_turns", "0x2"],
      ["max_turns", ""],
    ] as const) {
      expect(await tool.validateInput?.(
        { task: "bad numeric string", [key]: value },
        { tool_name: "spawn_agent", workspace_path: "/tmp/workspace", tool_def: tool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining(`${key} must be a number`),
      });
      expect(await tool.execute({ task: "bad numeric string", [key]: value })).toBe(`Error: ${key} must be a number.`);
    }

    expect(await tool.execute({ task: "bad system prompt", system_prompt: { nested: true } as any })).toBe("Error: system_prompt must be a string.");
    expect(await tool.execute({ task: "bad timeout", timeout_ms: { nested: true } as any })).toBe("Error: timeout_ms must be a number.");
    expect(await tool.execute({ task: "bad turns", max_turns: { nested: true } as any })).toBe("Error: max_turns must be a number.");
    for (const args of hostileArgs) {
      expect(await tool.validateInput?.(
        args as any,
        { tool_name: "spawn_agent", workspace_path: "/tmp/workspace", tool_def: tool },
      )).toMatchObject({
        ok: false,
        message: expect.not.stringContaining("getter should not leak"),
      });
      expect(await tool.execute(args as any)).not.toContain("getter should not leak");
    }
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects non-string agent_status selectors instead of stringifying objects into fake ids", async () => {
    registerSubAgentTool();
    const tool = getRegistry().lookup("agent_status")!;
    const throwingAgentId = { get agent_id() { throw new Error("agent_id getter should not leak"); } };
    const throwingNickname = { get nickname() { throw new Error("nickname getter should not leak"); } };

    expect(await tool.validateInput?.(
      { agent_id: { nested: true } as any },
      { tool_name: "agent_status", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("agent_id must be a string"),
    });
    expect(await tool.validateInput?.(
      { nickname: { nested: true } as any },
      { tool_name: "agent_status", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("nickname must be a string"),
    });

    const result = await getRegistry().lookup("agent_status")!.execute({
      agent_id: { nested: true } as any,
    });

    expect(result).toBe("Error: agent_id must be a string.");
    expect(await getRegistry().lookup("agent_status")!.execute({
      nickname: { nested: true } as any,
    })).toBe("Error: nickname must be a string.");
    for (const args of [throwingAgentId as any, throwingNickname as any]) {
      expect(await tool.validateInput?.(
        args,
        { tool_name: "agent_status", workspace_path: "/tmp/workspace", tool_def: tool },
      )).toMatchObject({
        ok: false,
        message: expect.not.stringContaining("getter should not leak"),
      });
      expect(await tool.execute(args)).not.toContain("getter should not leak");
    }
  });

  it("finds spawned agents by nickname as well as by id", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    registerSubAgentTool();

    const spawned = await getRegistry().lookup("spawn_agent")!.execute({
      task: "check status lookup",
      task_name: "status lookup",
    });
    const nickname = spawned.match(/nickname:\s+([^\n]+)/)?.[1]?.trim();

    expect(nickname).toBe("status_lookup");
    expect(await getRegistry().lookup("agent_status")!.execute({
      nickname,
    })).toContain("status lookup");
  });

  it("limits rlm_query fan-out to max_children", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });
    registerRLMTool();

    const result = await getRegistry().lookup("rlm_query")!.execute({
      prompts: JSON.stringify([
        { id: "q1", prompt: "one" },
        { id: "q2", prompt: "two" },
        { id: "q3", prompt: "three" },
      ]),
      max_children: 2,
    });

    const parsed = JSON.parse(result) as Array<{ id: string; result: string }>;

    expect(parsed).toHaveLength(2);
    expect(parsed.map(item => item.id)).toEqual(["q1", "q2"]);
  });

  it("uses canonical SEEKCODE env vars for rlm_query before legacy DEEPSEEK vars", async () => {
    const oldSeekApiKey = process.env.SEEKCODE_API_KEY;
    const oldSeekBaseUrl = process.env.SEEKCODE_BASE_URL;
    const oldSeekFlashModel = process.env.SEEKCODE_FLASH_MODEL;
    const oldDeepseekApiKey = process.env.DEEPSEEK_API_KEY;
    const oldDeepseekBaseUrl = process.env.DEEPSEEK_BASE_URL;
    const oldDeepseekFlashModel = process.env.DEEPSEEK_FLASH_MODEL;
    process.env.SEEKCODE_API_KEY = "seekcode-key";
    process.env.SEEKCODE_BASE_URL = "https://seekcode.example/v1";
    process.env.SEEKCODE_FLASH_MODEL = "seekcode-flash";
    process.env.DEEPSEEK_API_KEY = "legacy-key";
    process.env.DEEPSEEK_BASE_URL = "https://legacy.example/v1";
    process.env.DEEPSEEK_FLASH_MODEL = "legacy-flash";
    createMock.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });
    registerRLMTool();

    try {
      await getRegistry().lookup("rlm_query")!.execute({
        prompts: JSON.stringify([{ id: "q1", prompt: "one" }]),
      });

      expect(OpenAIMock).toHaveBeenCalledWith({ apiKey: "seekcode-key", baseURL: "https://seekcode.example/v1" });
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ model: "seekcode-flash" }));
    } finally {
      if (oldSeekApiKey === undefined) delete process.env.SEEKCODE_API_KEY;
      else process.env.SEEKCODE_API_KEY = oldSeekApiKey;
      if (oldSeekBaseUrl === undefined) delete process.env.SEEKCODE_BASE_URL;
      else process.env.SEEKCODE_BASE_URL = oldSeekBaseUrl;
      if (oldSeekFlashModel === undefined) delete process.env.SEEKCODE_FLASH_MODEL;
      else process.env.SEEKCODE_FLASH_MODEL = oldSeekFlashModel;
      if (oldDeepseekApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldDeepseekApiKey;
      if (oldDeepseekBaseUrl === undefined) delete process.env.DEEPSEEK_BASE_URL;
      else process.env.DEEPSEEK_BASE_URL = oldDeepseekBaseUrl;
      if (oldDeepseekFlashModel === undefined) delete process.env.DEEPSEEK_FLASH_MODEL;
      else process.env.DEEPSEEK_FLASH_MODEL = oldDeepseekFlashModel;
    }
  });

  it("coerces non-positive rlm_query max_children to the minimum instead of defaulting to eight", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });
    registerRLMTool();

    const result = await getRegistry().lookup("rlm_query")!.execute({
      prompts: JSON.stringify([
        { id: "q1", prompt: "one" },
        { id: "q2", prompt: "two" },
      ]),
      max_children: 0,
    });

    const parsed = JSON.parse(result) as Array<{ id: string; result: string }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("q1");
  });

  it("rejects malformed rlm_query prompt entries before calling the API", async () => {
    registerRLMTool();

    const result = await getRegistry().lookup("rlm_query")!.execute({
      prompts: JSON.stringify([{ id: "q1" }, { prompt: "missing id" }]),
    });

    expect(result).toContain("each prompt entry must include non-empty id and prompt strings");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects malformed rlm_query prompt entries during validation instead of deferring them to execution", async () => {
    registerRLMTool();
    const tool = getRegistry().lookup("rlm_query")!;

    expect(await tool.validateInput?.(
      { prompts: JSON.stringify([{ id: "q1" }, { prompt: "missing id" }]) },
      { tool_name: "rlm_query", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("each prompt entry must include non-empty id and prompt strings"),
    });
  });

  it("rejects non-string rlm_query prompts before attempting JSON parsing", async () => {
    registerRLMTool();
    const tool = getRegistry().lookup("rlm_query")!;
    const throwingPrompts = { get prompts() { throw new Error("prompts getter should not leak"); } };

    const result = await getRegistry().lookup("rlm_query")!.execute({
      prompts: { nested: true } as any,
    });

    expect(result).toContain("prompts must be valid JSON array");
    expect(await tool.validateInput?.(
      throwingPrompts as any,
      { tool_name: "rlm_query", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.not.stringContaining("getter should not leak"),
    });
    expect(await tool.execute(throwingPrompts as any)).not.toContain("getter should not leak");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects malformed rlm_query max_children values instead of silently defaulting fan-out", async () => {
    registerRLMTool();
    const tool = getRegistry().lookup("rlm_query")!;
    const throwingMaxChildren = {
      prompts: JSON.stringify([{ id: "q1", prompt: "one" }]),
      get max_children() { throw new Error("max_children getter should not leak"); },
    };

    expect(await tool.validateInput?.(
      { prompts: JSON.stringify([{ id: "q1", prompt: "one" }]), max_children: { nested: true } as any },
      { tool_name: "rlm_query", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_children must be a number"),
    });
    expect(await tool.validateInput?.(
      throwingMaxChildren as any,
      { tool_name: "rlm_query", workspace_path: "/tmp/workspace", tool_def: tool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_children must be a number"),
    });
    expect(await tool.execute(throwingMaxChildren as any)).toContain("max_children must be a number");
    for (const value of ["2.5", "2kids", "0x2", ""]) {
      expect(await tool.validateInput?.(
        { prompts: JSON.stringify([{ id: "q1", prompt: "one" }]), max_children: value },
        { tool_name: "rlm_query", workspace_path: "/tmp/workspace", tool_def: tool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("max_children must be a number"),
      });
      expect(await tool.execute({
        prompts: JSON.stringify([{ id: "q1", prompt: "one" }]),
        max_children: value,
      })).toContain("max_children must be a number");
    }

    const result = await tool.execute({
      prompts: JSON.stringify([{ id: "q1", prompt: "one" }]),
      max_children: { nested: true } as any,
    });

    expect(result).toContain("max_children must be a number");
    expect(createMock).not.toHaveBeenCalled();
  });
});
