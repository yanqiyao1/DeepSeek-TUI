/** Base tool definitions. */

import { toJsonSafe } from "../utils/json-safe.js";

const MAX_TOOL_METADATA_CHARS = 2_000;
const MAX_TRANSCRIPT_SEARCH_CHARS = 20_000;
const MAX_PERMISSION_PATTERN_CHARS = 1_000;
const MAX_PERMISSION_PATTERNS = 64;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TOOL_SCHEMA_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_RESULT_KIND_VALUES = new Set(["text", "json", "diff", "artifact", "diagnostic", "task"]);

export enum PermissionLevel {
  ALWAYS_ALLOW = "always_allow",
  ASK = "ask",
  DENY_IN_PLAN = "deny_in_plan",
  DANGEROUS = "dangerous",
}

export type ToolCapabilityPredicate = (args: Record<string, unknown>) => boolean;
export type ToolCapability = boolean | ToolCapabilityPredicate;
export type ToolPermissionDecision = "allow" | "ask" | "deny";

export interface ToolPermissionResult {
  decision: ToolPermissionDecision;
  reason?: string;
  description?: string;
}

export interface ToolPermissionCallbacks {
  requestApproval?(toolName: string, args: Record<string, unknown>, description: string): Promise<boolean>;
}

export interface ToolValidationContext {
  tool_name: string;
  workspace_path: string;
  tool_def: ToolDef;
}

export interface ToolValidationResult {
  ok: boolean;
  message?: string;
  args?: Record<string, unknown>;
}

export interface ToolProgress {
  message: string;
  percent?: number;
  data?: Record<string, unknown>;
}

export type ToolResultKind = "text" | "json" | "diff" | "artifact" | "diagnostic" | "task";
export type ToolInterruptBehavior = "cancel" | "block";
export type ToolPermissionMatcher = (pattern: string) => boolean;

export interface ToolRenderedResult {
  kind?: ToolResultKind;
  title?: string;
  preview?: string;
  detail?: string;
}

export interface ToolRenderMetadata {
  userFacingName?: string;
  icon?: string;
  accent?: string;
  resultKind?: ToolResultKind;
  transparent?: boolean;
}

export interface ToolUseRuntimeMetadata {
  activity?: string;
  summary?: string;
  classifierInput?: unknown;
  transcriptSearchText?: string;
  render?: ToolRenderMetadata;
}

export interface ToolRenderContext {
  tool: ToolDef;
  args: Record<string, unknown>;
  workspace_path: string;
}

export interface ToolSearchOrReadInfo {
  isSearch: boolean;
  isRead: boolean;
  isList?: boolean;
}

export interface ToolDef {
  name: string;
  aliases?: string[];
  description: string;
  searchHint?: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<string>;
  permission: PermissionLevel;
  checkPermissions?: (
    ctx: ApprovalContext,
    callbacks?: ToolPermissionCallbacks,
  ) => Promise<ToolPermissionResult> | ToolPermissionResult;
  validateInput?: (
    args: Record<string, unknown>,
    context: ToolValidationContext,
  ) => Promise<ToolValidationResult> | ToolValidationResult;
  category: string;
  parallelOk: boolean;
  concurrencySafe?: ToolCapability;
  readOnly?: ToolCapability;
  destructive?: ToolCapability;
  maxResultSizeChars?: number;
  resultKind?: ToolResultKind;
  renderProgress?: (progress: ToolProgress, args: Record<string, unknown>) => ToolRenderedResult;
  renderResult?: (result: string, args: Record<string, unknown>) => ToolRenderedResult;
  renderGroup?: (args: Record<string, unknown>) => string | undefined;
  isSearchOrReadCommand?: (args: Record<string, unknown>) => ToolSearchOrReadInfo;
  getPermissionPatterns?: (args: Record<string, unknown>) => string[];
  preparePermissionMatcher?: (args: Record<string, unknown>) => ToolPermissionMatcher | Promise<ToolPermissionMatcher>;
  toAutoClassifierInput?: (args: Record<string, unknown>) => unknown;
  getTranscriptSearchText?: (result: string, args: Record<string, unknown>) => string;
  getToolUseSummary?: (args: Record<string, unknown>) => string | null;
  getActivityDescription?: (args: Record<string, unknown>) => string | null;
  renderMetadata?: ToolRenderMetadata | ((args: Record<string, unknown>) => ToolRenderMetadata | undefined);
  interruptBehavior?: ToolInterruptBehavior | ((args: Record<string, unknown>) => ToolInterruptBehavior);
  deferLoading?: boolean;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  toolCallId?: string;
  sessionId?: string;
  workspacePath?: string;
  onProgress?: (progress: ToolProgress) => void | Promise<void>;
}

