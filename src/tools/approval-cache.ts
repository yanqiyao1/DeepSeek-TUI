/** Permission denial tracking and approval caching.
 *
 * Adopted from claude-code-rev: tracks denied tools per-session to reduce
 * repetitive approval prompts. Remembers user choices for specific tools
 * and patterns within a session.
 *
 * Strategy:
 * - rememberApproval / rememberDenial — cache per-tool decisions
 * - isApproved / isDenied — fast lookup before prompting
 * - DenialReason — why a denial happened, for UI explanation
 * - Per-session scope; cleared on session reset
 */

import { createHash } from "node:crypto";
import { stableJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_APPROVAL_RECORDS = 512;
const MAX_DENIAL_RECORDS = 512;
const MAX_DENIAL_HISTORY = 256;
const MAX_CACHE_TOOL_NAME_CHARS = 128;
const MAX_CACHE_KEY_CHARS = 16_000;
const MAX_CACHE_ARGS_JSON_CHARS = 12_000;
const MAX_CACHE_ARG_KEYS = 128;
const MAX_CACHE_ARG_ARRAY_ITEMS = 128;
const MAX_CACHE_ARG_STRING_CHARS = 2_000;
const MAX_CACHE_ARG_DEPTH = 8;
const CACHE_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

export enum DenialReason {
  USER_DENIED = "user_denied",
  TIMEOUT = "timeout",
  POLICY_DENY = "policy_deny",
  MODE_RESTRICTION = "mode_restriction",
  PREVIOUSLY_DENIED = "previously_denied",
}

export interface DenialRecord {
  toolName: string;
  key: string;
  reason: DenialReason;
  deniedAt: number;
  arguments?: Record<string, unknown>;
}

export interface ApprovalRecord {
  toolName: string;
  key: string;
  approvedAt: number;
  /** If "always", applies to future calls matching this approval key in this session. */
  scope: "once" | "always";
}

class ApprovalCache {
  private approvals: Map<string, ApprovalRecord> = new Map();
  private denials: Map<string, DenialRecord> = new Map();
  private denialHistory: DenialRecord[] = [];

  // ── Approval ──────────────────────────────────────────────

  rememberApproval(toolName: string, scope: "once" | "always" = "once", args?: Record<string, unknown>): void {
    const safeToolName = normalizeCacheToolName(toolName);
    if (!safeToolName) return;
    const key = cacheKey(safeToolName, args);
    const safeScope = scope === "always" ? "always" : "once";
    this.clearDenialsFor(safeToolName, safeScope === "always" && args === undefined ? undefined : key);
    this.approvals.set(key, {
      toolName: safeToolName,
      key,
      approvedAt: Date.now(),
      scope: safeScope,
    });
    pruneMap(this.approvals, MAX_APPROVAL_RECORDS);
  }

  isApproved(toolName: string, args?: Record<string, unknown>): boolean {
    const safeToolName = normalizeCacheToolName(toolName);
    if (!safeToolName) return false;
    const exactKey = cacheKey(safeToolName, args);
    const record = this.approvals.get(exactKey) || this.approvals.get(cacheKey(safeToolName));
    if (!record) return false;
    if (record.scope === "always") return true;
    // "once" approvals expire after use
    this.approvals.delete(record.key);
    return true;
  }

  // ── Denial ────────────────────────────────────────────────

  rememberDenial(
    toolName: string,
    reason: DenialReason,
    args?: Record<string, unknown>,
  ): void {
    const safeToolName = normalizeCacheToolName(toolName);
    if (!safeToolName) return;
    const key = cacheKey(safeToolName, args);
    const safeArgs = sanitizeCacheArgs(args);
    this.clearApprovalsFor(safeToolName, args === undefined ? undefined : key);
    const record: DenialRecord = {
      toolName: safeToolName,
      key,
      reason: normalizeDenialReason(reason),
      deniedAt: Date.now(),
    };
    if (safeArgs !== undefined) record.arguments = safeArgs;
    this.denials.set(key, record);
    this.denialHistory.push(record);
    pruneMap(this.denials, MAX_DENIAL_RECORDS);
    if (this.denialHistory.length > MAX_DENIAL_HISTORY) {
      this.denialHistory = this.denialHistory.slice(-MAX_DENIAL_HISTORY);
    }
  }

  isDenied(toolName: string, args?: Record<string, unknown>): DenialRecord | undefined {
    const safeToolName = normalizeCacheToolName(toolName);
    if (!safeToolName) return undefined;
    return cloneDenialRecord(this.denials.get(cacheKey(safeToolName, args)) || this.denials.get(cacheKey(safeToolName)));
  }

  getDenialHistory(): DenialRecord[] {
    return this.denialHistory.map(cloneDenialRecord).filter((record): record is DenialRecord => !!record);
  }

  getDenialCount(): number {
    return this.denialHistory.length;
  }

  // ── Clear ─────────────────────────────────────────────────

  clearTool(toolName: string): void {
    const safeToolName = normalizeCacheToolName(toolName);
    if (!safeToolName) return;
    for (const key of this.approvals.keys()) {
      if (keyBelongsToTool(key, safeToolName)) this.approvals.delete(key);
    }
    for (const key of this.denials.keys()) {
      if (keyBelongsToTool(key, safeToolName)) this.denials.delete(key);
    }
    this.denialHistory = this.denialHistory.filter(record => record.toolName !== safeToolName);
  }

  clearAll(): void {
    this.approvals.clear();
    this.denials.clear();
    this.denialHistory = [];
  }

  // ── Stats ─────────────────────────────────────────────────

  getStats(): ApprovalStats {
    return {
      approvals: this.approvals.size,
      denials: this.denials.size,
      denialHistory: this.denialHistory.length,
      alwaysApproved: [...this.approvals.values()].filter(a => a.scope === "always").length,
    };
  }

  private clearApprovalsFor(toolName: string, key?: string): void {
    if (key) {
      this.approvals.delete(key);
      return;
    }
    for (const approvalKey of this.approvals.keys()) {
      if (keyBelongsToTool(approvalKey, toolName)) this.approvals.delete(approvalKey);
    }
  }

  private clearDenialsFor(toolName: string, key?: string): void {
    if (key) {
      this.denials.delete(key);
      this.denialHistory = this.denialHistory.filter(record => record.key !== key);
      return;
    }
    for (const denialKey of this.denials.keys()) {
      if (keyBelongsToTool(denialKey, toolName)) this.denials.delete(denialKey);
    }
    this.denialHistory = this.denialHistory.filter(record => record.toolName !== toolName);
  }
}

export interface ApprovalStats {
  approvals: number;
  denials: number;
  denialHistory: number;
  alwaysApproved: number;
}

// Singleton
let cacheInstance: ApprovalCache | null = null;
export function getApprovalCache(): ApprovalCache {
  if (!cacheInstance) cacheInstance = new ApprovalCache();
  return cacheInstance;
}
export function clearApprovalCache(): void {
  cacheInstance?.clearAll();
  cacheInstance = null;
}

/**
 * Check if a tool should be approved based on cache and policy.
 * Returns a decision and optional explanation.
 */
export function checkApprovalCache(
  toolName: string,
  permission: string,
  args?: Record<string, unknown>,
): { decision: "approved" | "denied" | "ask"; reason?: string } {
  const cache = getApprovalCache();

  // Always-allow permissions skip cache check
  if (permission === "always_allow") {
    return { decision: "approved" };
  }

  // Check for previous denial
  const denial = cache.isDenied(toolName, args);
  if (denial) {
    return { decision: "denied", reason: `Denied at ${new Date(denial.deniedAt).toLocaleTimeString()}: ${denial.reason}` };
  }

  // Check for previous "always" approval
  if (cache.isApproved(toolName, args)) {
    return { decision: "approved", reason: "Previously approved for this session" };
  }

  return { decision: "ask" };
}

function cacheKey(toolName: string, args?: Record<string, unknown>): string {
  const safeToolName = normalizeCacheToolName(toolName);
  if (!safeToolName) return "";
  const argsKey = args === undefined ? "" : stableStringify(sanitizeCacheArgs(args) ?? {});
  if (!argsKey) return safeToolName;
  return safeSlice(`${safeToolName}:${argsKey}`, MAX_CACHE_KEY_CHARS);
}

function stableStringify(value: unknown): string {
  return truncateWithHash(stableJsonStringify(value), MAX_CACHE_ARGS_JSON_CHARS);
}

function normalizeCacheToolName(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(CACHE_CONTROL_RE, " ").trim().split(/\s+/)[0] || "";
  return normalized.length <= MAX_CACHE_TOOL_NAME_CHARS ? normalized : "";
}

function normalizeDenialReason(value: unknown): DenialReason {
  return Object.values(DenialReason).includes(value as DenialReason)
    ? value as DenialReason
    : DenialReason.USER_DENIED;
}

function sanitizeCacheArgs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sanitized = sanitizeCacheValue(value, new WeakSet<object>(), 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : undefined;
}

function sanitizeCacheValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return safeSlice(value.replace(CACHE_CONTROL_RE, " "), MAX_CACHE_ARG_STRING_CHARS);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_CACHE_ARG_DEPTH) return "[MaxDepth]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return safeArrayItems(value, MAX_CACHE_ARG_ARRAY_ITEMS).map(item => {
        const normalized = sanitizeCacheValue(item, seen, depth + 1);
        return normalized === undefined ? null : normalized;
      });
    }
    const result: Record<string, unknown> = {};
    for (const [rawKey, child] of safeObjectEntries(value, MAX_CACHE_ARG_KEYS)) {
      const key = safeSlice(rawKey.replace(CACHE_CONTROL_RE, " ").trim(), MAX_CACHE_TOOL_NAME_CHARS);
      if (!key) continue;
      const normalized = sanitizeCacheValue(child, seen, depth + 1);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function pruneMap<K, V>(map: Map<K, V>, maxEntries: number): void {
  while (map.size > maxEntries) {
    const first = map.keys().next().value as K | undefined;
    if (first === undefined) return;
    map.delete(first);
  }
}

function safeSlice(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return safeSliceTextBoundary(value, Math.max(0, maxChars));
}

function safeObjectEntries(value: unknown, maxEntries: number): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys.slice(0, Math.max(0, Math.floor(maxEntries)))) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      continue;
    }
  }
  return entries;
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const limit = Math.min(length, Math.max(0, Math.floor(maxItems)));
  const items: unknown[] = [];
  for (let index = 0; index < limit; index++) {
    try {
      items.push(value[index]);
    } catch {
      continue;
    }
  }
  return items;
}

function truncateWithHash(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 80) return safeSlice(value, maxChars);
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  const suffix = `...[sha256:${digest}]`;
  return `${safeSlice(value, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function keyBelongsToTool(key: string, toolName: string): boolean {
  return key === toolName || key.startsWith(`${toolName}:`);
}

function cloneDenialRecord(record: DenialRecord | undefined): DenialRecord | undefined {
  if (!record) return undefined;
  const cloned: DenialRecord = {
    toolName: record.toolName,
    key: record.key,
    reason: record.reason,
    deniedAt: record.deniedAt,
  };
  const safeArgs = sanitizeCacheArgs(record.arguments);
  if (safeArgs !== undefined) cloned.arguments = safeArgs;
  return cloned;
}
