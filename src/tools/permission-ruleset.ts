/** Permission ruleset system — pattern-matching allow/deny/ask with wildcards.
 *
 * Adopted from OpenCode: replaces simple approval cache with a ruleset-based
 * system supporting tool-name patterns, wildcards, "always" arrays for
 * remembered decisions, and session-scoped persistence.
 */

import { getToolPermissionPatterns, type ToolDef, type ToolPermissionMatcher } from "./base.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

const MAX_PERMISSION_RULES = 512;
const MAX_SESSION_RULES = 512;
const MAX_PERMISSION_TEXT_CHARS = 256;
const MAX_PATTERN_TEXT_CHARS = 2_000;
const MAX_PERMISSION_PATTERNS = 128;
const MAX_ARGS_VALUES = 128;
const MAX_PATCH_LINES = 2_000;
const PERMISSION_CONTROL_RE = /[\u0000-\u001F\u007F]/g;

// ── Types ────────────────────────────────────────────────────

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  permission: string;   // tool name or pattern (supports * wildcard)
  pattern: string;      // argument pattern to match (e.g., "*.ts", "rm *")
  action: PermissionAction;
}

export interface PermissionRequest {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  sessionID?: string;
  /** Specific argument patterns the model is asking about */
  patterns?: string[];
  /** Optional tool-prepared matcher for richer command/path rule semantics */
  matchesPattern?: ToolPermissionMatcher;
}

export interface PermissionResult {
  action: PermissionAction;
  matchedRule?: string;
  reason?: string;
}

// ── Session-scoped memory ───────────────────────────────────

// Pattern-specific session memory from interactive approval choices.
const sessionAllowRules: PermissionRule[] = [];
const sessionDenyRules: PermissionRule[] = [];
// Custom rules
const customRules: PermissionRule[] = [];
// Built-in defaults
const defaultRules: PermissionRule[] = [
  // Safe read operations — always allow
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "ls", pattern: "*", action: "allow" },
  { permission: "search", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "git_status", pattern: "*", action: "allow" },
  { permission: "git_diff", pattern: "*", action: "allow" },
  { permission: "git_log", pattern: "*", action: "allow" },
  { permission: "git_branch", pattern: "*", action: "allow" },
  { permission: "web_search", pattern: "*", action: "allow" },
  { permission: "web_fetch", pattern: "*", action: "allow" },
  { permission: "think", pattern: "*", action: "allow" },
  { permission: "get_goal", pattern: "*", action: "allow" },
  { permission: "plan_status", pattern: "*", action: "allow" },
  { permission: "agent_status", pattern: "*", action: "allow" },
  { permission: "checklist_write", pattern: "*", action: "allow" },
  { permission: "update_plan", pattern: "*", action: "allow" },
  { permission: "note", pattern: "*", action: "allow" },
  { permission: "rlm_query", pattern: "*", action: "allow" },
  { permission: "spawn_agent", pattern: "*", action: "allow" },
  { permission: "sub_agent", pattern: "*", action: "allow" },

  // Destructive — always deny
  { permission: "bash", pattern: "rm *-r*f* /*", action: "deny" },
  { permission: "bash", pattern: "rm *-f*r* /*", action: "deny" },
  { permission: "bash", pattern: "rm *--recursive*--force* /*", action: "deny" },
  { permission: "bash", pattern: "rm *--force*--recursive* /*", action: "deny" },
  { permission: "bash", pattern: "*> /dev/sd*", action: "deny" },
  { permission: "bash", pattern: "*> /dev/disk*", action: "deny" },
  { permission: "bash", pattern: "*> /dev/nvme*", action: "deny" },
  { permission: "bash", pattern: "mkfs.*", action: "deny" },
  { permission: "bash", pattern: "mkfs *", action: "deny" },
  { permission: "bash", pattern: "dd *if=/dev/*", action: "deny" },
  { permission: "bash", pattern: "dd *of=/dev/*", action: "deny" },
  { permission: "bash", pattern: "chmod 777 *", action: "deny" },
  { permission: "bash", pattern: "chmod 0777 *", action: "deny" },
  { permission: "bash", pattern: "chmod 7777 *", action: "deny" },
  { permission: "bash", pattern: "chmod a+rwx *", action: "deny" },
  { permission: "bash", pattern: "chmod ugo+rwx *", action: "deny" },
  { permission: "bash", pattern: ":(){ :|:& };:", action: "deny" },

  // Write operations — ask by default
  { permission: "write", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "ask" },
  { permission: "apply_patch", pattern: "*", action: "ask" },
  { permission: "bash", pattern: "*", action: "ask" },
];

// ── Matching ────────────────────────────────────────────────

