/** Workspace-local custom tool loading from .seekcode/tools. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import vm from "node:vm";
import { PermissionLevel, type ToolDef, type ToolValidationResult } from "./base.js";
import { getRegistry } from "./registry.js";

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
let loadedTools: LoadedCustomTool[] = [];
let loadErrors: CustomToolLoadError[] = [];

export function registerCustomTools(workspacePath = process.cwd()): void {
  loadedTools = [];
  loadErrors = [];
  registerCustomToolsListTool(workspacePath);

  const root = resolve(workspacePath || ".");
  const toolsDir = join(root, ".seekcode", "tools");
  if (!existsSync(toolsDir)) return;

  let files: string[] = [];
  try {
    files = readdirSync(toolsDir)
      .filter(file => CUSTOM_TOOL_EXTENSIONS.has(extname(file)))
      .sort()
      .map(file => join(toolsDir, file));
  } catch (error: any) {
    loadErrors.push({ file: relative(root, toolsDir), error: error?.message || String(error) });
    return;
  }

  for (const file of files) {
    try {
      for (const candidate of collectToolCandidates(loadCustomToolModule(file), file)) {
        registerCustomTool(candidate, file, root);
      }
    } catch (error: any) {
      loadErrors.push({ file: relative(root, file), error: error?.message || String(error) });
    }
  }
}

function registerCustomToolsListTool(workspacePath: string): void {
  getRegistry().register({
    name: "custom_tools",
    description: "List workspace-local custom tools loaded from .seekcode/tools.",
    parameters: { type: "object", properties: {} },
    execute: async () => JSON.stringify({
      workspace: resolve(workspacePath || "."),
      tools: loadedTools,
      errors: loadErrors,
    }, null, 2),
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
  const fn = new vm.Script(wrapped, { filename: file }).runInThisContext() as Function;
  fn(module.exports, module, localRequire, file, dirname(file), helper);
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
  const candidates = Array.isArray(raw) ? raw : [raw];
  return candidates.map(candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${basename(file)} must export a tool object or array of tool objects`);
    }
    return candidate as Record<string, unknown>;
  });
}

function registerCustomTool(definition: Record<string, unknown>, file: string, root: string): void {
  const requestedName = typeof definition.name === "string" ? definition.name.trim() : "";
  if (!requestedName) throw new Error(`${basename(file)} custom tool is missing name`);
  const name = resolveCustomToolName(requestedName, file);
  const description = typeof definition.description === "string" && definition.description.trim()
    ? definition.description.trim()
    : `Workspace custom tool from ${relative(root, file)}`;
  const run = typeof definition.run === "function"
    ? definition.run
    : typeof definition.execute === "function" ? definition.execute : null;
  const validate = typeof definition.validate === "function" ? definition.validate : null;
  if (!run) throw new Error(`${requestedName} custom tool must define run(args) or execute(args)`);

  const tool: ToolDef = {
    name,
    description,
    parameters: schemaObject(definition.parameters ?? definition.schema),
    execute: async (args, context) => {
      try {
        const result = await run(args, context);
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      } catch (error: any) {
        return `Error: custom tool '${name}' failed: ${error?.message || String(error)}`;
      }
    },
    permission: parsePermission(definition.permission),
    category: typeof definition.category === "string" && definition.category.trim() ? definition.category.trim() : "custom",
    parallelOk: definition.parallelOk === undefined ? definition.readOnly === true : definition.parallelOk === true,
    getPermissionPatterns: () => [name, relative(root, file)],
    getActivityDescription: () => `Running custom tool ${name}`,
    getToolUseSummary: () => `Custom tool ${name}`,
    renderMetadata: { userFacingName: name, icon: "wrench", resultKind: typeof definition.resultKind === "string" ? definition.resultKind as any : "text" },
  };
  const aliases = stringArray(definition.aliases);
  if (aliases !== undefined) tool.aliases = aliases;
  if (typeof definition.searchHint === "string") tool.searchHint = definition.searchHint;
  if (typeof definition.readOnly === "boolean") tool.readOnly = definition.readOnly;
  if (typeof definition.destructive === "boolean") tool.destructive = definition.destructive;
  const maxResultSizeChars = finiteNumber(definition.maxResultSizeChars);
  if (maxResultSizeChars !== undefined) tool.maxResultSizeChars = maxResultSizeChars;
  if (typeof definition.resultKind === "string") tool.resultKind = definition.resultKind as any;
  if (validate) {
    tool.validateInput = async (args, validationContext): Promise<ToolValidationResult> => normalizeValidationResult(await validate(args, validationContext), args);
  }
  getRegistry().register(tool);
  loadedTools.push({ name, requested_name: requestedName, file: relative(root, file) });
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
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+/, "").slice(0, 64);
}

function parsePermission(value: unknown): PermissionLevel {
  if (value === PermissionLevel.ALWAYS_ALLOW || value === "always_allow" || value === "allow") return PermissionLevel.ALWAYS_ALLOW;
  if (value === PermissionLevel.DENY_IN_PLAN || value === "deny_in_plan") return PermissionLevel.DENY_IN_PLAN;
  if (value === PermissionLevel.DANGEROUS || value === "dangerous") return PermissionLevel.DANGEROUS;
  return PermissionLevel.ASK;
}

function schemaObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { type: "object", properties: {} };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return strings.length ? strings : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeValidationResult(result: unknown, args: Record<string, unknown>): ToolValidationResult {
  if (typeof result === "string") return { ok: false, message: result };
  if (result && typeof result === "object" && !Array.isArray(result) && typeof (result as Record<string, unknown>).ok === "boolean") {
    const record = result as ToolValidationResult;
    return record.ok ? { ...record, args: record.args || args } : record;
  }
  return { ok: true, args };
}
