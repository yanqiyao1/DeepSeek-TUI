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
    const key = cacheKey(toolName, args);
    this.approvals.set(key, {
      toolName,
      key,
      approvedAt: Date.now(),
      scope,
    });
  }

  isApproved(toolName: string, args?: Record<string, unknown>): boolean {
    const exactKey = cacheKey(toolName, args);
    const record = this.approvals.get(exactKey) || this.approvals.get(cacheKey(toolName));
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
    const key = cacheKey(toolName, args);
    const record: DenialRecord = {
      toolName,
      key,
      reason,
      deniedAt: Date.now(),
    };
    if (args !== undefined) record.arguments = args;
    this.denials.set(key, record);
    this.denialHistory.push(record);
  }

  isDenied(toolName: string, args?: Record<string, unknown>): DenialRecord | undefined {
    return this.denials.get(cacheKey(toolName, args)) || this.denials.get(cacheKey(toolName));
  }

  getDenialHistory(): DenialRecord[] {
    return [...this.denialHistory];
  }

  getDenialCount(): number {
    return this.denialHistory.length;
  }

  // ── Clear ─────────────────────────────────────────────────

  clearTool(toolName: string): void {
    for (const key of this.approvals.keys()) {
      if (key === toolName || key.startsWith(`${toolName}:`)) this.approvals.delete(key);
    }
    for (const key of this.denials.keys()) {
      if (key === toolName || key.startsWith(`${toolName}:`)) this.denials.delete(key);
    }
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

  // Check for previous "always" approval
  if (cache.isApproved(toolName, args)) {
    return { decision: "approved", reason: "Previously approved for this session" };
  }

  // Check for previous denial
  const denial = cache.isDenied(toolName, args);
  if (denial) {
    return { decision: "denied", reason: `Denied at ${new Date(denial.deniedAt).toLocaleTimeString()}: ${denial.reason}` };
  }

  return { decision: "ask" };
}

function cacheKey(toolName: string, args?: Record<string, unknown>): string {
  if (!args) return toolName;
  return `${toolName}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
}
