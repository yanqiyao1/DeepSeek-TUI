/** Sub-agent tool — Codex-style spawn_agent with multi-thread, model override,
 * timeout management, and structured output.
 *
 * Key improvements:
 * - task_name for identification
 * - model override support
 * - timeout management with default/min/max
 * - structured output with agent_id + nickname
 * - concurrent agent tracking
 * - completion sentinel pattern
 */

import OpenAI from "openai";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { getAgentProfile, hasAgentProfile, listAgentProfiles } from "../engine/agent-profiles.js";
import type { Config } from "../config.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

type SubAgentRuntimeConfig = Pick<Config, "api_key" | "base_url" | "model">;

// ── Agent tracking ───────────────────────────────────────────

interface AgentRecord {
  id: string;
  task_name: string;
  nickname: string;
  profile: string;
  task: string;
  status: "running" | "done" | "error";
  result?: string;
  error?: string;
  started_at: number;
  completed_at?: number;
}

const runningAgents: Map<string, AgentRecord> = new Map();
let nextAgentId = 1;
const UNREADABLE_AGENT_ARG = Symbol("unreadable_agent_arg");
const AGENT_TYPED_ARG_KEYS = new Set([
  "agent_id",
  "api_key",
  "base_url",
  "max_turns",
  "model",
  "nickname",
  "profile",
  "system_prompt",
  "task",
  "task_name",
  "timeout_ms",
]);

export function getAgentState(): AgentRecord[] {
  return [...runningAgents.values()];
}
export function clearAgentState(): void {
  runningAgents.clear();
  nextAgentId = 1;
}

function validateOptionalFiniteNumber(value: unknown, key: "timeout_ms" | "max_turns"): string | null {
  if (value === undefined) return null;
  return strictInteger(value) !== undefined ? null : `${key} must be a number.`;
}

// ── spawn_agent ──────────────────────────────────────────────

