/** RLM tool — fan-out parallel queries to flash model. */

import OpenAI from "openai";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { safeJsonStringify } from "../utils/json-safe.js";

interface RLMQuery { id: string; prompt: string; system?: string; }
const RLM_TYPED_ARG_KEYS = new Set(["id", "max_children", "prompt", "prompts", "system"]);

function validateOptionalFiniteNumber(value: unknown, key: "max_children"): string | null {
  if (value === undefined) return null;
  return strictInteger(value) !== undefined ? null : `${key} must be a number.`;
}

function parsePrompts(promptsStr: string): { queries?: RLMQuery[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(promptsStr);
  } catch {
    return { error: "Error: prompts must be valid JSON array" };
  }
  if (!Array.isArray(parsed)) return { error: "Error: prompts must be a JSON array" };
  const queries: RLMQuery[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      return { error: "Error: each prompt entry must include non-empty id and prompt strings" };
    }
    const record = entry as Record<string, unknown>;
    const idValue = safeRlmProperty(record, "id");
    const promptValue = safeRlmProperty(record, "prompt");
    const systemValue = safeRlmProperty(record, "system");
    const id = typeof idValue === "string" ? idValue.trim() : "";
    const prompt = typeof promptValue === "string" ? promptValue.trim() : "";
    if (!id || !prompt) {
      return { error: "Error: each prompt entry must include non-empty id and prompt strings" };
    }
    queries.push({
      id,
      prompt,
      ...(typeof systemValue === "string" ? { system: systemValue } : {}),
    });
  }
  return { queries };
}

async function rlmQuery(args: Record<string, unknown>): Promise<string> {
  const promptsInput = safeRlmProperty(args, "prompts");
  const maxChildrenInput = safeRlmProperty(args, "max_children");
  if (typeof promptsInput !== "string") return "Error: prompts must be valid JSON array";
  const maxChildrenError = validateOptionalFiniteNumber(maxChildrenInput, "max_children");
  if (maxChildrenError) return `Error: ${maxChildrenError}`;
  const promptsStr = promptsInput;
  const maxChildren = normalizeMaxChildren(maxChildrenInput);
  const parsed = parsePrompts(promptsStr);
  if (parsed.error) return parsed.error;
  let queries = parsed.queries!;
  queries = queries.slice(0, maxChildren);

  const apiKey = envValue("SEEKCODE_API_KEY", "DEEPSEEK_API_KEY") || "";
  const baseUrl = envValue("SEEKCODE_BASE_URL", "DEEPSEEK_BASE_URL") || "https://api.deepseek.com";
  const flashModel = envValue("SEEKCODE_FLASH_MODEL", "DEEPSEEK_FLASH_MODEL") || "deepseek-v4-flash";
  const client = new OpenAI({ apiKey, baseURL: baseUrl });

  const runOne = async (q: RLMQuery) => {
    try {
      const resp = await client.chat.completions.create({
        model: flashModel, max_tokens: 2048,
        messages: [{ role: "system", content: q.system || "You are a helpful assistant." }, { role: "user", content: q.prompt }],
      });
      return { id: q.id, result: resp.choices[0]?.message?.content || "", error: null };
    } catch (e: any) { return { id: q.id, result: null, error: e.message }; }
  };

  const results = await Promise.all(queries.map(runOne));
  return safeJsonStringify(results, { space: 2 });
}

function normalizeMaxChildren(value: unknown): number {
  const parsed = strictInteger(value);
  if (parsed === undefined) return 8;
  return Math.max(1, Math.min(Math.floor(parsed), 16));
}

function strictInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[-+]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function envValue(primary: string, fallback: string): string | undefined {
  return process.env[primary]?.trim() || process.env[fallback]?.trim() || undefined;
}

export function registerRLMTool(): void {
  getRegistry().register({
    name: "rlm_query", description: "Fan out parallel reasoning queries (1-16 children) to a fast model.",
    parameters: { type: "object", properties: { prompts: { type: "string", description: "JSON array of {id, prompt, system?}" }, max_children: { type: "integer", default: 8 } }, required: ["prompts"] },
    execute: rlmQuery, permission: PermissionLevel.ALWAYS_ALLOW, category: "meta", parallelOk: true,
    validateInput: (args) => {
      const promptsInput = safeRlmProperty(args, "prompts");
      const maxChildrenInput = safeRlmProperty(args, "max_children");
      if (typeof promptsInput !== "string") return { ok: false as const, message: "prompts must be valid JSON array" };
      const maxChildrenError = validateOptionalFiniteNumber(maxChildrenInput, "max_children");
      if (maxChildrenError) return { ok: false as const, message: maxChildrenError };
      const parsed = parsePrompts(promptsInput);
      if (parsed.error) return { ok: false as const, message: parsed.error.replace(/^Error:\s*/, "") };
      return { ok: true as const, args: safeRlmCloneArgs(args) };
    },
  });
}

function safeRlmProperty(source: unknown, key: string): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return RLM_TYPED_ARG_KEYS.has(key) ? null : undefined;
  }
}

function safeRlmCloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(args);
  } catch {
    return clone;
  }
  for (const key of keys) {
    const value = safeRlmProperty(args, key);
    if (value !== undefined) clone[key] = value;
  }
  return clone;
}
