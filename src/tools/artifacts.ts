/** Tools for unified artifact storage. */

import { createArtifact, linkArtifact, listArtifactLinks, listArtifacts, readArtifact } from "../artifacts/store.js";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";

const ARTIFACT_LINK_SCOPES = new Set(["session", "turn", "task", "job"]);
const MAX_ARTIFACT_KIND_CHARS = 100;
const MAX_ARTIFACT_NAME_CHARS = 255;
const MAX_ARTIFACT_EXTENSION_CHARS = 16;
const MAX_ARTIFACT_ID_CHARS = 128;
const MAX_ARTIFACT_TARGET_ID_CHARS = 256;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;

function parseStrictIntegerLike(value: unknown, options: { allowBlankString?: boolean } = {}): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed && options.allowBlankString) return undefined;
  if (!/^[-+]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateOptionalNumber(value: unknown, key: "limit" | "max_bytes", options: { allowBlankString?: boolean; min?: number } = {}): string | null {
  if (value === undefined) return null;
  const parsed = parseStrictIntegerLike(value, options);
  if (parsed === undefined) {
    if (typeof value === "string" && !value.trim() && options.allowBlankString) return null;
    return `${key} must be a number.`;
  }
  if (options.min !== undefined && parsed < options.min) return `${key} must be non-negative.`;
  return null;
}

function validateArtifactMetadata(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "metadata must be an object.";
  return null;
}

async function artifactCreate(args: Record<string, unknown>): Promise<string> {
  if (typeof args.content !== "string") return "Error: content must be a string.";
  const content = args.content;
  if (!content) return "Error: content is required.";
  const textValidation = validateArtifactCreateTextArgs(args);
  if (!textValidation.ok) return `Error: ${textValidation.message}`;
  const metadataError = validateArtifactMetadata(args.metadata);
  if (metadataError) return `Error: ${metadataError}`;
  try {
    const record = createArtifact({
      kind: typeof textValidation.args.kind === "string" ? textValidation.args.kind : "generic",
      name: typeof textValidation.args.name === "string" ? textValidation.args.name : "artifact.txt",
      content,
      ...(typeof textValidation.args.extension === "string" ? { extension: textValidation.args.extension } : {}),
      metadata: typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : {},
    });
    return safeJsonStringify(record, { space: 2 });
  } catch (error: any) {
    return `Error: ${error?.message || "failed to create artifact"}`;
  }
}

async function artifactList(args: Record<string, unknown>): Promise<string> {
  const kindValidation = validateArtifactOptionalText(args.kind, "kind", MAX_ARTIFACT_KIND_CHARS, { allowBlank: true });
  if (!kindValidation.ok) return `Error: ${kindValidation.message}`;
  const limitError = validateOptionalNumber(args.limit, "limit", { allowBlankString: true });
  if (limitError) return `Error: ${limitError}`;
  const limit = typeof args.limit === "string" && !args.limit.trim()
    ? 50
    : args.limit === undefined
      ? 50
      : Number(args.limit);
  const kind = kindValidation.value;
  const records = listArtifacts(limit, kind);
  return records.length ? safeJsonStringify(records, { space: 2 }) : "No artifacts.";
}

async function artifactRead(args: Record<string, unknown>): Promise<string> {
  const idValidation = validateArtifactId(args.id, "id", { required: true });
  if (!idValidation.ok) return `Error: ${idValidation.message}`;
  const maxBytesError = validateOptionalNumber(args.max_bytes, "max_bytes", { min: 0 });
  if (maxBytesError) return `Error: ${maxBytesError}`;
  return readArtifact(idValidation.value, args.max_bytes === undefined ? 200_000 : Number(args.max_bytes));
}

async function artifactLink(args: Record<string, unknown>): Promise<string> {
  const validated = validateArtifactLinkInput(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  try {
    return safeJsonStringify(linkArtifact(
      validated.args.id,
      validated.args.scope,
      validated.args.target_id,
      typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : {},
    ), { space: 2 });
  } catch (error: any) {
    return `Error: ${error?.message || "failed to link artifact"}`;
  }
}

async function artifactLinks(args: Record<string, unknown>): Promise<string> {
  const validated = validateArtifactLinksFilterArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const links = listArtifactLinks(omitUndefined({
    scope: validated.args.scope,
    target_id: validated.args.target_id,
    artifact_id: validated.args.id,
  }));
  return links.length ? safeJsonStringify(links, { space: 2 }) : "No artifact links.";
}

function normalizeArtifactLinkArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  if (normalized.id === undefined && normalized.artifact_id !== undefined) normalized.id = normalized.artifact_id;
  if (normalized.target_id === undefined && normalized.target !== undefined) normalized.target_id = normalized.target;
  const scope = normalizeArtifactLinkScope(normalized.scope);
  if (scope) normalized.scope = scope;
  return normalized;
}

function normalizeArtifactLinkScope(value: unknown): "session" | "turn" | "task" | "job" | null {
  const scope = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ARTIFACT_LINK_SCOPES.has(scope) ? scope as "session" | "turn" | "task" | "job" : null;
}

function validateArtifactCreateTextArgs(args: Record<string, unknown>):
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string } {
  const normalized = { ...args };
  const kind = validateArtifactOptionalText(args.kind, "kind", MAX_ARTIFACT_KIND_CHARS);
  if (!kind.ok) return kind;
  if (kind.value !== undefined) normalized.kind = kind.value;
  const name = validateArtifactOptionalText(args.name, "name", MAX_ARTIFACT_NAME_CHARS);
  if (!name.ok) return name;
  if (name.value !== undefined) normalized.name = name.value;
  const extension = validateArtifactOptionalText(args.extension, "extension", MAX_ARTIFACT_EXTENSION_CHARS, { allowBlank: true });
  if (!extension.ok) return extension;
  if (extension.value !== undefined) normalized.extension = extension.value;
  else delete normalized.extension;
  return { ok: true, args: normalized };
}

