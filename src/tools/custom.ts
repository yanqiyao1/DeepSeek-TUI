/** Workspace-local custom tool loading from .seekcode/tools. */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import vm from "node:vm";
import { PermissionLevel, type ToolDef, type ToolResultKind, type ToolValidationResult } from "./base.js";
import { getRegistry } from "./registry.js";
import { safeJsonStringify } from "../utils/json-safe.js";

interface LoadedCustomTool {
  name: string;
  requested_name: string;
  file: string;
}

interface CustomToolLoadError {
  file: string;
  error: string;
}

const CUSTOM_TOOL_EXTENSIONS = new Set([".js", ".cjs", ".ts"]);
const MAX_CUSTOM_TOOL_FILES = 50;
const MAX_CUSTOM_TOOL_FILE_BYTES = 256 * 1024;
const MAX_CUSTOM_TOOL_DEFINITIONS = 100;
const MAX_CUSTOM_TOOL_LOAD_ERRORS = 100;
const CUSTOM_TOOL_LOAD_TIMEOUT_MS = 1000;
const MAX_CUSTOM_TEXT_CHARS = 2_000;
const MAX_CUSTOM_RESULT_CHARS = 200_000;
const MAX_CUSTOM_RESULT_SIZE_CHARS = 120_000;
const MAX_CUSTOM_SCHEMA_CHARS = 64_000;
const MAX_CUSTOM_ALIASES = 32;
const MAX_CUSTOM_JSON_DEPTH = 8;
const MAX_CUSTOM_JSON_KEYS = 256;
const MAX_CUSTOM_JSON_ARRAY_ITEMS = 256;
const MAX_CUSTOM_JSON_NODES = 5_000;
const MAX_CUSTOM_JSON_STRING_CHARS = 80_000;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CUSTOM_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
let loadedTools: LoadedCustomTool[] = [];
let loadErrors: CustomToolLoadError[] = [];

export function registerCustomTools(workspacePath = process.cwd()): void {
  loadedTools = [];
  loadErrors = [];
  registerCustomToolsListTool(workspacePath);

  const root = resolve(workspacePath || ".");
  const toolsDir = join(root, ".seekcode", "tools");
  if (!existsSync(toolsDir)) return;
  try {
    if (!lstatSync(toolsDir).isDirectory()) {
      pushLoadError(safeRelativePath(root, toolsDir), ".seekcode/tools is not a regular directory");
      return;
    }
  } catch (error: any) {
    pushLoadError(safeRelativePath(root, toolsDir), errorText(error));
    return;
  }

  let files: string[] = [];
  try {
    files = listCustomToolFiles(toolsDir);
  } catch (error: any) {
    pushLoadError(safeRelativePath(root, toolsDir), errorText(error));
    return;
  }

  for (const file of files) {
    try {
      validateCustomToolFile(file);
      for (const candidate of collectToolCandidates(loadCustomToolModule(file), file)) {
        if (loadedTools.length >= MAX_CUSTOM_TOOL_DEFINITIONS) {
          pushLoadError(safeRelativePath(root, file), `custom tool limit reached (${MAX_CUSTOM_TOOL_DEFINITIONS})`);
          break;
        }
        registerCustomTool(candidate, file, root);
      }
    } catch (error: any) {
      pushLoadError(safeRelativePath(root, file), errorText(error));
    }
  }
}

function registerCustomToolsListTool(workspacePath: string): void {
  getRegistry().register({
    name: "custom_tools",
    description: "List workspace-local custom tools loaded from .seekcode/tools.",
    parameters: { type: "object", properties: {} },
    execute: async () => safeJsonStringify({
      workspace: resolve(workspacePath || "."),
      tools: loadedTools,
      errors: loadErrors,
    }, { space: 2 }),
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    readOnly: true,
  });
}