function matchWildcard(pattern: string, value: string): boolean {
  const safePattern = normalizePatternText(pattern);
  const safeValue = normalizePatternText(value);
  if (!safePattern) return false;
  if (safePattern === "*") return true;
  if (!safeValue) return false;
  // Convert glob pattern to regex
  const regexStr = "^" + safePattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".") + "$";
  try {
    return new RegExp(regexStr, "i").test(safeValue);
  } catch {
    return safePattern === safeValue;
  }
}

function safeMatch(matcher: ToolPermissionMatcher | undefined, pattern: string): boolean {
  if (!matcher) return false;
  try {
    return matcher(pattern);
  } catch {
    return false;
  }
}

function matchRule(rule: PermissionRule, request: PermissionRequest): boolean {
  // Match tool name
  const rulePermission = normalizePermissionText(safeProperty(rule, "permission"));
  const requestToolName = normalizePermissionText(safeProperty(request, "toolName"));
  if (!matchWildcard(rulePermission, requestToolName)) return false;

  // Match pattern against args or patterns
  const rulePattern = normalizePatternText(safeProperty(rule, "pattern"));
  if (rulePattern === "*") return true;

  // Check specific patterns from the request
  const matchesPattern = safeProperty(request, "matchesPattern");
  if (safeMatch(typeof matchesPattern === "function" ? matchesPattern as ToolPermissionMatcher : undefined, rulePattern)) return true;

  const requestPatterns = safeArrayItems(safeProperty(request, "patterns"), MAX_PERMISSION_PATTERNS)
    .filter((pattern): pattern is string => typeof pattern === "string");
  if (requestPatterns.length) {
    return requestPatterns.some(p => matchWildcard(rulePattern, p));
  }

  // Check args for pattern match
  const toolArgs = safeProperty(request, "toolArgs");
  if (isPlainRecord(toolArgs)) {
    const argsStr = safeObjectValues(toolArgs, MAX_ARGS_VALUES)
      .filter(value => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      .map(value => normalizePatternText(stringFromUnknown(value)))
      .filter(Boolean)
      .join(" ");
    return argsStr ? matchWildcard(rulePattern, argsStr) : false;
  }

  return false;
}

// ── Main API ────────────────────────────────────────────────

export function checkPermission(request: PermissionRequest): PermissionResult {
  const normalizedRequest = normalizePermissionRequest(request);
  if (!normalizedRequest) return { action: "ask", reason: "Invalid permission request" };

  for (const rule of builtInDenyRules()) {
    if (matchRule(rule, normalizedRequest)) {
      return { action: "deny", matchedRule: `${rule.permission}:${rule.pattern}`, reason: "Built-in deny rule matched" };
    }
  }

  // Check session-specific memory first. Deny wins on exact conflicts.
  for (const rule of sessionDenyRules) {
    if (matchRule(rule, normalizedRequest)) {
      return { action: "deny", matchedRule: formatPermissionRule(rule), reason: "Denied for this session" };
    }
  }

  for (const rule of sessionAllowRules) {
    if (matchRule(rule, normalizedRequest)) {
      return { action: "allow", matchedRule: formatPermissionRule(rule), reason: "Allowed for this session" };
    }
  }

  // Check custom rules (highest priority)
  for (const rule of customRules) {
    if (matchRule(rule, normalizedRequest)) {
      return { action: rule.action, matchedRule: `${rule.permission}:${rule.pattern}`, reason: "Custom rule matched" };
    }
  }

  // Check default rules
  for (const rule of defaultRules) {
    if (rule.action === "deny") continue;
    if (matchRule(rule, normalizedRequest)) {
      return { action: rule.action, matchedRule: `${rule.permission}:${rule.pattern}`, reason: "Default rule matched" };
    }
  }

  // Default: ask
  return { action: "ask", reason: "No matching rule" };
}

export function addRule(rule: PermissionRule): void {
  const normalized = normalizePermissionRule(rule);
  if (!normalized) return;
  // Deduplicate
  const idx = customRules.findIndex(
    r => r.permission === normalized.permission && r.pattern === normalized.pattern,
  );
  if (idx >= 0) {
    customRules[idx] = normalized;
  } else {
    if (customRules.length >= MAX_PERMISSION_RULES) customRules.shift();
    customRules.push(normalized);
  }
}

export function removeRule(permission: string, pattern: string): boolean {
  const normalizedPermission = normalizePermissionText(permission);
  const normalizedPattern = normalizePatternText(pattern);
  if (!normalizedPermission || !normalizedPattern) return false;
  const idx = customRules.findIndex(
    r => r.permission === normalizedPermission && r.pattern === normalizedPattern,
  );
  if (idx >= 0) {
    customRules.splice(idx, 1);
    return true;
  }
  return false;
}

export function getAllRules(): PermissionRule[] {
  return [...defaultRules, ...customRules];
}

function builtInDenyRules(): PermissionRule[] {
  return defaultRules.filter(rule => rule.action === "deny");
}

// ── Session memory ──────────────────────────────────────────

export type PermissionPatternInput = string | string[] | Record<string, unknown> | undefined;

export function rememberAlwaysAllow(toolName: string, input?: PermissionPatternInput): void {
  rememberSessionRules(sessionAllowRules, sessionDenyRules, toolName, input, "allow");
}

export function rememberAlwaysDeny(toolName: string, input?: PermissionPatternInput): void {
  rememberSessionRules(sessionDenyRules, sessionAllowRules, toolName, input, "deny");
}

export function forgetTool(toolName: string, input?: PermissionPatternInput): void {
  const permission = normalizePermissionText(toolName);
  if (!permission) return;
  if (input === undefined) {
    removeSessionRules(sessionAllowRules, permission, null);
    removeSessionRules(sessionDenyRules, permission, null);
    return;
  }
  const patterns = normalizePermissionPatterns(input, { fallbackWildcard: false });
  if (!patterns.length) return;
  removeSessionRules(sessionAllowRules, permission, patterns);
  removeSessionRules(sessionDenyRules, permission, patterns);
}

export function isAlwaysAllowed(toolName: string, input?: PermissionPatternInput): boolean {
  return sessionRulesMatch(sessionAllowRules, toolName, input);
}

export function isAlwaysDenied(toolName: string, input?: PermissionPatternInput): boolean {
  return sessionRulesMatch(sessionDenyRules, toolName, input);
}

export function getSessionMemory(): { allow: string[]; deny: string[] } {
  return {
    allow: sessionAllowRules.map(clonePermissionRule).map(formatPermissionRule),
    deny: sessionDenyRules.map(clonePermissionRule).map(formatPermissionRule),
  };
}

export function clearSessionMemory(): void {
  sessionAllowRules.length = 0;
  sessionDenyRules.length = 0;
}

export function clearAll(): void {
  sessionAllowRules.length = 0;
  sessionDenyRules.length = 0;
  customRules.length = 0;
}

export function permissionPatternsFromArgs(args?: Record<string, unknown>, toolDef?: ToolDef): string[] {
  if (!isPlainRecord(args)) return [];
  const toolPatterns = getToolPermissionPatterns(toolDef, args).map(normalizePatternText).filter(Boolean);
  if (toolPatterns.length) return uniqueLimited(toolPatterns, MAX_PERMISSION_PATTERNS);
  const patterns: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = normalizePatternText(value);
    if (trimmed && !patterns.includes(trimmed) && patterns.length < MAX_PERMISSION_PATTERNS) patterns.push(trimmed);
  };

  for (const key of ["command", "cmd", "script"]) add(safeProperty(args, key));
  for (const key of ["path", "file", "file_path", "filepath", "filename", "target_file", "target_path", "output_path", "worktree_path"]) {
    add(safeProperty(args, key));
  }
  add(safeProperty(args, "pattern"));
  const patch = safeProperty(args, "patch");
  if (typeof patch === "string") {
    for (const path of extractPatchPaths(patch)) add(path);
  }
  if (patterns.length) return patterns;

  for (const value of safeObjectValues(args, MAX_ARGS_VALUES)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      add(stringFromUnknown(value));
    }
  }
  return patterns;
}