export function toolToOpenAISchema(tool: ToolDef): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: normalizeToolSchemaName(tool.name),
      description: normalizeMetadataText(tool.description, MAX_TOOL_METADATA_CHARS),
      parameters: normalizeToolParameters(tool.parameters),
    },
  };
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  is_error: boolean;
}

export interface ApprovalContext {
  tool_name: string;
  tool_args: Record<string, unknown>;
  tool_def: ToolDef;
  workspace_path: string;
}

export async function validateToolInput(
  tool: ToolDef,
  args: Record<string, unknown>,
  context: Omit<ToolValidationContext, "tool_def">,
): Promise<ToolValidationResult> {
  if (!tool.validateInput) return { ok: true, args };
  const result = await safelyAsync(() => tool.validateInput!(args, { ...context, tool_def: tool }));
  if (!isRecord(result)) return validationFailure("tool validation failed");
  if (result.ok !== true) return normalizeValidationFailure(result);
  const normalizedArgs = normalizeValidationArgs(result.args, args);
  const normalized: ToolValidationResult = { ok: true, args: normalizedArgs };
  const message = normalizeOptionalMetadataText(result.message, MAX_TOOL_METADATA_CHARS);
  if (message) normalized.message = message;
  return normalized;
}

export async function resolveToolPermission(
  ctx: ApprovalContext,
  callbacks?: ToolPermissionCallbacks,
): Promise<ToolPermissionResult> {
  if (ctx.tool_def.checkPermissions) {
    const result = await safelyAsync(() => ctx.tool_def.checkPermissions!(ctx, callbacks));
    return normalizePermissionResult(result, permissionCheckFailure(ctx.tool_def));
  }
  return defaultPermissionResult(ctx.tool_def);
}

export function isToolReadOnly(tool: ToolDef, args: Record<string, unknown> = {}): boolean {
  return resolveCapability(tool.readOnly, args, false);
}

export function isToolDestructive(tool: ToolDef, args: Record<string, unknown> = {}): boolean {
  return resolveCapability(tool.destructive, args, false);
}

export function isToolConcurrencySafe(tool: ToolDef, args: Record<string, unknown> = {}): boolean {
  return resolveCapability(tool.concurrencySafe, args, tool.parallelOk);
}

export function isToolStaticallyReadOnly(tool: ToolDef): boolean {
  return tool.readOnly === true;
}

export function isToolStaticallyDestructive(tool: ToolDef): boolean {
  return tool.destructive === true;
}

export function isToolStaticallyConcurrencySafe(tool: ToolDef): boolean {
  return tool.concurrencySafe === true;
}

export function getToolRenderMetadata(tool: ToolDef, args: Record<string, unknown> = {}): ToolRenderMetadata | undefined {
  const metadata = safely(() => typeof tool.renderMetadata === "function"
    ? tool.renderMetadata(args)
    : tool.renderMetadata);
  return normalizeRenderMetadata(metadata, tool.resultKind);
}

export function getToolUseRuntimeMetadata(
  tool: ToolDef,
  args: Record<string, unknown> = {},
  result?: string,
): ToolUseRuntimeMetadata | undefined {
  const metadata: ToolUseRuntimeMetadata = {};
  const activity = normalizeOptionalMetadataText(
    safely(() => tool.getActivityDescription?.(args) || undefined),
    MAX_TOOL_METADATA_CHARS,
  );
  const summary = normalizeOptionalMetadataText(
    safely(() => tool.getToolUseSummary?.(args) || undefined),
    MAX_TOOL_METADATA_CHARS,
  );
  const classifierInput = safely(() => tool.toAutoClassifierInput?.(args));
  const safeClassifierInput = classifierInput === undefined
    ? undefined
    : toJsonSafe(classifierInput, { dropUndefinedObjectFields: true });
  const transcriptSearchText = result === undefined
    ? undefined
    : normalizeOptionalMetadataText(
      safely(() => tool.getTranscriptSearchText?.(result, args) || undefined),
      MAX_TRANSCRIPT_SEARCH_CHARS,
    );
  const render = getToolRenderMetadata(tool, args);

  if (activity) metadata.activity = activity;
  if (summary) metadata.summary = summary;
  if (safeClassifierInput !== undefined) metadata.classifierInput = safeClassifierInput;
  if (transcriptSearchText) metadata.transcriptSearchText = transcriptSearchText;
  if (render) metadata.render = render;

  return Object.keys(metadata).length ? metadata : undefined;
}

export function getToolPermissionPatterns(tool: ToolDef | undefined, args: Record<string, unknown>): string[] {
  return normalizeStringList(safely(() => tool?.getPermissionPatterns?.(args)));
}

