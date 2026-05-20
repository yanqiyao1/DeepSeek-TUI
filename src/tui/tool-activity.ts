const PATH_KEYS = [
  "path",
  "file",
  "file_path",
  "filepath",
  "filename",
  "target_file",
  "target_path",
  "output_path",
];

const COMMAND_KEYS = ["command", "cmd"];
const SEARCH_KEYS = ["pattern", "query"];
const DESCRIPTION_KEYS = ["description", "prompt", "title", "task"];

export function defaultToolActivityLabel(name: string): string {
  switch (name) {
    case "write":
      return "Writing file";
    case "edit":
      return "Editing file";
    case "read":
      return "Reading file";
    case "ls":
      return "Listing files";
    case "search":
      return "Searching files";
    case "glob":
      return "Finding files";
    case "bash":
    case "task_gate_run":
      return "Running command";
    case "task_shell_start":
      return "Starting background command";
    case "task_create":
      return "Creating task";
    case "apply_patch":
      return "Applying patch";
    default:
      return humanizeToolName(name);
  }
}

export function describeToolActivity(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "write":
      return describePathAction("Writing", args, "file");
    case "edit":
      return describePathAction("Editing", args, "file");
    case "read":
      return describePathAction("Reading", args, "file");
    case "ls":
      return describePathAction("Listing", args, "files");
    case "search":
      return describeSearch(args);
    case "glob":
      return describeGlob(args);
    case "bash":
    case "task_gate_run":
      return describeCommandAction("Running", args);
    case "task_shell_start":
      return describeCommandAction("Starting", args, "background command");
    case "task_create":
      return describeTaskCreate(args);
    case "apply_patch":
      return describePatch(args);
    default:
      return defaultToolActivityLabel(name);
  }
}

export function describeToolActivityFromArgsStream(name: string, argsText: string): string | null {
  switch (name) {
    case "write":
      return describePathActionFromArgs("Writing", argsText);
    case "edit":
      return describePathActionFromArgs("Editing", argsText);
    case "read":
      return describePathActionFromArgs("Reading", argsText);
    case "ls":
      return describePathActionFromArgs("Listing", argsText, "files");
    case "bash":
    case "task_gate_run":
      return describeCommandActionFromArgs("Running", argsText);
    case "task_shell_start":
      return describeCommandActionFromArgs("Starting", argsText, "background command");
    case "task_create":
      return describeTaskCreateFromArgs(argsText);
    case "apply_patch": {
      const target = extractJsonStringField(argsText, ["target_file"]);
      return target ? `Applying patch to ${summarizePath(target)}` : null;
    }
    default:
      return null;
  }
}

function describePathAction(action: string, args: Record<string, unknown>, fallback = "file"): string {
  const path = firstString(args, PATH_KEYS);
  return path ? `${action} ${summarizePath(path)}` : `${action} ${fallback}`;
}

function describePathActionFromArgs(action: string, argsText: string, fallback = "file"): string | null {
  const path = extractJsonStringField(argsText, PATH_KEYS);
  return path ? `${action} ${summarizePath(path)}` : null;
}

function describeCommandAction(action: string, args: Record<string, unknown>, fallback = "command"): string {
  const command = firstString(args, COMMAND_KEYS);
  return command ? `${action} ${summarizeCommand(command)}` : `${action} ${fallback}`;
}

function describeCommandActionFromArgs(action: string, argsText: string, fallback = "command"): string | null {
  const command = extractJsonStringField(argsText, COMMAND_KEYS);
  return command ? `${action} ${summarizeCommand(command)}` : null;
}

function describeSearch(args: Record<string, unknown>): string {
  const pattern = firstString(args, SEARCH_KEYS);
  const path = firstString(args, PATH_KEYS);
  if (pattern && path && path !== ".") return `Searching for ${quoteSnippet(pattern)} in ${summarizePath(path)}`;
  if (pattern) return `Searching for ${quoteSnippet(pattern)}`;
  if (path && path !== ".") return `Searching ${summarizePath(path)}`;
  return "Searching files";
}

function describeGlob(args: Record<string, unknown>): string {
  const pattern = firstString(args, ["pattern"]);
  const path = firstString(args, PATH_KEYS);
  if (pattern && path && path !== ".") return `Finding ${quoteSnippet(pattern)} in ${summarizePath(path)}`;
  if (pattern) return `Finding ${quoteSnippet(pattern)}`;
  if (path && path !== ".") return `Finding files in ${summarizePath(path)}`;
  return "Finding files";
}

function describeTaskCreate(args: Record<string, unknown>): string {
  const command = firstString(args, COMMAND_KEYS);
  if (command) return `Creating task for ${summarizeCommand(command)}`;
  const description = firstString(args, DESCRIPTION_KEYS);
  return description ? `Creating task: ${summarizeText(description)}` : "Creating task";
}

function describeTaskCreateFromArgs(argsText: string): string | null {
  const command = extractJsonStringField(argsText, COMMAND_KEYS);
  if (command) return `Creating task for ${summarizeCommand(command)}`;
  const description = extractJsonStringField(argsText, DESCRIPTION_KEYS);
  return description ? `Creating task: ${summarizeText(description)}` : null;
}

function describePatch(args: Record<string, unknown>): string {
  const target = firstString(args, ["target_file"]);
  if (target) return `Applying patch to ${summarizePath(target)}`;
  if (typeof args.patch === "string") {
    const files = extractPatchFiles(args.patch);
    if (files.length === 1 && files[0]) return `Applying patch to ${summarizePath(files[0])}`;
    if (files.length > 1) return `Applying patch to ${files.length} files`;
  }
  return "Applying patch";
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function extractJsonStringField(argsText: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
    const match = pattern.exec(argsText);
    if (!match?.[1]) continue;
    const value = decodeJsonString(match[1]).trim();
    if (value) return value;
  }
  return undefined;
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ");
  }
}

function extractPatchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const advancedMatch = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (advancedMatch?.[1]) {
      files.add(advancedMatch[1].trim());
      continue;
    }
    const unifiedMatch = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (unifiedMatch?.[1] && unifiedMatch[1] !== "/dev/null") {
      files.add(unifiedMatch[1].trim());
    }
  }
  return [...files];
}

function summarizePath(path: string, maxLength = 56): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.length <= maxLength) return normalized;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return normalized.slice(0, maxLength - 3) + "...";
  let suffix = parts.pop() || normalized;
  while (parts.length) {
    const candidate = `${parts.at(-1)}/${suffix}`;
    if (candidate.length + 4 > maxLength) break;
    suffix = candidate;
    parts.pop();
  }
  return `.../${suffix}`;
}

function summarizeCommand(command: string, maxLength = 56): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 3) + "...";
}

function summarizeText(text: string, maxLength = 48): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 3) + "...";
}

function quoteSnippet(text: string, maxLength = 28): string {
  return `"${summarizeText(text, maxLength)}"`;
}

function humanizeToolName(name: string): string {
  const normalized = name.replace(/[_-]+/g, " ").trim();
  if (!normalized) return "Running tool";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
