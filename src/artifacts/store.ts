/** Unified artifact store for large logs, patches, diagnostics, and external evidence. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { seekcodeDataPath } from "../paths.js";

export interface ArtifactRecord {
  id: string;
  kind: string;
  name: string;
  path: string;
  metadataPath: string;
  bytes: number;
  sha256: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface CreateArtifactOptions {
  kind: string;
  name: string;
  content: string | Buffer;
  metadata?: Record<string, unknown>;
  extension?: string;
}

export interface ArtifactLink {
  artifact_id: string;
  scope: "session" | "turn" | "task" | "job";
  target_id: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export function createArtifact(options: CreateArtifactOptions): ArtifactRecord {
  if (typeof options.kind !== "string" || !options.kind.trim()) {
    throw new Error("kind must be a non-empty string.");
  }
  if (typeof options.name !== "string" || !options.name.trim()) {
    throw new Error("name must be a non-empty string.");
  }
  if (typeof options.content !== "string" && !Buffer.isBuffer(options.content)) {
    throw new Error("content must be a string or Buffer.");
  }
  if (options.extension !== undefined && typeof options.extension !== "string") {
    throw new Error("extension must be a string.");
  }
  const root = artifactRoot();
  mkdirSync(root, { recursive: true });
  const createdAt = new Date().toISOString();
  const content = typeof options.content === "string" ? Buffer.from(options.content, "utf-8") : options.content;
  const metadata = normalizeArtifactMetadata(options.metadata);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const extension = safeExtension(options.extension || extname(options.name) || ".txt");
  const baseId = `${safeId(options.kind)}_${Date.now().toString(36)}_${sha256.slice(0, 10)}`;
  const id = uniqueArtifactId(root, baseId, extension);
  const path = join(root, `${id}${extension}`);
  const metadataPath = join(root, `${id}.json`);
  const record: ArtifactRecord = {
    id,
    kind: options.kind,
    name: basename(options.name || id),
    path,
    metadataPath,
    bytes: content.byteLength,
    sha256,
    created_at: createdAt,
    metadata,
  };
  writeFileSync(path, content);
  writeFileSync(metadataPath, JSON.stringify(record, null, 2), "utf-8");
  return record;
}

export function listArtifacts(limit = 50, kind?: string): ArtifactRecord[] {
  const root = artifactRoot();
  if (!existsSync(root)) return [];
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 50;
  const records: ArtifactRecord[] = [];
  for (const file of readdirSync(root).filter(name => name.endsWith(".json"))) {
    try {
      const record = JSON.parse(readFileSync(join(root, file), "utf-8")) as ArtifactRecord;
      if (!isArtifactRecord(record)) continue;
      if (kind && record.kind !== kind) continue;
      records.push(record);
    } catch {
      // skip corrupt metadata
    }
  }
  return records
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, normalizedLimit);
}

export function getArtifact(id: string): ArtifactRecord | undefined {
  const root = artifactRoot();
  const safeId = sanitizeArtifactLookupId(id);
  if (!safeId) return undefined;
  return readArtifactRecord(join(root, `${safeId}.json`));
}

export function readArtifact(id: string, maxBytes = 200_000): string {
  const record = getArtifact(id);
  if (!record) return `Error: artifact not found: ${id}`;
  try {
    const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 200_000;
    const stats = statSync(record.path);
    const content = readFileSync(record.path);
    const truncated = content.byteLength > limit;
    const slice = truncated ? content.subarray(0, limit) : content;
    return [
      JSON.stringify({ ...record, truncated, total_bytes: stats.size }, null, 2),
      "",
      slice.toString("utf-8"),
    ].join("\n");
  } catch (e: any) {
    return `Error reading artifact ${id}: ${e.message}`;
  }
}

export function linkArtifact(
  artifactId: string,
  scope: ArtifactLink["scope"],
  targetId: string,
  metadata: Record<string, unknown> = {},
): ArtifactLink {
  if (typeof artifactId !== "string" || !artifactId.trim()) {
    throw new Error("artifact_id must be a non-empty string.");
  }
  if (!["session", "turn", "task", "job"].includes(scope)) {
    throw new Error("scope must be one of session, turn, task, or job.");
  }
  if (typeof targetId !== "string" || !targetId.trim()) {
    throw new Error("target_id must be a non-empty string.");
  }
  const normalizedMetadata = normalizeArtifactMetadata(metadata);
  const link: ArtifactLink = {
    artifact_id: artifactId.trim(),
    scope,
    target_id: targetId.trim(),
    created_at: new Date().toISOString(),
    metadata: normalizedMetadata,
  };
  const links = listArtifactLinks();
  if (!links.some(item => item.artifact_id === artifactId && item.scope === scope && item.target_id === targetId)) {
    links.push(link);
    writeArtifactLinks(links);
  }
  return link;
}

export function listArtifactLinks(filter: Partial<Pick<ArtifactLink, "scope" | "target_id" | "artifact_id">> = {}): ArtifactLink[] {
  try {
    const raw = JSON.parse(readFileSync(artifactIndexPath(), "utf-8"));
    const links = Array.isArray(raw) ? raw.filter(isArtifactLink) : [];
    return links.filter(link => {
      if (filter.scope && link.scope !== filter.scope) return false;
      if (filter.target_id && link.target_id !== filter.target_id) return false;
      if (filter.artifact_id && link.artifact_id !== filter.artifact_id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

export function artifactRoot(): string {
  if (process.env.SEEKCODE_ARTIFACTS_DIR) return resolve(process.env.SEEKCODE_ARTIFACTS_DIR);
  if (process.env.DEEPCODE_ARTIFACTS_DIR) return resolve(process.env.DEEPCODE_ARTIFACTS_DIR);
  if (process.env.DEEPSEEK_ARTIFACTS_DIR) return resolve(process.env.DEEPSEEK_ARTIFACTS_DIR);
  return seekcodeDataPath("artifacts");
}

export function clearArtifactsForTests(): void {
  try { rmSync(artifactRoot(), { recursive: true, force: true }); } catch { /* ignore */ }
}

function normalizeArtifactMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be an object.");
  }
  return value as Record<string, unknown>;
}

function artifactIndexPath(): string {
  return join(artifactRoot(), "index.json");
}

function writeArtifactLinks(links: ArtifactLink[]): void {
  mkdirSync(artifactRoot(), { recursive: true });
  writeFileSync(artifactIndexPath(), JSON.stringify(links, null, 2), "utf-8");
}

function safeId(value: string): string {
  return String(value || "artifact").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48) || "artifact";
}

function safeExtension(value: string): string {
  const extension = value.startsWith(".") ? value : `.${value}`;
  const sanitized = extension.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 16);
  return /\.[a-zA-Z0-9]/.test(sanitized) ? sanitized : ".txt";
}

function uniqueArtifactId(root: string, baseId: string, extension: string): string {
  let id = baseId;
  let counter = 0;
  while (existsSync(join(root, `${id}${extension}`)) || existsSync(join(root, `${id}.json`))) {
    counter++;
    id = `${baseId}_${counter}`;
  }
  return id;
}

function sanitizeArtifactLookupId(value: string): string {
  const tail = String(value || "").split(/[\\/]/).pop() || "";
  return tail.replace(/[^a-zA-Z0-9._-]/g, "").replace(/^\.+/, "").trim();
}

function readArtifactRecord(metadataPath: string): ArtifactRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(metadataPath, "utf-8")) as ArtifactRecord;
    return isArtifactRecord(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ArtifactRecord>;
  return typeof record.id === "string"
    && typeof record.kind === "string"
    && typeof record.name === "string"
    && typeof record.path === "string"
    && typeof record.metadataPath === "string"
    && typeof record.created_at === "string"
    && typeof record.sha256 === "string"
    && typeof record.bytes === "number"
    && Number.isFinite(record.bytes)
    && record.bytes >= 0
    && isArtifactPathInsideRoot(record.path)
    && isArtifactPathInsideRoot(record.metadataPath);
}

function isArtifactLink(value: unknown): value is ArtifactLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const link = value as Partial<ArtifactLink>;
  return typeof link.artifact_id === "string"
    && typeof link.target_id === "string"
    && typeof link.created_at === "string"
    && (link.scope === "session" || link.scope === "turn" || link.scope === "task" || link.scope === "job")
    && (link.metadata === undefined || (typeof link.metadata === "object" && link.metadata !== null && !Array.isArray(link.metadata)));
}

function isArtifactPathInsideRoot(path: string): boolean {
  try {
    const root = realpathSync(artifactRoot());
    const resolved = existsSync(path) ? realpathSync(path) : resolve(path);
    const rel = relative(root, resolved);
    return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
  } catch {
    return false;
  }
}