function loadCustomToolModule(file: string): unknown {
  const source = readFileSync(file, "utf-8");
  const transformed = transformCommonEsmExports(source);
  const module = { exports: {} as Record<string, unknown> };
  const localRequire = createRequire(file);
  const helper = (definition: Record<string, unknown>) => definition;
  const wrapped = `(function(exports, module, require, __filename, __dirname, tool) {\n${transformed}\n})`;
  const script = new vm.Script(
    `${wrapped}(module.exports, module, require, __filename, __dirname, tool);`,
    { filename: file },
  );
  script.runInNewContext({
    exports: module.exports,
    module,
    require: localRequire,
    __filename: file,
    __dirname: dirname(file),
    tool: helper,
  }, { timeout: CUSTOM_TOOL_LOAD_TIMEOUT_MS });
  return module.exports;
}

function transformCommonEsmExports(source: string): string {
  return source
    .replace(/\bexport\s+default\s+/g, "module.exports.default = ")
    .replace(/\bexport\s+const\s+tools\s*=/g, "module.exports.tools =")
    .replace(/\bexport\s+const\s+tool\s*=/g, "module.exports.tool =");
}

function collectToolCandidates(exportsValue: unknown, file: string): Array<Record<string, unknown>> {
  const record = exportsValue && typeof exportsValue === "object" && !Array.isArray(exportsValue)
    ? exportsValue as Record<string, unknown>
    : {};
  const raw = Array.isArray(exportsValue)
    ? exportsValue
    : Array.isArray(record.tools)
      ? record.tools
      : record.default !== undefined
        ? record.default
        : record.tool !== undefined
          ? record.tool
          : exportsValue;
  const candidates = Array.isArray(raw) ? raw.slice(0, MAX_CUSTOM_TOOL_DEFINITIONS) : [raw];
  return candidates.map(candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${basename(file)} must export a tool object or array of tool objects`);
    }
    return candidate as Record<string, unknown>;
  });
}

function registerCustomTool(definition: Record<string, unknown>, file: string, root: string): void {
  const requestedName = typeof definition.name === "string" ? text(definition.name, 128) : "";
  if (!requestedName) throw new Error(`${basename(file)} custom tool is missing name`);
  const name = resolveCustomToolName(requestedName, file);
  const customDescription = typeof definition.description === "string"
    ? text(definition.description, MAX_CUSTOM_TEXT_CHARS)
    : "";
  const description = customDescription || `Workspace custom tool from ${safeRelativePath(root, file)}`;
  const run = typeof definition.run === "function"
    ? definition.run
    : typeof definition.execute === "function" ? definition.execute : null;
  const validate = typeof definition.validate === "function" ? definition.validate : null;
  if (!run) throw new Error(`${requestedName} custom tool must define run(args) or execute(args)`);
  const destructive = definition.destructive === true;
  const readOnly = definition.readOnly === true && !destructive;
  const parallelOk = definition.parallelOk === undefined ? readOnly : definition.parallelOk === true && !destructive;

  const tool: ToolDef = {
    name,
    description,
    parameters: schemaObject(definition.parameters ?? definition.schema),
    execute: async (args, context) => {
      try {
        const result = await run(args, context);
        const output = typeof result === "string" ? result : safeJsonStringify(customJsonSafe(result), { space: 2 });
        return text(output, MAX_CUSTOM_RESULT_CHARS);
      } catch (error: any) {
        return `Error: custom tool '${name}' failed: ${errorText(error)}`;
      }
    },
    permission: parsePermission(definition.permission),
    category: typeof definition.category === "string" && definition.category.trim() ? text(definition.category, 100) : "custom",
    parallelOk,
    getPermissionPatterns: () => [name, safeRelativePath(root, file)],
    getActivityDescription: () => `Running custom tool ${name}`,
    getToolUseSummary: () => `Custom tool ${name}`,
    renderMetadata: { userFacingName: name, icon: "wrench", resultKind: parseResultKind(definition.resultKind) },
  };
  const aliases = stringArray(definition.aliases);
  if (aliases !== undefined) tool.aliases = aliases;
  if (typeof definition.searchHint === "string") tool.searchHint = text(definition.searchHint, MAX_CUSTOM_TEXT_CHARS);
  if (typeof definition.readOnly === "boolean" || destructive) tool.readOnly = readOnly;
  if (typeof definition.destructive === "boolean") tool.destructive = destructive;
  const maxResultSizeChars = finiteNumber(definition.maxResultSizeChars);
  if (maxResultSizeChars !== undefined) tool.maxResultSizeChars = maxResultSizeChars;
  tool.resultKind = parseResultKind(definition.resultKind);
  if (validate) {
    tool.validateInput = async (args, validationContext): Promise<ToolValidationResult> => {
      try {
        return normalizeValidationResult(await validate(args, validationContext), args);
      } catch (error: any) {
        return { ok: false, message: text(`custom tool validation failed: ${errorText(error)}`, MAX_CUSTOM_TEXT_CHARS) };
      }
    };
  }
  getRegistry().register(tool);
  loadedTools.push({ name, requested_name: requestedName, file: safeRelativePath(root, file) });
}

function resolveCustomToolName(requestedName: string, file: string): string {
  const baseName = sanitizeToolName(requestedName);
  if (!baseName) throw new Error(`${requestedName} is not a valid tool name`);
  const registry = getRegistry();
  if (!registry.lookup(baseName)) return baseName;
  const prefixed = sanitizeToolName(`custom_${baseName}`);
  if (prefixed && !registry.lookup(prefixed)) return prefixed;
  const filePrefix = sanitizeToolName(`custom_${basename(file, extname(file))}_${baseName}`);
  if (filePrefix && !registry.lookup(filePrefix)) return filePrefix;
  throw new Error(`could not choose non-conflicting name for custom tool ${requestedName}`);
}

function sanitizeToolName(value: string): string {
  return value.trim().replace(CONTROL_TEXT_GLOBAL_RE, "").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+/, "").slice(0, 64);
}

function parsePermission(value: unknown): PermissionLevel {
  if (value === PermissionLevel.ALWAYS_ALLOW || value === "always_allow" || value === "allow") return PermissionLevel.ALWAYS_ALLOW;
  if (value === PermissionLevel.DENY_IN_PLAN || value === "deny_in_plan") return PermissionLevel.DENY_IN_PLAN;
  if (value === PermissionLevel.DANGEROUS || value === "dangerous") return PermissionLevel.DANGEROUS;
  return PermissionLevel.ASK;
}

function schemaObject(value: unknown): Record<string, unknown> {
  const safe = customJsonSafe(value, { dropUndefinedObjectFields: true });
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) return { type: "object", properties: {} };
  return safeJsonStringify(safe).length <= MAX_CUSTOM_SCHEMA_CHARS
    ? safe as Record<string, unknown>
    : { type: "object", properties: {} };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const item of value) {
    if (strings.length >= MAX_CUSTOM_ALIASES) break;
    if (typeof item !== "string") continue;
    const alias = text(item, 64);
    if (!CUSTOM_TOOL_NAME_RE.test(alias) || strings.includes(alias)) continue;
    strings.push(alias);
  }
  return strings.length ? strings : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_CUSTOM_RESULT_SIZE_CHARS)
    : undefined;
}

function normalizeValidationResult(result: unknown, args: Record<string, unknown>): ToolValidationResult {
  if (typeof result === "string") return { ok: false, message: text(result, MAX_CUSTOM_TEXT_CHARS) };
  if (result && typeof result === "object" && !Array.isArray(result) && typeof (result as Record<string, unknown>).ok === "boolean") {
    const record = result as ToolValidationResult;
    if (record.ok) {
      const validatedArgs = record.args && typeof record.args === "object" && !Array.isArray(record.args)
        ? customJsonSafe(record.args, { dropUndefinedObjectFields: true })
        : args;
      return validatedArgs && typeof validatedArgs === "object" && !Array.isArray(validatedArgs)
        ? { ok: true, args: validatedArgs as Record<string, unknown> }
        : { ok: true, args };
    }
    return { ok: false, ...(typeof record.message === "string" ? { message: text(record.message, MAX_CUSTOM_TEXT_CHARS) } : {}) };
  }
  return { ok: false, message: "custom tool validation failed" };
}

function validateCustomToolFile(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error(`${basename(file)} is not a regular file`);
  if (stat.size > MAX_CUSTOM_TOOL_FILE_BYTES) throw new Error(`${basename(file)} exceeds ${MAX_CUSTOM_TOOL_FILE_BYTES} bytes`);
}

function listCustomToolFiles(toolsDir: string): string[] {
  const regular: string[] = [];
  const irregular: string[] = [];
  for (const file of readdirSync(toolsDir).filter(item => CUSTOM_TOOL_EXTENSIONS.has(extname(item))).sort()) {
    const path = join(toolsDir, file);
    try {
      const stat = lstatSync(path);
      if (stat.isFile()) {
        if (regular.length < MAX_CUSTOM_TOOL_FILES) regular.push(path);
      } else if (irregular.length < MAX_CUSTOM_TOOL_FILES) {
        irregular.push(path);
      }
    } catch {
      if (irregular.length < MAX_CUSTOM_TOOL_FILES) irregular.push(path);
    }
  }
  return [...irregular, ...regular];
}

function parseResultKind(value: unknown): ToolResultKind {
  return value === "json" || value === "diff" || value === "artifact" || value === "diagnostic" || value === "task"
    ? value
    : "text";
}

function text(value: unknown, maxChars: number): string {
  return String(value ?? "").replace(CONTROL_TEXT_GLOBAL_RE, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function errorText(error: unknown): string {
  return text(error instanceof Error ? error.message : error, MAX_CUSTOM_TEXT_CHARS);
}

function safeRelativePath(root: string, target: string): string {
  const candidate = relative(root, target);
  const safe = !candidate || candidate.startsWith("..") || isAbsolute(candidate)
    ? basename(target)
    : candidate;
  return text(safe, MAX_CUSTOM_TEXT_CHARS);
}

function pushLoadError(file: string, error: string): void {
  if (loadErrors.length >= MAX_CUSTOM_TOOL_LOAD_ERRORS) return;
  loadErrors.push({ file: text(file, MAX_CUSTOM_TEXT_CHARS), error: text(error, MAX_CUSTOM_TEXT_CHARS) });
}

function customJsonSafe(value: unknown, options: { dropUndefinedObjectFields?: boolean } = {}): unknown {
  return normalizeCustomJsonValue(value, options, new WeakSet<object>(), 0, { remaining: MAX_CUSTOM_JSON_NODES }, false);
}

function normalizeCustomJsonValue(
  value: unknown,
  options: { dropUndefinedObjectFields?: boolean },
  seen: WeakSet<object>,
  depth: number,
  budget: { remaining: number },
  insideObject: boolean,
): unknown {
  if (budget.remaining-- <= 0) return "[Truncated]";
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return options.dropUndefinedObjectFields && insideObject ? undefined : null;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.replace(CONTROL_TEXT_GLOBAL_RE, " ").slice(0, MAX_CUSTOM_JSON_STRING_CHARS);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_CUSTOM_JSON_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const limit = Math.min(value.length, MAX_CUSTOM_JSON_ARRAY_ITEMS);
      for (let index = 0; index < limit; index++) {
        const normalized = normalizeCustomJsonValue(value[index], options, seen, depth + 1, budget, false);
        result.push(normalized === undefined ? null : normalized);
      }
      if (value.length > limit) result.push("[Truncated]");
      return result;
    }

    const result: Record<string, unknown> = {};
    let count = 0;
    let visited = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (visited++ >= MAX_CUSTOM_JSON_KEYS || count >= MAX_CUSTOM_JSON_KEYS) {
        result.__truncated = true;
        break;
      }
      const safeKey = text(key, 256);
      if (!safeKey) continue;
      const child = (value as Record<string, unknown>)[key];
      const normalized = normalizeCustomJsonValue(child, options, seen, depth + 1, budget, true);
      if (normalized === undefined && options.dropUndefinedObjectFields) continue;
      result[safeKey] = normalized === undefined ? null : normalized;
      count++;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
