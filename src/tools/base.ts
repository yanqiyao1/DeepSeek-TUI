/** Base tool definitions. */

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
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
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
  const result = await tool.validateInput(args, { ...context, tool_def: tool });
  return result.ok ? { ...result, args: result.args || args } : result;
}

export async function resolveToolPermission(
  ctx: ApprovalContext,
  callbacks?: ToolPermissionCallbacks,
): Promise<ToolPermissionResult> {
  if (ctx.tool_def.checkPermissions) return ctx.tool_def.checkPermissions(ctx, callbacks);
  if (ctx.tool_def.permission === PermissionLevel.ALWAYS_ALLOW) return { decision: "allow" };
  if (ctx.tool_def.permission === PermissionLevel.DANGEROUS) return { decision: "ask", reason: "dangerous tool" };
  if (ctx.tool_def.permission === PermissionLevel.ASK) return { decision: "ask" };
  return { decision: "deny", reason: "tool is not permitted in this mode" };
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
  if (metadata) {
    const result = { ...metadata };
    const resultKind = metadata.resultKind ?? tool.resultKind;
    if (resultKind !== undefined) result.resultKind = resultKind;
    return result;
  }
  if (!tool.resultKind) return undefined;
  return { resultKind: tool.resultKind };
}

export function getToolUseRuntimeMetadata(
  tool: ToolDef,
  args: Record<string, unknown> = {},
  result?: string,
): ToolUseRuntimeMetadata | undefined {
  const metadata: ToolUseRuntimeMetadata = {};
  const activity = safely(() => tool.getActivityDescription?.(args) || undefined);
  const summary = safely(() => tool.getToolUseSummary?.(args) || undefined);
  const classifierInput = safely(() => tool.toAutoClassifierInput?.(args));
  const transcriptSearchText = result === undefined
    ? undefined
    : safely(() => tool.getTranscriptSearchText?.(result, args) || undefined);
  const render = getToolRenderMetadata(tool, args);

  if (activity) metadata.activity = activity;
  if (summary) metadata.summary = summary;
  if (classifierInput !== undefined) metadata.classifierInput = classifierInput;
  if (transcriptSearchText) metadata.transcriptSearchText = transcriptSearchText;
  if (render) metadata.render = render;

  return Object.keys(metadata).length ? metadata : undefined;
}

export function getToolPermissionPatterns(tool: ToolDef | undefined, args: Record<string, unknown>): string[] {
  return normalizeStringList(safely(() => tool?.getPermissionPatterns?.(args)) || []);
}

export async function prepareToolPermissionMatcher(
  tool: ToolDef | undefined,
  args: Record<string, unknown>,
): Promise<ToolPermissionMatcher | undefined> {
  if (!tool?.preparePermissionMatcher) return undefined;
  return safelyAsync(() => tool.preparePermissionMatcher!(args));
}

function resolveCapability(
  value: ToolCapability | undefined,
  args: Record<string, unknown>,
  fallback: boolean,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "function") {
    try { return value(args); } catch { return fallback; }
  }
  return fallback;
}

function normalizeStringList(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string").map(value => value.trim()).filter(Boolean))];
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