function validateArtifactOptionalText(
  value: unknown,
  key: "kind" | "name" | "extension",
  maxChars: number,
  options: { allowBlank?: boolean } = {},
): { ok: true; value?: string } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false, message: `${key} must be a string.` };
  if (CONTROL_TEXT_RE.test(value)) return { ok: false, message: `${key} contains unsupported control characters.` };
  const trimmed = value.trim();
  if (!trimmed) {
    return options.allowBlank
      ? { ok: true }
      : { ok: false, message: `${key} must be a non-empty string.` };
  }
  if (trimmed.length > maxChars) return { ok: false, message: `${key} must be ${maxChars} characters or fewer.` };
  return { ok: true, value: trimmed };
}

function validateArtifactId(
  value: unknown,
  key: "id" | "artifact_id",
  options: { required?: boolean } = {},
): { ok: true; value: string } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: false, message: options.required ? "id is required." : `${key} must be a non-empty string.` };
  }
  if (typeof value !== "string") {
    return { ok: false, message: options.required ? "id is required." : `${key} must be a string.` };
  }
  if (CONTROL_TEXT_RE.test(value)) return { ok: false, message: `${key} contains invalid characters.` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: options.required ? "id is required." : `${key} must be a non-empty string.` };
  if (trimmed.length > MAX_ARTIFACT_ID_CHARS) return { ok: false, message: `${key} must be ${MAX_ARTIFACT_ID_CHARS} characters or fewer.` };
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed.startsWith(".")) {
    return { ok: false, message: `${key} contains invalid characters.` };
  }
  return { ok: true, value: trimmed };
}