async function spawnAgent(args: Record<string, unknown>, runtimeConfig?: SubAgentRuntimeConfig): Promise<string> {
  const taskInput = safeAgentProperty(args, "task");
  const taskNameInput = safeAgentProperty(args, "task_name");
  const systemPromptInput = safeAgentProperty(args, "system_prompt");
  const profileInput = safeAgentProperty(args, "profile");
  const maxTurnsInput = safeAgentProperty(args, "max_turns");
  const timeoutInput = safeAgentProperty(args, "timeout_ms");
  const apiKeyInput = safeAgentProperty(args, "api_key");
  const baseUrlInput = safeAgentProperty(args, "base_url");
  const modelInput = safeAgentProperty(args, "model");
  const task = typeof taskInput === "string" ? taskInput.trim() : "";
  const taskName = typeof taskNameInput === "string" && taskNameInput.trim()
    ? taskNameInput.trim()
    : `agent-${nextAgentId}`;
  if (systemPromptInput !== undefined && typeof systemPromptInput !== "string") return "Error: system_prompt must be a string.";
  if (profileInput !== undefined && typeof profileInput !== "string") return "Error: profile must be a string.";
  if (profileInput !== undefined && !hasAgentProfile(profileInput)) return `Error: unknown profile '${profileInput}'.`;
  const profile = getAgentProfile(profileInput);
  const systemPrompt = typeof systemPromptInput === "string" ? systemPromptInput.trim() : "";
  const maxTurns = normalizeMaxTurns(maxTurnsInput, profile.defaultMaxTurns);
  const timeout = normalizeTimeoutMs(timeoutInput);

  if (!task) return "Error: task is required.";
  if (apiKeyInput !== undefined && typeof apiKeyInput !== "string") return "Error: api_key must be a string.";
  if (baseUrlInput !== undefined && typeof baseUrlInput !== "string") return "Error: base_url must be a string.";
  if (modelInput !== undefined && typeof modelInput !== "string") return "Error: model must be a string.";
  const timeoutError = validateOptionalFiniteNumber(timeoutInput, "timeout_ms");
  if (timeoutError) return `Error: ${timeoutError}`;
  const maxTurnsError = validateOptionalFiniteNumber(maxTurnsInput, "max_turns");
  if (maxTurnsError) return `Error: ${maxTurnsError}`;

  const apiKey = resolveStringOption(apiKeyInput, runtimeConfig?.api_key, envValue("SEEKCODE_API_KEY", "DEEPSEEK_API_KEY"), "");
  const baseUrl = resolveStringOption(baseUrlInput, runtimeConfig?.base_url, envValue("SEEKCODE_BASE_URL", "DEEPSEEK_BASE_URL"), "https://api.deepseek.com");
  const model = (typeof modelInput === "string" && modelInput.trim() ? modelInput.trim() : "") ||
    runtimeConfig?.model ||
    envValue("SEEKCODE_MODEL", "DEEPSEEK_MODEL") ||
    profile.defaultModel;

  const agentId = `agent_${nextAgentId++}`;
  const nickname = safeSliceTextBoundary(taskName.replace(/[^a-z0-9_]/gi, "_"), 40);

  const record: AgentRecord = {
    id: agentId,
    task_name: taskName,
    nickname,
    profile: profile.name,
    task,
    status: "running",
    started_at: Date.now(),
  };
  runningAgents.set(agentId, record);

  const client = new OpenAI({ apiKey, baseURL: baseUrl });
  const abortController = new AbortController();
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeout);
  timeoutTimer.unref?.();

  const sysPrompt = systemPrompt || profile.systemPrompt;

  const messages: any[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: task },
  ];

  let content = "";
  try {
    for (let i = 0; i < maxTurns; i++) {
      const resp = await client.chat.completions.create({
        model, messages, max_tokens: 4096,
      }, { signal: abortController.signal } as any);
      content = resp.choices[0]?.message?.content || "";
      const finish = resp.choices[0]?.finish_reason || "";

      if (finish === "stop") {
        record.status = "done";
        record.result = content;
        record.completed_at = Date.now();
        const dur = ((record.completed_at - record.started_at) / 1000).toFixed(1);
        return formatAgentDone(agentId, nickname, "done", content, dur);
      }

      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: "Continue or provide your final result." });
    }

    record.status = "done";
    record.result = content;
    record.completed_at = Date.now();
    const dur = ((record.completed_at - record.started_at) / 1000).toFixed(1);
    return formatAgentDone(agentId, nickname, "done", content || "Completed without output.", dur);
  } catch (e: any) {
    const message = timedOut ? `timed out after ${timeout}ms` : e.message;
    record.status = "error";
    record.error = message;
    record.completed_at = Date.now();
    const dur = ((record.completed_at - record.started_at) / 1000).toFixed(1);
    return formatAgentDone(agentId, nickname, "error", message, dur);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

function normalizeTimeoutMs(value: unknown): number {
  const parsed = strictInteger(value);
  if (parsed === undefined) return 120_000;
  return Math.max(10_000, Math.min(Math.floor(parsed), 600_000));
}

function normalizeMaxTurns(value: unknown, fallback = 15): number {
  const parsed = strictInteger(value);
  if (parsed === undefined) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function strictInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[-+]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function envValue(primary: string, fallback: string): string {
  return process.env[primary] || process.env[fallback] || "";
}

function resolveStringOption(value: unknown, configValue: string | undefined, envValue: string, fallback: string): string {
  const explicit = typeof value === "string" ? value.trim() : "";
  return explicit || configValue || envValue || fallback;
}

function formatAgentDone(
  agentId: string, nickname: string, status: string, result: string, duration: string,
): string {
  const summary = result.length > 1000
    ? safeSliceTextBoundary(result, 1000) + `\n... (${result.length} chars total)`
    : result;

  return [
    `<deepseek:subagent.${status}>`,
    `  agent_id: ${agentId}`,
    `  nickname: ${nickname}`,
    `  duration_s: ${duration}`,
    `  summary: |`,
    summary.split("\n").map(l => `    ${l}`).join("\n"),
    `</deepseek:subagent.${status}>`,
  ].join("\n");
}

// ── agent_status ─────────────────────────────────────────────

async function agentStatus(args: Record<string, unknown>): Promise<string> {
  const agentIdInput = safeAgentProperty(args, "agent_id");
  const nicknameInput = safeAgentProperty(args, "nickname");
  if (agentIdInput !== undefined && typeof agentIdInput !== "string") {
    return "Error: agent_id must be a string.";
  }
  if (nicknameInput !== undefined && typeof nicknameInput !== "string") {
    return "Error: nickname must be a string.";
  }
  const agentId = typeof agentIdInput === "string" ? agentIdInput.trim() : "";
  const nickname = typeof nicknameInput === "string" ? nicknameInput.trim() : "";

  if (agentId || nickname) {
    const agent = agentId
      ? runningAgents.get(agentId)
      : [...runningAgents.values()].find(item => item.nickname === nickname);
    if (!agent) return `Agent not found: ${agentId || nickname}`;
    return formatAgentStatus(agent);
  }

  if (runningAgents.size === 0) return "No agents running or completed.";

  const lines = [`Agents: ${runningAgents.size} total\n`];
  for (const agent of runningAgents.values()) {
    const sym = agent.status === "running" ? "◎" : agent.status === "done" ? "●" : "✗";
    const dur = agent.completed_at
      ? `${((agent.completed_at - agent.started_at) / 1000).toFixed(1)}s`
      : "running...";
    lines.push(`  ${sym} [${agent.id}] ${agent.profile}:${agent.task_name} (${dur})`);
  }
  return lines.join("\n");
}

async function agentProfiles(): Promise<string> {
  return safeJsonStringify(listAgentProfiles(), { space: 2 });
}

function formatAgentStatus(agent: AgentRecord): string {
  const dur = agent.completed_at
    ? `${((agent.completed_at - agent.started_at) / 1000).toFixed(1)}s`
    : `${((Date.now() - agent.started_at) / 1000).toFixed(1)}s (running)`;

  return [
    `Agent: ${agent.id} (${agent.profile}:${agent.task_name})`,
    `Status: ${agent.status} | Duration: ${dur}`,
    agent.result ? `Result: ${safeSliceTextBoundary(agent.result, 500)}` : "",
    agent.error ? `Error: ${agent.error}` : "",
  ].filter(Boolean).join("\n");
}

function validateAgentStatusArgs(args: Record<string, unknown>) {
  const agentIdInput = safeAgentProperty(args, "agent_id");
  const nicknameInput = safeAgentProperty(args, "nickname");
  if (agentIdInput !== undefined && typeof agentIdInput !== "string") {
    return { ok: false as const, message: "agent_id must be a string." };
  }
  if (nicknameInput !== undefined && typeof nicknameInput !== "string") {
    return { ok: false as const, message: "nickname must be a string." };
  }
  const agentId = typeof agentIdInput === "string" ? agentIdInput.trim() : undefined;
  const nickname = typeof nicknameInput === "string" ? nicknameInput.trim() : undefined;
  return {
    ok: true as const,
    args: {
      ...safeAgentCloneArgs(args),
      ...(agentId ? { agent_id: agentId } : {}),
      ...(nickname ? { nickname } : {}),
    },
  };
}

// ── Registration ─────────────────────────────────────────────

export function registerSubAgentTool(config?: SubAgentRuntimeConfig): void {
  const r = getRegistry();

  r.register({
    name: "spawn_agent",
    description: [
      "Spawn a specialized sub-agent to handle a focused task independently.",
      "The agent runs asynchronously with its own context window.",
      "Results are returned in structured <deepseek:subagent.done> format.",
      "Use this for: parallel investigation, independent implementation tasks,",
      "or any work that benefits from dedicated attention without polluting",
      "the main conversation context.",
      "",
      "Provide a descriptive task_name for tracking. The agent inherits",
      "your current model by default — omit model to use the default.",
      "Set model only when an explicit override is needed.",
      "Max 5 agents should be running concurrently.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The sub-task for the agent to complete" },
        task_name: { type: "string", description: "Descriptive name (lowercase, underscores) for tracking" },
        profile: { type: "string", enum: ["general", "explore", "scout", "build", "plan"], default: "general", description: "Specialized built-in agent profile." },
        system_prompt: { type: "string", description: "Custom system prompt", default: "" },
        max_turns: { type: "integer", description: "Maximum reasoning turns", default: 15 },
        timeout_ms: { type: "integer", description: "Timeout in ms (10s-600s)", default: 120_000 },
        model: { type: "string", description: "Model override. Omit to inherit parent model." },
      },
      required: ["task"],
    },
    execute: (args) => spawnAgent(args, config),
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    validateInput: (args) => {
      const taskInput = safeAgentProperty(args, "task");
      const systemPromptInput = safeAgentProperty(args, "system_prompt");
      const profileInput = safeAgentProperty(args, "profile");
      const apiKeyInput = safeAgentProperty(args, "api_key");
      const baseUrlInput = safeAgentProperty(args, "base_url");
      const modelInput = safeAgentProperty(args, "model");
      const timeoutInput = safeAgentProperty(args, "timeout_ms");
      const maxTurnsInput = safeAgentProperty(args, "max_turns");
      const task = typeof taskInput === "string" ? taskInput.trim() : "";
      if (!task) return { ok: false as const, message: "task is required." };
      if (systemPromptInput !== undefined && typeof systemPromptInput !== "string") {
        return { ok: false as const, message: "system_prompt must be a string." };
      }
      if (profileInput !== undefined && typeof profileInput !== "string") {
        return { ok: false as const, message: "profile must be a string." };
      }
      if (profileInput !== undefined && !hasAgentProfile(profileInput)) {
        return { ok: false as const, message: `unknown profile '${profileInput}'.` };
      }
      if (apiKeyInput !== undefined && typeof apiKeyInput !== "string") return { ok: false as const, message: "api_key must be a string." };
      if (baseUrlInput !== undefined && typeof baseUrlInput !== "string") return { ok: false as const, message: "base_url must be a string." };
      if (modelInput !== undefined && typeof modelInput !== "string") return { ok: false as const, message: "model must be a string." };
      const timeoutError = validateOptionalFiniteNumber(timeoutInput, "timeout_ms");
      if (timeoutError) return { ok: false as const, message: timeoutError };
      const maxTurnsError = validateOptionalFiniteNumber(maxTurnsInput, "max_turns");
      if (maxTurnsError) return { ok: false as const, message: maxTurnsError };
      return { ok: true as const, args: { ...safeAgentCloneArgs(args), task } };
    },
  });

  // Keep old sub_agent for backwards compat (wraps spawn_agent)
  r.register({
    name: "sub_agent",
    description: "Legacy: use spawn_agent for new code. Spawn a sub-agent with fresh context.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string" },
        system_prompt: { type: "string", default: "" },
        max_turns: { type: "integer", default: 15 },
      },
      required: ["task"],
    },
    execute: async (args: Record<string, unknown>) => {
      const taskInput = safeAgentProperty(args, "task");
      const task = typeof taskInput === "string" ? taskInput : "";
      return spawnAgent({
        task,
        task_name: safeSliceTextBoundary(task, 40),
        system_prompt: safeAgentProperty(args, "system_prompt"),
        max_turns: safeAgentProperty(args, "max_turns"),
      }, config);
    },
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    validateInput: (args) => {
      const taskInput = safeAgentProperty(args, "task");
      const systemPromptInput = safeAgentProperty(args, "system_prompt");
      const maxTurnsInput = safeAgentProperty(args, "max_turns");
      const task = typeof taskInput === "string" ? taskInput.trim() : "";
      if (!task) return { ok: false as const, message: "task is required." };
      if (systemPromptInput !== undefined && typeof systemPromptInput !== "string") {
        return { ok: false as const, message: "system_prompt must be a string." };
      }
      const maxTurnsError = validateOptionalFiniteNumber(maxTurnsInput, "max_turns");
      if (maxTurnsError) return { ok: false as const, message: maxTurnsError };
      return { ok: true as const, args: { ...safeAgentCloneArgs(args), task } };
    },
  });

  r.register({
    name: "agent_status",
    description: "Check the status of spawned sub-agents. Use to monitor progress of parallel work.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Specific agent ID, or omit for all" },
        nickname: { type: "string", description: "Specific agent nickname, or omit for all" },
      },
    },
    execute: agentStatus,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    validateInput: validateAgentStatusArgs,
  });
  r.register({
    name: "agent_profiles",
    description: "List built-in sub-agent profiles and their intended use.",
    parameters: { type: "object", properties: {} },
    execute: agentProfiles,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    readOnly: true,
  });
}

function safeAgentProperty(source: unknown, key: string): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return AGENT_TYPED_ARG_KEYS.has(key) ? null : UNREADABLE_AGENT_ARG;
  }
}

function safeAgentCloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(args);
  } catch {
    return clone;
  }
  for (const key of keys) {
    const value = safeAgentProperty(args, key);
    if (value !== UNREADABLE_AGENT_ARG) clone[key] = value;
  }
  return clone;
}
