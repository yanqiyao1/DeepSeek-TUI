/** Unified artifact store for large logs, patches, diagnostics, and external evidence. */

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { seekcodeDataPath } from "../paths.js";
import { safeJsonStringify, toJsonSafe } from "../utils/json-safe.js";
import { canonicalizePathOrNearestExisting, isPathInsideRoot } from "../tools/path-resolution.js";
import { decodeUtf8Prefix, safeSliceTextBoundary } from "../utils/text-boundary.js";

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

const MAX_ARTIFACT_KIND_CHARS = 100;
const MAX_ARTIFACT_NAME_CHARS = 255;
const MAX_ARTIFACT_ID_CHARS = 128;
const MAX_ARTIFACT_TARGET_ID_CHARS = 256;
const MAX_ARTIFACT_METADATA_CHARS = 64_000;
const MAX_ARTIFACT_RECORD_BYTES = 1_000_000;
const MAX_ARTIFACT_INDEX_BYTES = 2_000_000;
const MAX_ARTIFACT_LINKS = 5_000;
const MAX_ARTIFACT_READ_BYTES = 2_000_000;
const MAX_ARTIFACT_ROOT_CHARS = 4_096;
const MAX_ARTIFACT_LIST_SCAN = 2_000;
const MAX_ARTIFACT_EXTENSION_CHARS = 16;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u001F\u007F]/g;
let atomicArtifactWriteCounter = 0;

export function createArtifact(options: CreateArtifactOptions): ArtifactRecord {
  const kindInput = safeProperty(options, "kind");
  const nameInput = safeProperty(options, "name");
  const contentInput = safeProperty(options, "content");
  const extensionInput = safeProperty(options, "extension");
  const metadataInput = safeProperty(options, "metadata");
  if (typeof kindInput !== "string" || !kindInput.trim()) {
    throw new Error("kind must be a non-empty string.");
  }
  if (typeof nameInput !== "string" || !nameInput.trim()) {
    throw new Error("name must be a non-empty string.");
  }
  if (typeof contentInput !== "string" && !Buffer.isBuffer(contentInput)) {
    throw new Error("content must be a string or Buffer.");
  }
  if (extensionInput !== undefined && typeof extensionInput !== "string") {
    throw new Error("extension must be a string.");
  }
  const kind = normalizeArtifactText(kindInput, "kind");
  const name = normalizeArtifactText(nameInput, "name");
  const root = artifactRoot();
  ensureArtifactRootForWrite(root);
  const createdAt = new Date().toISOString();
  const content = typeof contentInput === "string" ? Buffer.from(contentInput, "utf-8") : Buffer.from(contentInput);
  const metadata = normalizeArtifactMetadata(metadataInput);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const extension = safeExtension(extensionInput || extname(name) || ".txt");
  const baseId = `${safeId(kind)}_${Date.now().toString(36)}_${sha256.slice(0, 10)}`;
  const id = reserveArtifactId(root, baseId, extension);
  const path = join(root, artifactContentFilename(id, extension));
  const metadataPath = join(root, `${id}.json`);
  const record: ArtifactRecord = {
    id,
    kind,
    name: basename(name) || id,
    path,
    metadataPath,
    bytes: content.byteLength,
    sha256,
    created_at: createdAt,
    metadata,
  };
  try {
    writeArtifactFileAtomic(path, content, "artifact content");
    writeArtifactFileAtomic(metadataPath, safeJsonStringify(record, { space: 2 }), "artifact metadata");
  } catch (error) {
    // The metadata reservation makes the id unique across processes. Remove
    // both files on a failed two-file commit so callers do not inherit an
    // unreadable artifact or a permanently consumed id.
    cleanupArtifactFile(path);
    cleanupArtifactFile(metadataPath);
    throw error;
  }
  return record;
}

