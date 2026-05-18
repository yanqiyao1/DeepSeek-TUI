/** Tools for unified artifact storage. */

import { createArtifact, linkArtifact, listArtifactLinks, listArtifacts, readArtifact } from "../artifacts/store.js";
import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

const ARTIFACT_LINK_SCOPES = new Set(["session", "turn", "task", "job"]);

function strictIntegerLike(value: unknown, options: { allowBlankString?: boolean } = {}): boolean {
  if (value === undefined) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed && options.allowBlankString) return true;
  return /^[-+]?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed));
}

function validateOptionalNumber(value: unknown, key: "limit" | "max_bytes", options: { allowBlankString?: boolean } = {}): string | null {
  if (value === undefined) return null;
  return strictIntegerLike(value, options) ? null : `${key} must be a number.`;
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
  if (args.kind !== undefined && typeof args.kind !== "string") return "Error: kind must be a string.";
  if (args.name !== undefined && typeof args.name !== "string") return "Error: name must be a string.";
  if (typeof args.kind === "string" && !args.kind.trim()) return "Error: kind must be a non-empty string.";
  if (typeof args.name === "string" && !args.name.trim()) return "Error: name must be a non-empty string.";
  if (args.extension !== undefined && typeof args.extension !== "string") return "Error: extension must be a string.";
  const metadataError = validateArtifactMetadata(args.metadata);
  if (metadataError) return `Error: ${metadataError}`;
  const record = createArtifact({
    kind: typeof args.kind === "string" ? args.kind.trim() : "generic",
    name: typeof args.name === "string" ? args.name.trim() : "artifact.txt",
    content,
    extension: args.extension,
    metadata: typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : {},
  });
  return JSON.stringify(record, null, 2);
}

async function artifactList(args: Record<string, unknown>): Promise<string> {
  if (args.kind !== undefined && typeof args.kind !== "string") return "Error: kind must be a string.";
  const limitError = validateOptionalNumber(args.limit, "limit", { allowBlankString: true });
  if (limitError) return `Error: ${limitError}`;
  const limit = typeof args.limit === "string" && !args.limit.trim()
    ? 50
    : args.limit === undefined
      ? 50
      : Number(args.limit);
  const kind = args.kind;
  const records = listArtifacts(limit, kind);
  return records.length ? JSON.stringify(records, null, 2) : "No artifacts.";
}

async function artifactRead(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return "Error: id is required.";
  const maxBytesError = validateOptionalNumber(args.max_bytes, "max_bytes");
  if (maxBytesError) return `Error: ${maxBytesError}`;
  return readArtifact(id, args.max_bytes === undefined ? 200_000 : Number(args.max_bytes));
}

async function artifactLink(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string"
    ? args.id.trim()
    : typeof args.artifact_id === "string"
      ? args.artifact_id.trim()
      : "";
  const scope = normalizeArtifactLinkScope(args.scope);
  const target = typeof args.target_id === "string"
    ? args.target_id.trim()
    : typeof args.target === "string"
      ? args.target.trim()
      : "";
  if (!id || !target) return "Error: id and target_id are required.";
  if (!scope) return "Error: scope must be one of session, turn, task, or job.";
  const metadataError = validateArtifactMetadata(args.metadata);
  if (metadataError) return `Error: ${metadataError}`;
  return JSON.stringify(linkArtifact(id, scope, target, typeof args.metadata === "object" && args.metadata !== null ? args.metadata as Record<string, unknown> : {}), null, 2);
}

async function artifactLinks(args: Record<string, unknown>): Promise<string> {
  const validated = validateArtifactLinksFilterArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const links = listArtifactLinks({
    scope: validated.args.scope,
    target_id: validated.args.target_id,
    artifact_id: validated.args.id,
  });
  return links.length ? JSON.stringify(links, null, 2) : "No artifact links.";
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
    if (typeof aliasedArgs.target_id !== "string") return { ok: false, message: "target_id must be a string." };
    const targetId = aliasedArgs.target_id.trim();
    if (!targetId) return { ok: false, message: "target_id must be a non-empty string." };
    normalized.target_id = targetId;
  }

  if (aliasedArgs.id !== undefined) {
    if (typeof aliasedArgs.id !== "string") return { ok: false, message: "id must be a string." };
    const id = aliasedArgs.id.trim();
    if (!id) return { ok: false, message: "id must be a non-empty string." };
    normalized.id = id;
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
      if (args.kind !== undefined && typeof args.kind !== "string") return { ok: false as const, message: "kind must be a string." };
      if (args.name !== undefined && typeof args.name !== "string") return { ok: false as const, message: "name must be a string." };
      if (typeof args.kind === "string" && !args.kind.trim()) return { ok: false as const, message: "kind must be a non-empty string." };
      if (typeof args.name === "string" && !args.name.trim()) return { ok: false as const, message: "name must be a non-empty string." };
      if (args.extension !== undefined && typeof args.extension !== "string") return { ok: false as const, message: "extension must be a string." };
      const metadataError = validateArtifactMetadata(args.metadata);
      return metadataError
        ? { ok: false as const, message: metadataError }
        : {
          ok: true as const,
          args: {
            ...args,
            ...(typeof args.kind === "string" ? { kind: args.kind.trim() } : {}),
            ...(typeof args.name === "string" ? { name: args.name.trim() } : {}),
          },
        };
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
      if (args.kind !== undefined && typeof args.kind !== "string") return { ok: false as const, message: "kind must be a string." };
      const limitError = validateOptionalNumber(args.limit, "limit", { allowBlankString: true });
      return limitError ? { ok: false as const, message: limitError } : { ok: true as const, args };
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
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) return { ok: false as const, message: "id is required." };
      const maxBytesError = validateOptionalNumber(args.max_bytes, "max_bytes");
      return maxBytesError ? { ok: false as const, message: maxBytesError } : { ok: true as const, args: { ...args, id } };
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
      const normalized = normalizeArtifactLinkArgs(args);
      const id = typeof normalized.id === "string" ? normalized.id.trim() : "";
      const targetId = typeof normalized.target_id === "string" ? normalized.target_id.trim() : "";
      if (!id || !targetId) return { ok: false, message: "id and target_id are required." };
      if (!normalizeArtifactLinkScope(normalized.scope)) {
        return { ok: false, message: "scope must be one of session, turn, task, or job." };
      }
      const metadataError = validateArtifactMetadata(normalized.metadata);
      if (metadataError) return { ok: false, message: metadataError };
      return { ok: true, args: { ...normalized, id, target_id: targetId } };
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