function validateArtifactTargetId(
  value: unknown,
  options: { required?: boolean } = {},
): { ok: true; value: string } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: false, message: options.required ? "target_id is required." : "target_id must be a non-empty string." };
  }
  if (typeof value !== "string") return { ok: false, message: "target_id must be a string." };
  if (CONTROL_TEXT_RE.test(value)) return { ok: false, message: "target_id contains unsupported control characters." };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: options.required ? "target_id is required." : "target_id must be a non-empty string." };
  if (trimmed.length > MAX_ARTIFACT_TARGET_ID_CHARS) {
    return { ok: false, message: `target_id must be ${MAX_ARTIFACT_TARGET_ID_CHARS} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}

function validateArtifactLinkInput(args: Record<string, unknown>):
  | { ok: true; args: { id: string; scope: "session" | "turn" | "task" | "job"; target_id: string } }
  | { ok: false; message: string } {
  const normalized = normalizeArtifactLinkArgs(args);
  if (typeof normalized.id !== "string" || typeof normalized.target_id !== "string" || !normalized.id.trim() || !normalized.target_id.trim()) {
    return { ok: false, message: "id and target_id are required." };
  }
  const id = validateArtifactId(normalized.id, "id", { required: true });
  if (!id.ok) return id;
  const target = validateArtifactTargetId(normalized.target_id, { required: true });
  if (!target.ok) return target;
  const scope = normalizeArtifactLinkScope(normalized.scope);
  if (!scope) return { ok: false, message: "scope must be one of session, turn, task, or job." };
  const metadataError = validateArtifactMetadata(normalized.metadata);
  if (metadataError) return { ok: false, message: metadataError };
  return { ok: true, args: { id: id.value, scope, target_id: target.value } };
}

function validateArtifactLinksFilterArgs(args: Record<string, unknown>):
  | { ok: true; args: { scope?: "session" | "turn" | "task" | "job"; target_id?: string; id?: string } }
  | { ok: false; message: string } {
  const aliasedArgs = normalizeArtifactLinkArgs(args);
  const normalized: { scope?: "session" | "turn" | "task" | "job"; target_id?: string; id?: string } = {};

  if (aliasedArgs.scope !== undefined) {
    if (typeof aliasedArgs.scope !== "string") return { ok: false, message: "scope must be a string." };
    const scope = normalizeArtifactLinkScope(aliasedArgs.scope);
    if (!scope) return { ok: false, message: "scope must be one of session, turn, task, or job." };
    normalized.scope = scope;
  }

  if (aliasedArgs.target_id !== undefined) {
    const targetId = validateArtifactTargetId(aliasedArgs.target_id);
    if (!targetId.ok) return targetId;
    normalized.target_id = targetId.value;
  }

  if (aliasedArgs.id !== undefined) {
    const id = validateArtifactId(aliasedArgs.id, "id");
    if (!id.ok) return id;
    normalized.id = id.value;
  }

  return { ok: true, args: normalized };
}

export function registerArtifactTools(): void {
  const registry = getRegistry();
  registry.register({
    name: "artifact_create",
    description: "Store a large log, patch, diagnostic result, or evidence file in the artifact store.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", default: "generic" },
        name: { type: "string", default: "artifact.txt" },
        content: { type: "string" },
        extension: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["content"],
    },
    execute: artifactCreate,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
    searchHint: "persist large evidence",
    resultKind: "artifact",
    concurrencySafe: true,
    validateInput: (args) => {
      if (args.content === undefined) return { ok: false as const, message: "content is required." };
      if (typeof args.content !== "string") return { ok: false as const, message: "content must be a string." };
      if (!args.content) return { ok: false as const, message: "content is required." };
      const textValidation = validateArtifactCreateTextArgs(args);
      if (!textValidation.ok) return { ok: false as const, message: textValidation.message };
      const metadataError = validateArtifactMetadata(args.metadata);
      return metadataError
        ? { ok: false as const, message: metadataError }
        : { ok: true as const, args: textValidation.args };
    },
  });
  registry.register({
    name: "artifact_list",
    description: "List stored artifacts.",
    parameters: { type: "object", properties: { limit: { type: "integer", default: 50 }, kind: { type: "string" } } },
    execute: artifactList,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
    readOnly: true,
    validateInput: (args) => {
      const kindValidation = validateArtifactOptionalText(args.kind, "kind", MAX_ARTIFACT_KIND_CHARS, { allowBlank: true });
      if (!kindValidation.ok) return { ok: false as const, message: kindValidation.message };
      const limitError = validateOptionalNumber(args.limit, "limit", { allowBlankString: true });
      return limitError ? { ok: false as const, message: limitError } : {
        ok: true as const,
        args: omitUndefined({ ...args, kind: kindValidation.value }),
      };
    },
    searchHint: "list stored artifacts",
    resultKind: "json",
  });
  registry.register({
    name: "artifact_read",
    description: "Read an artifact by id, with optional byte limit.",
    parameters: { type: "object", properties: { id: { type: "string" }, max_bytes: { type: "integer", default: 200000 } }, required: ["id"] },
    execute: artifactRead,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
    readOnly: true,
    validateInput: (args) => {
      const id = validateArtifactId(args.id, "id", { required: true });
      if (!id.ok) return { ok: false as const, message: id.message };
      const maxBytesError = validateOptionalNumber(args.max_bytes, "max_bytes", { min: 0 });
      return maxBytesError ? { ok: false as const, message: maxBytesError } : { ok: true as const, args: { ...args, id: id.value } };
    },
    searchHint: "read stored artifact",
    resultKind: "artifact",
    maxResultSizeChars: 120_000,
    isSearchOrReadCommand: () => ({ isSearch: false, isRead: true }),
  });
  registry.register({
    name: "artifact_link",
    description: "Link an artifact to a session, turn, task, or job for later replay and evidence lookup.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        scope: { type: "string", enum: ["session", "turn", "task", "job"] },
        target_id: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["id", "scope", "target_id"],
    },
    execute: artifactLink,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
    validateInput: (args) => {
      const validated = validateArtifactLinkInput(args);
      return validated.ok
        ? { ok: true, args: { ...normalizeArtifactLinkArgs(args), ...validated.args } }
        : { ok: false, message: validated.message };
    },
    searchHint: "link artifact evidence",
    resultKind: "json",
  });
  registry.register({
    name: "artifact_links",
    description: "List artifact links by scope, target_id, or artifact id.",
    parameters: { type: "object", properties: { scope: { type: "string" }, target_id: { type: "string" }, id: { type: "string" } } },
    execute: artifactLinks,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "artifact",
    parallelOk: true,
    readOnly: true,
    validateInput: (args) => {
      const validated = validateArtifactLinksFilterArgs(args);
      return validated.ok
        ? { ok: true as const, args: validated.args }
        : { ok: false as const, message: validated.message };
    },
    searchHint: "list artifact links",
    resultKind: "json",
  });
}