export function listArtifacts(limit = 50, kind?: string): ArtifactRecord[] {
  const root = artifactRoot();
  if (!isArtifactRootReadable(root)) return [];
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 500)) : 50;
  const normalizedKind = typeof kind === "string" ? normalizeArtifactFilterText(kind, MAX_ARTIFACT_KIND_CHARS) : "";
  const records: ArtifactRecord[] = [];
  let files: string[];
  try {
    files = readdirSync(root)
    .filter(name => name.endsWith(".json") && name !== "index.json")
    .sort((a, b) => Number(isLikelyArtifactMetadataFile(b)) - Number(isLikelyArtifactMetadataFile(a)))
    .slice(0, MAX_ARTIFACT_LIST_SCAN);
  } catch {
    return [];
  }
  for (const file of files) {
    const metadataPath = join(root, file);
    const expectedId = file.slice(0, -".json".length);
    const record = readArtifactRecord(metadataPath, expectedId);
    if (!record) continue;
    if (normalizedKind && record.kind !== normalizedKind) continue;
    records.push(record);
  }
  return records
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, normalizedLimit);
}

export function getArtifact(id: string): ArtifactRecord | undefined {
  const root = artifactRoot();
  const safeId = sanitizeArtifactLookupId(id);
  if (!safeId) return undefined;
  return readArtifactRecord(join(root, `${safeId}.json`), safeId);
}