export async function prepareToolPermissionMatcher(
  tool: ToolDef | undefined,
  args: Record<string, unknown>,
): Promise<ToolPermissionMatcher | undefined> {
  if (!tool?.preparePermissionMatcher) return undefined;
  const matcher = await safelyAsync(() => tool.preparePermissionMatcher!(args));
  return typeof matcher === "function" ? matcher : undefined;
}

function resolveCapability(
  value: ToolCapability | undefined,
  args: Record<string, unknown>,
  fallback: boolean,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "function") {
    try {
      const resolved = value(args);
      return typeof resolved === "boolean" ? resolved : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const patterns: string[] = [];
  for (const value of values) {
    if (patterns.length >= MAX_PERMISSION_PATTERNS) break;
    if (typeof value !== "string") continue;
    const pattern = normalizeMetadataText(value, MAX_PERMISSION_PATTERN_CHARS);
    if (pattern && !patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

function normalizeToolParameters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", properties: {} };
  }
  const safe = toJsonSafe(value, { dropUndefinedObjectFields: true });
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? safe as Record<string, unknown>
    : { type: "object", properties: {} };
}

function normalizeValidationFailure(result: ToolValidationResult): ToolValidationResult {
  const message = normalizeOptionalMetadataText(result.message, MAX_TOOL_METADATA_CHARS);
  return message ? { ok: false, message } : { ok: false };
}

function validationFailure(message: string): ToolValidationResult {
  return { ok: false, message };
}

function normalizeValidationArgs(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value)) return fallback;
  const safe = toJsonSafe(value, { dropUndefinedObjectFields: true });
  return isRecord(safe) ? safe : fallback;
}

function defaultPermissionResult(tool: ToolDef): ToolPermissionResult {
  if (tool.permission === PermissionLevel.ALWAYS_ALLOW) return { decision: "allow" };
  if (tool.permission === PermissionLevel.DANGEROUS) return { decision: "ask", reason: "dangerous tool" };
  if (tool.permission === PermissionLevel.ASK) return { decision: "ask" };
  return { decision: "deny", reason: "tool is not permitted in this mode" };
}

function permissionCheckFailure(tool: ToolDef): ToolPermissionResult {
  const fallback = defaultPermissionResult(tool);
  if (fallback.decision === "allow") return { decision: "ask", reason: "permission check failed" };
  return fallback;
}

function normalizePermissionResult(value: unknown, fallback: ToolPermissionResult): ToolPermissionResult {
  if (!isRecord(value)) return fallback;
  const decision = value.decision;
  if (decision !== "allow" && decision !== "ask" && decision !== "deny") return fallback;
  const result: ToolPermissionResult = { decision };
  const reason = normalizeOptionalMetadataText(value.reason, MAX_TOOL_METADATA_CHARS);
  const description = normalizeOptionalMetadataText(value.description, MAX_TOOL_METADATA_CHARS);
  if (reason) result.reason = reason;
  if (description) result.description = description;
  return result;
}

function normalizeRenderMetadata(value: unknown, fallbackKind: ToolResultKind | undefined): ToolRenderMetadata | undefined {
  const safe = isRecord(value)
    ? toJsonSafe(value, { dropUndefinedObjectFields: true })
    : undefined;
  const source = isRecord(safe) ? safe : undefined;
  const result: ToolRenderMetadata = {};
  const userFacingName = normalizeOptionalMetadataText(source?.userFacingName, MAX_TOOL_METADATA_CHARS);
  const icon = normalizeOptionalMetadataText(source?.icon, 100);
  const accent = normalizeOptionalMetadataText(source?.accent, 100);
  if (userFacingName) result.userFacingName = userFacingName;
  if (icon) result.icon = icon;
  if (accent) result.accent = accent;
  if (typeof source?.transparent === "boolean") result.transparent = source.transparent;
  const resultKind = normalizeToolResultKind(source?.resultKind) ?? normalizeToolResultKind(fallbackKind);
  if (resultKind) result.resultKind = resultKind;
  return Object.keys(result).length ? result : undefined;
}

function normalizeToolResultKind(value: unknown): ToolResultKind | undefined {
  return typeof value === "string" && TOOL_RESULT_KIND_VALUES.has(value)
    ? value as ToolResultKind
    : undefined;
}

function normalizeToolSchemaName(value: unknown): string {
  if (typeof value !== "string") return "tool";
  const normalized = normalizeMetadataText(value, 64);
  return TOOL_SCHEMA_NAME_RE.test(normalized) ? normalized : "tool";
}

function normalizeOptionalMetadataText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeMetadataText(value, maxChars);
  return normalized || undefined;
}

function normalizeMetadataText(value: string, maxChars: number): string {
  return value.replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safely<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

async function safelyAsync<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