function rememberSessionRules(
  target: PermissionRule[],
  opposite: PermissionRule[],
  toolName: string,
  input: PermissionPatternInput,
  action: PermissionAction,
): void {
  const permission = normalizePermissionText(toolName);
  if (!permission) return;
  const patterns = normalizePermissionPatterns(input, { fallbackWildcard: input === undefined });
  if (!patterns.length) return;
  for (const pattern of patterns) {
    upsertSessionRule(target, { permission, pattern, action });
    removeSessionRules(opposite, permission, [pattern]);
  }
}

function upsertSessionRule(rules: PermissionRule[], rule: PermissionRule): void {
  const idx = rules.findIndex(item => item.permission === rule.permission && item.pattern === rule.pattern);
  if (idx >= 0) rules[idx] = rule;
  else {
    if (rules.length >= MAX_SESSION_RULES) rules.shift();
    rules.push(rule);
  }
}

function removeSessionRules(rules: PermissionRule[], toolName: string, patterns: string[] | null): void {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (rule.permission !== toolName) continue;
    if (patterns && !patterns.includes(rule.pattern)) continue;
    rules.splice(i, 1);
  }
}

function sessionRulesMatch(rules: PermissionRule[], toolName: string, input?: PermissionPatternInput): boolean {
  const permission = normalizePermissionText(toolName);
  if (!permission) return false;
  if (input === undefined) {
    return rules.some(rule => rule.permission === permission && rule.pattern === "*");
  }
  const request = {
    toolName: permission,
    patterns: normalizePermissionPatterns(input, { fallbackWildcard: false }),
  };
  if (!request.patterns.length) return false;
  return rules.some(rule => matchRule(rule, typeof input === "object" && !Array.isArray(input)
    ? { ...request, toolArgs: input }
    : request));
}