export function readArtifact(id: string, maxBytes = 200_000): string {
  const record = getArtifact(id);
  if (!record) return `Error: artifact not found: ${id}`;
  try {
    const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 200_000;
    const boundedLimit = Math.min(limit, MAX_ARTIFACT_READ_BYTES);
    const bytesToRead = Math.min(record.bytes, boundedLimit);
    const slice = readArtifactContentPrefix(record.path, bytesToRead, record.bytes);
    const truncated = record.bytes > slice.byteLength;
    return [
      safeJsonStringify({ ...record, truncated, total_bytes: record.bytes }, { space: 2 }),
      "",
      decodeUtf8Prefix(slice),
    ].join("\n");
  } catch (e: any) {
    return `Error reading artifact ${sanitizeArtifactLookupId(id) || "unknown"}: ${e.message}`;
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
  const id = normalizeArtifactLinkIdForWrite(artifactId);
  if (!id) {
    throw new Error("artifact_id must be a non-empty string.");
  }
  const target = normalizeArtifactTargetId(targetId);
  if (!target) {
    throw new Error("target_id must be a non-empty string.");
  }
  const link: ArtifactLink = {
    artifact_id: id,
    scope,
    target_id: target,
    created_at: new Date().toISOString(),
    metadata: normalizedMetadata,
  };
  const links = listArtifactLinks();
  if (!links.some(item => item.artifact_id === id && item.scope === scope && item.target_id === target)) {
    links.push(link);
    writeArtifactLinks(links);
  }
  return link;
}

export function listArtifactLinks(filter: Partial<Pick<ArtifactLink, "scope" | "target_id" | "artifact_id">> = {}): ArtifactLink[] {
  try {
    const text = readSmallTextFile(artifactIndexPath(), MAX_ARTIFACT_INDEX_BYTES);
    if (text === null) return [];
    const raw = JSON.parse(text);
    const links = Array.isArray(raw) ? raw.slice(-MAX_ARTIFACT_LINKS).filter(isArtifactLink) : [];
    const normalizedFilter = normalizeArtifactLinkFilter(filter);
    return dedupeArtifactLinks(links).filter(link => {
      if (normalizedFilter.scope && link.scope !== normalizedFilter.scope) return false;
      if (normalizedFilter.target_id && link.target_id !== normalizedFilter.target_id) return false;
      if (normalizedFilter.artifact_id && link.artifact_id !== normalizedFilter.artifact_id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

export function artifactRoot(): string {
  const configured = firstArtifactRootEnvValue();
  if (configured) return resolve(configured);
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
  try {
    const normalized = toJsonSafe(value);
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return {};
    return safeJsonStringify(normalized).length <= MAX_ARTIFACT_METADATA_CHARS
      ? normalized as Record<string, unknown>
      : { truncated: true };
  } catch {
    return { truncated: true };
  }
}

function artifactIndexPath(): string {
  return join(artifactRoot(), "index.json");
}

function writeArtifactLinks(links: ArtifactLink[]): void {
  const root = artifactRoot();
  ensureArtifactRootForWrite(root);
  writeArtifactFileAtomic(
    join(root, "index.json"),
    safeJsonStringify(dedupeArtifactLinks(links).slice(-MAX_ARTIFACT_LINKS), { space: 2 }),
    "artifact link index",
  );
}

function safeId(value: string): string {
  return String(value || "artifact").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48) || "artifact";
}

function safeExtension(value: string): string {
  const extension = value.startsWith(".") ? value : `.${value}`;
  const withoutExtraDots = extension.replace(/[^a-zA-Z0-9.]/g, "").replace(/\.+/g, ".");
  const sanitized = withoutExtraDots.slice(0, MAX_ARTIFACT_EXTENSION_CHARS);
  return /\.[a-zA-Z0-9]/.test(sanitized) ? sanitized : ".txt";
}

function reserveArtifactId(root: string, baseId: string, extension: string): string {
  let counter = 0;
  while (counter <= 1_000_000) {
    const id = counter === 0 ? baseId : `${baseId}_${counter}`;
    const contentPath = join(root, artifactContentFilename(id, extension));
    const metadataPath = join(root, `${id}.json`);
    if (existsSync(contentPath)) {
      counter++;
      continue;
    }
    let fd: number | undefined;
    try {
      // O_EXCL reserves the metadata pathname without following a symlink and
      // closes the check-then-create race between independent processes.
      fd = openSync(metadataPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      return id;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      counter++;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  throw new Error("unable to allocate a unique artifact id");
}

function normalizeArtifactText(value: string, field: "kind" | "name"): string {
  const trimmed = value.trim();
  if (!trimmed || CONTROL_TEXT_RE.test(trimmed)) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return safeSliceTextBoundary(trimmed, field === "kind" ? MAX_ARTIFACT_KIND_CHARS : MAX_ARTIFACT_NAME_CHARS);
}

function artifactContentFilename(id: string, extension: string): string {
  return extension.toLowerCase() === ".json"
    ? `${id}.data.json`
    : `${id}${extension}`;
}

function isLikelyArtifactMetadataFile(name: string): boolean {
  const id = name.slice(0, -".json".length);
  return /^[A-Za-z0-9._-]+_[a-z0-9]+_[a-f0-9]{10}(?:_\d+)?$/.test(id);
}

function sanitizeArtifactLookupId(value: string): string {
  const tail = String(value || "").split(/[\\/]/).pop() || "";
  return tail.replace(/[^a-zA-Z0-9._-]/g, "").replace(/^\.+/, "").trim().slice(0, MAX_ARTIFACT_ID_CHARS);
}

function readArtifactRecord(metadataPath: string, expectedId?: string): ArtifactRecord | undefined {
  try {
    const text = readSmallTextFile(metadataPath, MAX_ARTIFACT_RECORD_BYTES);
    if (text === null) return undefined;
    const record = JSON.parse(text) as ArtifactRecord;
    return isArtifactRecord(record, {
      ...(expectedId !== undefined ? { expectedId } : {}),
      metadataPath,
    }) ? record : undefined;
  } catch {
    return undefined;
  }
}

function isArtifactRecord(value: unknown, expected: { expectedId?: string; metadataPath?: string } = {}): value is ArtifactRecord {
  if (!value || typeof value !== "object") return false;
  const id = safeProperty(value, "id");
  const metadataPath = safeProperty(value, "metadataPath");
  const contentPath = safeProperty(value, "path");
  const kind = safeProperty(value, "kind");
  const name = safeProperty(value, "name");
  const createdAt = safeProperty(value, "created_at");
  const sha256 = safeProperty(value, "sha256");
  const bytes = safeProperty(value, "bytes");
  const metadata = safeProperty(value, "metadata");
  if (typeof id !== "string" || sanitizeArtifactLookupId(id) !== id) return false;
  if (expected.expectedId !== undefined && id !== expected.expectedId) return false;
  if (typeof metadataPath !== "string") return false;
  if (expected.metadataPath !== undefined && !sameArtifactPath(metadataPath, expected.metadataPath)) return false;
  if (basename(metadataPath) !== `${id}.json`) return false;
  if (typeof contentPath !== "string") return false;
  const dataFile = basename(contentPath);
  if (!dataFile.startsWith(`${id}.`) || dataFile === `${id}.json`) return false;
  if (!isArtifactPathInsideRoot(contentPath) || !isArtifactPathInsideRoot(metadataPath)) return false;
  if (!artifactContentMatchesRecord(contentPath, bytes, sha256)) return false;
  return typeof kind === "string"
    && kind.trim().length > 0
    && isSafeArtifactText(kind, "kind")
    && typeof name === "string"
    && name.trim().length > 0
    && isSafeArtifactText(name, "name")
    && typeof createdAt === "string"
    && isValidIsoDate(createdAt)
    && typeof sha256 === "string"
    && /^[a-f0-9]{64}$/i.test(sha256)
    && typeof bytes === "number"
    && Number.isSafeInteger(bytes)
    && bytes >= 0
    && (metadata === undefined || isBoundedJsonObject(metadata));
}

function artifactContentMatchesRecord(path: string, bytes: unknown, sha256: unknown): boolean {
  let fd: number | undefined;
  try {
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return false;
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) return false;
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size !== bytes) return false;
    const content = readFileSync(fd);
    return createHash("sha256").update(content).digest("hex") === sha256.toLowerCase();
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function isArtifactLink(value: unknown): value is ArtifactLink {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifactId = safeProperty(value, "artifact_id");
  const targetId = safeProperty(value, "target_id");
  const createdAt = safeProperty(value, "created_at");
  const scope = safeProperty(value, "scope");
  const metadata = safeProperty(value, "metadata");
  return typeof artifactId === "string"
    && sanitizeArtifactLinkId(artifactId) === artifactId
    && typeof targetId === "string"
    && normalizeArtifactTargetId(targetId) === targetId
    && typeof createdAt === "string"
    && isValidIsoDate(createdAt)
    && (scope === "session" || scope === "turn" || scope === "task" || scope === "job")
    && (metadata === undefined || isBoundedJsonObject(metadata));
}

function isArtifactScope(value: unknown): value is ArtifactLink["scope"] {
  return value === "session" || value === "turn" || value === "task" || value === "job";
}

function isArtifactPathInsideRoot(path: string): boolean {
  try {
    const root = canonicalizePathOrNearestExisting(artifactRoot());
    const resolved = canonicalizePathOrNearestExisting(path);
    return isPathInsideRoot(resolved, root);
  } catch {
    return false;
  }
}

function sameArtifactPath(left: string, right: string): boolean {
  try {
    return canonicalizePathOrNearestExisting(left) === canonicalizePathOrNearestExisting(right);
  } catch {
    return false;
  }
}

function isValidIsoDate(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isBoundedJsonObject(value: unknown): value is Record<string, unknown> {
  try {
    return !!value
      && typeof value === "object"
      && !Array.isArray(value)
      && safeJsonStringify(value).length <= MAX_ARTIFACT_METADATA_CHARS;
  } catch {
    return false;
  }
}

function dedupeArtifactLinks(links: ArtifactLink[]): ArtifactLink[] {
  const seen = new Set<string>();
  const result: ArtifactLink[] = [];
  for (const link of links) {
    const key = `${link.artifact_id}\0${link.scope}\0${link.target_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}

function firstArtifactRootEnvValue(): string | undefined {
  for (const key of ["SEEKCODE_ARTIFACTS_DIR", "DEEPCODE_ARTIFACTS_DIR", "DEEPSEEK_ARTIFACTS_DIR"]) {
    const raw = safeProperty(process.env, key);
    if (raw === undefined) continue;
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed && trimmed.length <= MAX_ARTIFACT_ROOT_CHARS && !CONTROL_TEXT_RE.test(trimmed)) return trimmed;
  }
  return undefined;
}

function sanitizeArtifactLinkId(value: string): string {
  return sanitizeArtifactLookupId(value.trim());
}

function normalizeArtifactLinkIdForWrite(value: string): string {
  const trimmed = value.trim();
  const sanitized = sanitizeArtifactLinkId(trimmed);
  return sanitized === trimmed ? trimmed : "";
}

function normalizeArtifactLinkFilter(filter: Partial<Pick<ArtifactLink, "scope" | "target_id" | "artifact_id">>): Partial<Pick<ArtifactLink, "scope" | "target_id" | "artifact_id">> {
  const normalized: Partial<Pick<ArtifactLink, "scope" | "target_id" | "artifact_id">> = {};
  const scope = safeProperty(filter, "scope");
  const target = safeProperty(filter, "target_id");
  const artifact = safeProperty(filter, "artifact_id");
  if (isArtifactScope(scope)) normalized.scope = scope;
  if (typeof target === "string") {
    const targetId = normalizeArtifactTargetId(target);
    if (targetId) normalized.target_id = targetId;
  }
  if (typeof artifact === "string") {
    const artifactId = sanitizeArtifactLinkId(artifact);
    if (artifactId) normalized.artifact_id = artifactId;
  }
  return normalized;
}

function normalizeArtifactTargetId(value: string): string {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_ARTIFACT_TARGET_ID_CHARS && !CONTROL_TEXT_RE.test(trimmed)
    ? trimmed
    : "";
}

function isSafeArtifactText(value: string, field: "kind" | "name"): boolean {
  const trimmed = value.trim();
  const maxChars = field === "kind" ? MAX_ARTIFACT_KIND_CHARS : MAX_ARTIFACT_NAME_CHARS;
  return trimmed.length > 0 && trimmed.length <= maxChars && !CONTROL_TEXT_RE.test(trimmed);
}

function normalizeArtifactFilterText(value: string, maxChars: number): string {
  const normalized = value.replace(CONTROL_TEXT_GLOBAL_RE, " ").trim().split(/\s+/)[0] || "";
  return normalized ? safeSliceTextBoundary(normalized, maxChars) : "";
}

function readSmallTextFile(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    return readFileSync(fd, "utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close errors */ }
    }
  }
}

function readArtifactContentPrefix(path: string, bytesToRead: number, expectedBytes: number): Buffer {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("artifact content is not a file");
    if (stats.size !== expectedBytes) throw new Error("artifact content size mismatch");
    if (bytesToRead <= 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function writeArtifactFileAtomic(path: string, payload: string | Buffer, label: string): void {
  assertSafeArtifactWriteTarget(path, label);
  const dir = dirname(path);
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.${atomicArtifactWriteCounter++}.tmp`);
  try {
    if (typeof payload === "string") {
      writeFileSync(tmpPath, payload, { encoding: "utf-8", flag: "wx" });
    } else {
      writeFileSync(tmpPath, payload, { flag: "wx" });
    }
    assertSafeArtifactWriteTarget(path, label);
    renameSync(tmpPath, path);
  } catch (error) {
    cleanupAtomicArtifactTemp(tmpPath);
    throw error;
  }
}

function assertSafeArtifactWriteTarget(path: string, label: string): void {
  const root = canonicalizePathOrNearestExisting(artifactRoot());
  const resolved = canonicalizePathOrNearestExisting(path);
  if (!isPathInsideRoot(resolved, root)) {
    throw new Error(`Refusing to write ${label} outside artifact root.`);
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to write ${label} over a non-file path.`);
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function cleanupAtomicArtifactTemp(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function cleanupArtifactFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink() && stat.isFile()) unlinkSync(path);
  } catch {
    // best-effort cleanup after a failed artifact commit
  }
}

function ensureArtifactRootForWrite(root: string): void {
  assertNoSymlinkPathSegments(root);
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink()) throw new Error(`artifact root must not be a symlink: ${root}`);
    if (!stat.isDirectory()) throw new Error(`artifact root is not a directory: ${root}`);
    return;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  mkdirSync(root, { recursive: true });
  assertNoSymlinkPathSegments(root);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`artifact root must not be a symlink: ${root}`);
  if (!stat.isDirectory()) throw new Error(`artifact root is not a directory: ${root}`);
}

function isArtifactRootReadable(root: string): boolean {
  try {
    assertNoSymlinkPathSegments(root);
    const stat = lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function assertNoSymlinkPathSegments(path: string): void {
  // Police symlinks only at or below the nearest existing ancestor: those are the
  // directories we would actually create (via mkdir -p) or write into, so a symlink
  // there could redirect the root outside its intended location. Pre-existing system
  // symlinks higher up the tree (e.g. /tmp -> /private/tmp and /var on macOS) are
  // outside the area we manage and must not be rejected. Containment of the resolved
  // root is still enforced canonically by isArtifactPathInsideRoot/assertSafeArtifactWriteTarget.
  const resolved = resolve(path);
  const segments: string[] = [];
  let current = resolved;
  while (true) {
    segments.push(current);
    if (existsSync(current)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const segment of segments) {
    try {
      if (lstatSync(segment).isSymbolicLink()) {
        throw new Error(`artifact root must not include a symlink path segment: ${segment}`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
}
