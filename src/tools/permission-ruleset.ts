/** Permission ruleset system — pattern-matching allow/deny/ask with wildcards.
 *
 * Adopted from OpenCode: replaces simple approval cache with a ruleset-based
 * system supporting tool-name patterns, wildcards, "always" arrays for
 * remembered decisions, and session-scoped persistence.
 */

import { getToolPermissionPatterns, type ToolDef, type ToolPermissionMatcher } from "./base.js";

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
  // Convert glob pattern to regex
  const regexStr = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".") + "$";
  try {
    return new RegExp(regexStr, "i").test(value);
  } catch {
    return pattern === value;
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
  if (!matchWildcard(rule.permission, request.toolName)) return false;

  // Match pattern against args or patterns
  if (rule.pattern === "*") return true;

  // Check specific patterns from the request
  if (safeMatch(request.matchesPattern, rule.pattern)) return true;

  if (request.patterns?.length) {
    return request.patterns.some(p => matchWildcard(rule.pattern, p));
  }

  // Check args for pattern match
  if (request.toolArgs) {
    const argsStr = Object.values(request.toolArgs).join(" ");
    return matchWildcard(rule.pattern, argsStr);
  }

  return false;
}

// ── Main API ────────────────────────────────────────────────

export function checkPermission(request: PermissionRequest): PermissionResult {
  for (const rule of builtInDenyRules()) {
    if (matchRule(rule, request)) {
      return { action: "deny", matchedRule: `${rule.permission}:${rule.pattern}`, reason: "Built-in deny rule matched" };
    }
  }

  // Check session-specific memory first. Deny wins on exact conflicts.
  for (const rule of sessionDenyRules) {
    if (matchRule(rule, request)) {
      return { action: "deny", matchedRule: formatPermissionRule(rule), reason: "Denied for this session" };
    }
  }

  for (const rule of sessionAllowRules) {
    if (matchRule(rule, request)) {
      return { action: "allow", matchedRule: formatPermissionRule(rule), reason: "Allowed for this session" };
    }
  }

  // Check custom rules (highest priority)
  for (const rule of customRules) {
    if (matchRule(rule, request)) {
      return { action: rule.action, matchedRule: `${rule.permission}:${rule.pattern}`, reason: "Custom rule matched" };
    }
  }

  // Check default rules
  for (const rule of defaultRules) {
    if (rule.action === "deny") continue;
    if (matchRule(rule, request)) {
      return { action: rule.action, matchedRule: `${rule.permission}:${rule.pattern}`, reason: "Default rule matched" };
    }
  }

  // Default: ask
  return { action: "ask", reason: "No matching rule" };
}

export function addRule(rule: PermissionRule): void {
  // Deduplicate
  const idx = customRules.findIndex(
    r => r.permission === rule.permission && r.pattern === rule.pattern,
  );
  if (idx >= 0) {
    customRules[idx] = rule;
  } else {
    customRules.push(rule);
  }
}

export function removeRule(permission: string, pattern: string): boolean {
  const idx = customRules.findIndex(
    r => r.permission === permission && r.pattern === pattern,
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
  const patterns = input === undefined ? null : normalizePermissionPatterns(input);
  removeSessionRules(sessionAllowRules, toolName, patterns);
  removeSessionRules(sessionDenyRules, toolName, patterns);
}

export function isAlwaysAllowed(toolName: string, input?: PermissionPatternInput): boolean {
  return sessionRulesMatch(sessionAllowRules, toolName, input);
}

export function isAlwaysDenied(toolName: string, input?: PermissionPatternInput): boolean {
  return sessionRulesMatch(sessionDenyRules, toolName, input);
}

export function getSessionMemory(): { allow: string[]; deny: string[] } {
  return {
    allow: sessionAllowRules.map(formatPermissionRule),
    deny: sessionDenyRules.map(formatPermissionRule),
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
  if (!args) return [];
  const toolPatterns = getToolPermissionPatterns(toolDef, args);
  if (toolPatterns.length) return toolPatterns;
  const patterns: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !patterns.includes(trimmed)) patterns.push(trimmed);
  };

  for (const key of ["command", "cmd", "script"]) add(args[key]);
  for (const key of ["path", "file", "file_path", "filepath", "filename", "target_file", "target_path", "output_path", "worktree_path"]) {
    add(args[key]);
  }
  add(args.pattern);
  if (typeof args.patch === "string") {
    for (const path of extractPatchPaths(args.patch)) add(path);
  }
  if (patterns.length) return patterns;

  for (const value of Object.values(args)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      add(String(value));
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
  for (const pattern of normalizePermissionPatterns(input)) {
    upsertSessionRule(target, { permission: toolName, pattern, action });
    removeSessionRules(opposite, toolName, [pattern]);
  }
}

function upsertSessionRule(rules: PermissionRule[], rule: PermissionRule): void {
  const idx = rules.findIndex(item => item.permission === rule.permission && item.pattern === rule.pattern);
  if (idx >= 0) rules[idx] = rule;
  else rules.push(rule);
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
  if (input === undefined) {
    return rules.some(rule => rule.permission === toolName && rule.pattern === "*");
  }
  const request = {
    toolName,
    patterns: normalizePermissionPatterns(input),
  };
  return rules.some(rule => matchRule(rule, typeof input === "object" && !Array.isArray(input)
    ? { ...request, toolArgs: input }
    : request));
}

function normalizePermissionPatterns(input: PermissionPatternInput): string[] {
  if (input === undefined) return ["*"];
  const rawPatterns = typeof input === "string"
    ? [input]
    : Array.isArray(input)
      ? input
      : permissionPatternsFromArgs(input);
  const patterns = rawPatterns.map(pattern => pattern.trim()).filter(Boolean);
  return patterns.length ? [...new Set(patterns)] : ["*"];
}

function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match?.[1]) paths.push(match[1].trim());
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