function normalizePermissionPatterns(input: PermissionPatternInput, options: { fallbackWildcard: boolean }): string[] {
  if (input === undefined) return options.fallbackWildcard ? ["*"] : [];
  const rawPatterns = typeof input === "string"
    ? [input]
    : Array.isArray(input)
      ? safeArrayItems(input, MAX_PERMISSION_PATTERNS)
      : isPlainRecord(input) ? permissionPatternsFromArgs(input) : [];
  const patterns = uniqueLimited(rawPatterns.map(normalizePatternText).filter((pattern): pattern is string => !!pattern), MAX_PERMISSION_PATTERNS);
  return patterns.length ? patterns : options.fallbackWildcard ? ["*"] : [];
}

function normalizePermissionRule(rule: PermissionRule): PermissionRule | null {
  const permission = normalizePermissionText(safeProperty(rule, "permission"));
  const pattern = normalizePatternText(safeProperty(rule, "pattern"));
  const action = safeProperty(rule, "action");
  if (!permission || !pattern || typeof action !== "string" || !["allow", "deny", "ask"].includes(action)) return null;
  return { permission, pattern, action: action as PermissionAction };
}

function normalizePermissionRequest(request: PermissionRequest): PermissionRequest | null {
  if (!request || typeof request !== "object") return null;
  const toolName = normalizePermissionText(safeProperty(request, "toolName"));
  if (!toolName) return null;
  const rawPatterns = safeProperty(request, "patterns");
  const patterns = Array.isArray(rawPatterns)
    ? uniqueLimited(safeArrayItems(rawPatterns, MAX_PERMISSION_PATTERNS).map(normalizePatternText).filter(Boolean), MAX_PERMISSION_PATTERNS)
    : undefined;
  const rawToolArgs = safeProperty(request, "toolArgs");
  const toolArgs = isPlainRecord(rawToolArgs) ? rawToolArgs : undefined;
  const rawMatchesPattern = safeProperty(request, "matchesPattern");
  const matchesPattern = typeof rawMatchesPattern === "function" ? rawMatchesPattern as ToolPermissionMatcher : undefined;
  const normalized: PermissionRequest = { toolName };
  if (toolArgs) normalized.toolArgs = toolArgs;
  if (patterns) normalized.patterns = patterns;
  if (matchesPattern) normalized.matchesPattern = matchesPattern;
  return normalized;
}

function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/).slice(0, MAX_PATCH_LINES)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match?.[1]) {
      const path = normalizePatternText(match[1]);
      if (path && !paths.includes(path) && paths.length < MAX_PERMISSION_PATTERNS) paths.push(path);
    }
  }
  return paths;
}

function formatPermissionRule(rule: PermissionRule): string {
  if (rule.pattern === "*") return rule.permission;
  return `${rule.permission}(${escapeRuleContent(rule.pattern)})`;
}

function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function normalizePermissionText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(PERMISSION_CONTROL_RE, " ").trim().split(/\s+/)[0] || "";
  return normalized.length <= MAX_PERMISSION_TEXT_CHARS ? normalized : "";
}

function normalizePatternText(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(PERMISSION_CONTROL_RE, " ").trim();
  return normalized ? safeSliceTextBoundary(normalized, MAX_PATTERN_TEXT_CHARS) : "";
}

function uniqueLimited(values: string[], limit: number): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (result.length >= limit) break;
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

function clonePermissionRule(rule: PermissionRule): PermissionRule {
  return {
    permission: normalizePermissionText(safeProperty(rule, "permission")),
    pattern: normalizePatternText(safeProperty(rule, "pattern")),
    action: safeProperty(rule, "action") === "allow" || safeProperty(rule, "action") === "deny" ? safeProperty(rule, "action") as PermissionAction : "ask",
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeObjectValues(value: unknown, maxValues: number): unknown[] {
  if (!isPlainRecord(value)) return [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const values: unknown[] = [];
  for (const key of keys.slice(0, Math.max(0, Math.floor(maxValues)))) {
    try {
      values.push(value[key]);
    } catch {
      continue;
    }
  }
  return values;
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

function safeProperty(source: unknown, key: string | number | symbol): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string | number | symbol, unknown>)[key];
  } catch {
    return undefined;
  }
}

function stringFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "";
  }
}
