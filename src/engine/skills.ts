/** SKILL.md based skill registry, activation, and installer.
 *
 * The design mirrors DeepSeek-TUI's skill model:
 * - discover workspace-local skills before global skills
 * - expose only skill metadata in the system prompt to protect prefix cache
 * - inject the selected skill body only when `/skill <name>` activates it
 * - install community skills through a bounded, traversal-safe tar extractor
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";
import { gunzipSync } from "node:zlib";
import { LEGACY_DEEPSEEK_DIR, SEEKCODE_DIR } from "../paths.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

export const DEFAULT_SKILLS_REGISTRY_URL =
  "https://raw.githubusercontent.com/Hmbown/deepseek-skills/main/index.json";
export const DEFAULT_SKILL_INSTALL_SIZE_BYTES = 5 * 1024 * 1024;
export const INSTALLED_FROM_MARKER = ".installed-from";
export const TRUSTED_MARKER = ".trusted";

const SYSTEM_SKILL_CREATOR = `---
name: skill-creator
description: Guide for creating or updating Seek Code skills with SKILL.md frontmatter, focused instructions, and optional bundled resources.
---

# Skill Creator

Use this skill when the user wants to create a new skill or improve an existing one.

Every skill is a directory containing a required SKILL.md file and optional resources:

\`\`\`text
my-skill/
├── SKILL.md
├── scripts/
└── references/
\`\`\`

SKILL.md must start with YAML frontmatter:

\`\`\`markdown
---
name: my-skill
description: Use this skill when ...
---
\`\`\`

Keep the SKILL.md body concise and procedural. Move long examples, schemas, or reference material into files under references/ and mention exactly when to read them. Prefer one clear workflow over a grab bag of tips.

Before creating files, ask where the user wants the skill placed if they did not specify a location. If they have no preference, use \`~/.seekcode/skills\` so Seek Code can discover it globally, or \`./skills\` for a project-local skill.
`;

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const CHECKSUM_RE = /^[a-f0-9]{64}$/i;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_BODY_CHARS = 120_000;
const MAX_SKILL_DESCRIPTION_CHARS = 1_000;
const MAX_SKILL_CONTEXT_CHARS = 80_000;
const MAX_SKILLS_CONTEXT_COUNT = 200;
const MAX_SKILL_SCAN_DIRS = 2_000;
const MAX_SKILL_SCAN_FILES = 200;
const MAX_REMOTE_SKILLS = 500;
const MAX_REMOTE_FIELD_CHARS = 2_000;
const MAX_INSTALL_SOURCE_CHARS = 4_096;
const MAX_SKILL_PATH_CHARS = 4_096;
const MAX_SKILL_INSTALL_SIZE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_PATH_CHARS = 255;
const MAX_INSTALL_MARKER_BYTES = 64 * 1024;
const SKILL_FETCH_TIMEOUT_MS = 30_000;
const MAX_INSTALL_BACKUP_ATTEMPTS = 50;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
let skillMarkerWriteCounter = 0;

export type SkillScope = "workspace" | "project" | "global" | "compat" | "system";

export interface SkillInfo {
  name: string;
  description: string;
  location: string;
  directory: string;
  content: string;
  body: string;
  enabled: boolean;
  scope: SkillScope;
  source: string;
  installed: boolean;
  trusted: boolean;
  system: boolean;
}

export interface SkillDiscoveryOptions {
  workspaceDir?: string;
  homeDir?: string;
  skillsDir?: string;
  includeSystem?: boolean;
}

export interface SkillScanResult {
  skills: SkillInfo[];
  errors: string[];
}

export interface SkillActivationResult {
  ok: boolean;
  instruction?: string;
  skill?: SkillInfo;
  message: string;
}

export interface RemoteSkill {
  name: string;
  description?: string;
  source?: string;
  spec?: string;
  url?: string;
  repo?: string;
}

export interface InstalledSkill {
  name: string;
  path: string;
  source: string;
  checksum: string;
}

export type SkillInstallResult =
  | { status: "installed"; skill: InstalledSkill }
  | { status: "unchanged"; skill: InstalledSkill };

export type SkillUpdateResult =
  | { status: "updated"; skill: InstalledSkill }
  | { status: "unchanged"; skill: InstalledSkill };

export class SkillRegistry {
  private byName: Map<string, SkillInfo>;

  constructor(private skills: SkillInfo[], private warningList: string[] = []) {
    this.byName = new Map(skills.map(skill => [skill.name, skill]));
  }

  static discover(options: SkillDiscoveryOptions = {}): SkillRegistry {
    const result = scanSkills(options.workspaceDir, options.homeDir, options);
    return new SkillRegistry(result.skills, result.errors);
  }

  list(): SkillInfo[] {
    return [...this.skills].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillInfo | undefined {
    return this.byName.get(name);
  }

  warnings(): string[] {
    return [...this.warningList];
  }

  isEmpty(): boolean {
    return this.skills.length === 0;
  }

  get len(): number {
    return this.skills.length;
  }
}

export function defaultSkillsDir(homeDir = process.env.HOME || "~"): string {
  return resolveHome("~/.seekcode/skills", homeDir);
}

export function resolveSkillPath(path: string, homeDir = process.env.HOME || "~"): string {
  return resolveHome(path, homeDir);
}

export function scanSkills(
  workspaceDir: string = process.cwd(),
  homeDir: string = process.env.HOME || "~",
  options: SkillDiscoveryOptions = {},
): SkillScanResult {
  const workspace = resolveSafePath(workspaceDir, "workspace directory");
  const home = resolveHome(homeDir, homeDir);
  const configuredSkillsDir = resolveHome(options.skillsDir || defaultSkillsDir(home), home);
  const includeSystem = options.includeSystem !== false;
  const result: SkillScanResult = { skills: [], errors: [] };
  const seenNames = new Map<string, string>();
  const seenRoots = new Set<string>();

  const addRoot = (root: string, scope: SkillScope, source: string) => {
    const resolvedRoot = resolveHome(root, home);
    if (seenRoots.has(resolvedRoot)) return;
    seenRoots.add(resolvedRoot);
    scanSkillRoot(resolvedRoot, scope, source, seenNames, result);
  };

  addRoot(join(workspace, ".agents", "skills"), "workspace", "workspace .agents/skills");
  addRoot(join(workspace, "skills"), "workspace", "workspace ./skills");
  addRoot(join(workspace, SEEKCODE_DIR, "skills"), "project", "workspace .seekcode/skills");
  addRoot(join(workspace, LEGACY_DEEPSEEK_DIR, "skills"), "compat", "legacy workspace .deepseek/skills");
  addRoot(configuredSkillsDir, "global", "configured skills_dir");
  addRoot(join(home, SEEKCODE_DIR, "skills"), "global", "global ~/.seekcode/skills");
  addRoot(join(home, LEGACY_DEEPSEEK_DIR, "skills"), "compat", "legacy global ~/.deepseek/skills");
  addRoot(join(home, ".agents", "skills"), "compat", "global ~/.agents/skills");
  addRoot(join(home, ".claude", "skills"), "compat", "global ~/.claude/skills");

  if (includeSystem) {
    try {
      const system = parseSkillDocument(SYSTEM_SKILL_CREATOR, "builtin:skill-creator", {
        scope: "system",
        source: "builtin",
        directory: "builtin:skill-creator",
        system: true,
      });
      if (!seenNames.has(system.name)) {
        seenNames.set(system.name, system.location);
        result.skills.push(system);
      }
    } catch (e: any) {
      result.errors.push(`builtin:skill-creator: ${e.message}`);
    }
  }

  return result;
}

function scanSkillRoot(
  root: string,
  scope: SkillScope,
  source: string,
  seenNames: Map<string, string>,
  result: SkillScanResult,
): void {
  if (!existsSync(root)) return;
  let stat;
  try {
    stat = statSync(root);
  } catch (e: any) {
    result.errors.push(`${root}: ${e.message}`);
    return;
  }
  if (!stat.isDirectory()) return;

  for (const skillFile of collectSkillFiles(root)) {
    try {
      const skill = parseSkillFile(skillFile, scope, source);
      const existing = seenNames.get(skill.name);
      if (existing) {
        result.errors.push(`duplicate skill '${skill.name}' ignored at ${skill.location}; first definition is ${existing}`);
        continue;
      }
      seenNames.set(skill.name, skill.location);
      result.skills.push(skill);
    } catch (e: any) {
      result.errors.push(`${skillFile}: ${e.message}`);
    }
  }
}

function collectSkillFiles(root: string): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (++visited > MAX_SKILL_SCAN_DIRS || found.length >= MAX_SKILL_SCAN_FILES) return;
    if (depth > 8) return;
    const skill = join(dir, "SKILL.md");
    try {
      if (existsSync(skill) && lstatSync(skill).isFile()) {
        found.push(skill);
        return;
      }
    } catch {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".tmp-")) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

export function parseSkillFile(filepath: string, scope: SkillScope = "global", source = "filesystem"): SkillInfo {
  const stat = statSync(filepath);
  if (!stat.isFile()) throw new Error("SKILL.md is not a regular file");
  if (stat.size > MAX_SKILL_FILE_BYTES) throw new Error(`SKILL.md exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
  const raw = readFileSync(filepath, "utf-8");
  return parseSkillDocument(raw, filepath, {
    scope,
    source,
    directory: dirname(filepath),
    system: false,
  });
}

function parseSkillDocument(
  raw: string,
  location: string,
  meta: { scope: SkillScope; source: string; directory: string; system: boolean },
): SkillInfo {
  if (raw.length > MAX_SKILL_BODY_CHARS + MAX_SKILL_DESCRIPTION_CHARS + 8_192) throw new Error("SKILL.md is too large");
  if (CONTROL_TEXT_RE.test(raw)) throw new Error("SKILL.md contains control characters");
  if (!raw.trim()) throw new Error("SKILL.md is empty");
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error("SKILL.md must start with YAML frontmatter");
  const name = parsed.frontmatter.name?.trim();
  const description = parsed.frontmatter.description?.trim();
  if (!name) throw new Error("SKILL.md frontmatter missing required field: name");
  if (!description) throw new Error("SKILL.md frontmatter missing required field: description");
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`invalid skill name '${name}'`);
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) throw new Error("SKILL.md description is too long");
  if (parsed.body.length > MAX_SKILL_BODY_CHARS) throw new Error("SKILL.md body is too long");
  const directory = meta.directory;
  const markerDir = meta.system ? "" : directory;
  return {
    name,
    description: sanitizeSkillText(description, MAX_SKILL_DESCRIPTION_CHARS),
    location,
    directory,
    content: sanitizeSkillText(parsed.body, MAX_SKILL_BODY_CHARS),
    body: sanitizeSkillText(parsed.body, MAX_SKILL_BODY_CHARS),
    enabled: true,
    scope: meta.scope,
    source: meta.source,
    installed: !!markerDir && skillMarkerFileExists(markerDir, INSTALLED_FROM_MARKER),
    trusted: !!markerDir && skillMarkerFileExists(markerDir, TRUSTED_MARKER),
    system: meta.system,
  };
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  const frontmatterText = match[1] ?? "";
  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }
  return { frontmatter, body: raw.slice(match[0].length).trim() };
}

function sanitizeSkillText(value: string, maxChars: number): string {
  return safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " ").trim(), maxChars);
}

export function buildSkillsContext(skills: SkillInfo[]): string {
  const enabled = skills.filter(skill => skill.enabled);
  if (!enabled.length) return "";
  const lines = enabled
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SKILLS_CONTEXT_COUNT)
    .map(skill => `- ${skill.name}: ${sanitizeSkillText(skill.description, MAX_SKILL_DESCRIPTION_CHARS)} (${sanitizeSkillText(skill.location, MAX_SKILL_PATH_CHARS)})`);
  const context = [
    "## Skills",
    "",
    "Skills are available as optional, task-specific instruction packs. If the user names a skill, or the request clearly matches a skill description, read that skill's SKILL.md before applying it. Do not assume skill details from the name alone.",
    "",
    ...lines,
  ].join("\n");
  return safeSliceTextBoundary(context, MAX_SKILL_CONTEXT_CHARS);
}

export function renderAvailableSkillsContext(skillsDir?: string, workspaceDir = process.cwd()): string | null {
  const registry = SkillRegistry.discover(omitUndefined({ workspaceDir, skillsDir }));
  const context = buildSkillsContext(registry.list());
  return context || null;
}

export function injectSkills(systemPrompt: string, workspaceDir?: string, skillsDir?: string): string {
  const registry = SkillRegistry.discover(omitUndefined({ workspaceDir, skillsDir }));
  const context = buildSkillsContext(registry.list());
  if (!context) return systemPrompt;
  return `${systemPrompt}\n\n${context}`;
}

export function listSkills(workspaceDir?: string, skillsDir?: string): string {
  const registry = SkillRegistry.discover(omitUndefined({ workspaceDir, skillsDir }));
  if (registry.isEmpty()) {
    const dir = resolveSkillPath(skillsDir || defaultSkillsDir());
    return [
      "No skills found.",
      "",
      `Skills location: ${dir}`,
      `Create a skill at: ${join(dir, "my-skill", "SKILL.md")}`,
    ].join("\n");
  }
  const lines = registry.list().map(skill => {
    const markers = [
      skill.scope,
      skill.installed ? "installed" : "",
      skill.trusted ? "trusted" : "",
      skill.system ? "builtin" : "",
    ].filter(Boolean).join(", ");
    return `  /skill ${skill.name} — ${skill.description} (${markers})\n      ${skill.location}`;
  });
  const warnings = registry.warnings();
  return [
    `Available skills (${registry.len}):`,
    ...lines,
    "",
    "Use /skill <name> to apply a skill to the next message.",
    "Use /skill new to create a skill.",
    "Use /skills --remote to browse the configured registry.",
    warnings.length ? `\nWarnings:\n${warnings.map(w => `  - ${w}`).join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

export function activateSkill(name: string, options: SkillDiscoveryOptions = {}): SkillActivationResult {
  const requested = typeof name === "string" ? name.trim() : "";
  const normalized = requested === "new" ? "skill-creator" : requested;
  if (!isValidSkillName(normalized)) {
    return { ok: false, message: `Invalid skill name: ${normalized || "<empty>"}` };
  }
  const registry = SkillRegistry.discover(options);
  const skill = registry.get(normalized);
  if (!skill) {
    const available = registry.list().map(item => item.name).join(", ") || "none";
    return {
      ok: false,
      message: `Skill '${normalized}' not found. Available skills: ${available}`,
    };
  }
  return {
    ok: true,
    skill,
    instruction: buildSkillActivationInstruction(skill),
    message: `Skill '${skill.name}' activated for the next message.\n\nDescription: ${skill.description}`,
  };
}

export function buildSkillActivationInstruction(skill: SkillInfo): string {
  return [
    "You are now using a Seek Code skill. Follow these instructions for this user request.",
    "",
    `<skill name="${skill.name}">`,
    `description: ${sanitizeSkillText(skill.description, MAX_SKILL_DESCRIPTION_CHARS)}`,
    `location: ${sanitizeSkillText(skill.location, MAX_SKILL_PATH_CHARS)}`,
    "",
    sanitizeSkillText(skill.body, MAX_SKILL_BODY_CHARS),
    "</skill>",
  ].join("\n");
}

export function applySkillToUserInput(userInput: string, instruction: string): string {
  return `${instruction}\n\n---\n\nUser request:\n${userInput}`;
}

export async function listRemoteSkills(
  registryUrl = DEFAULT_SKILLS_REGISTRY_URL,
  maxSizeBytes = DEFAULT_SKILL_INSTALL_SIZE_BYTES,
): Promise<string> {
  const skills = await fetchRegistrySkills(registryUrl, maxSizeBytes);
  if (!skills.length) return "No remote skills found.";
  return [
    `Remote skills (${skills.length}):`,
    ...skills.map(skill => `  ${skill.name} — ${skill.description || "No description"}${skillSourceSpec(skill) ? ` (${skillSourceSpec(skill)})` : ""}`),
  ].join("\n");
}

export async function fetchRegistrySkills(
  registryUrl = DEFAULT_SKILLS_REGISTRY_URL,
  maxSizeBytes = DEFAULT_SKILL_INSTALL_SIZE_BYTES,
): Promise<RemoteSkill[]> {
  const body = await fetchText(normalizeHttpUrl(registryUrl, "registry URL"), normalizeMaxSizeBytes(maxSizeBytes));
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("registry response is not valid JSON");
  }
  const rawSkills = registrySkillRecords(parsed);
  return rawSkills
    .slice(0, MAX_REMOTE_SKILLS)
    .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === "object")
    .map(normalizeRemoteSkill)
    .filter((skill): skill is RemoteSkill => !!skill);
}

export async function installSkill(
  spec: string,
  options: {
    skillsDir?: string;
    registryUrl?: string;
    maxSizeBytes?: number;
    force?: boolean;
  } = {},
): Promise<SkillInstallResult> {
  const skillsDir = resolveSkillPath(options.skillsDir || defaultSkillsDir());
  const maxSizeBytes = normalizeMaxSizeBytes(options.maxSizeBytes ?? DEFAULT_SKILL_INSTALL_SIZE_BYTES);
  const downloaded = await downloadSkillArchive(spec, options.registryUrl || DEFAULT_SKILLS_REGISTRY_URL, maxSizeBytes);
  const skill = installSkillFromArchive(downloaded.archive, downloaded.sourceSpec, skillsDir, maxSizeBytes, {
    force: !!options.force,
  });
  return { status: "installed", skill };
}

export async function updateSkill(
  name: string,
  options: {
    skillsDir?: string;
    registryUrl?: string;
    maxSizeBytes?: number;
  } = {},
): Promise<SkillUpdateResult> {
  const skillName = normalizeSkillNameForOperation(name);
  const skillsDir = resolveSkillPath(options.skillsDir || defaultSkillsDir());
  const maxSizeBytes = normalizeMaxSizeBytes(options.maxSizeBytes ?? DEFAULT_SKILL_INSTALL_SIZE_BYTES);
  const dir = join(skillsDir, skillName);
  const marker = readInstallMarker(dir);
  if (!marker) throw new Error(`skill '${skillName}' was not installed by /skill install`);
  const downloaded = await downloadSkillArchive(marker.source, options.registryUrl || DEFAULT_SKILLS_REGISTRY_URL, maxSizeBytes);
  const checksum = sha256(downloaded.archive);
  if (checksum === marker.checksum) {
    return {
      status: "unchanged",
      skill: { name: skillName, path: dir, source: marker.source, checksum },
    };
  }
  const skill = installSkillFromArchive(downloaded.archive, downloaded.sourceSpec, skillsDir, maxSizeBytes, {
    force: true,
    expectedName: skillName,
  });
  return { status: "updated", skill };
}

export function uninstallSkill(name: string, options: { skillsDir?: string } = {}): string {
  const skillName = normalizeSkillNameForOperation(name);
  const skillsDir = resolveSkillPath(options.skillsDir || defaultSkillsDir());
  const dir = join(skillsDir, skillName);
  if (!existsSync(dir)) throw new Error(`skill '${skillName}' is not installed`);
  if (!skillMarkerFileExists(dir, INSTALLED_FROM_MARKER)) {
    throw new Error(`refusing to uninstall '${skillName}': missing ${INSTALLED_FROM_MARKER}`);
  }
  rmSync(dir, { recursive: true, force: true });
  return `Uninstalled skill '${skillName}'.`;
}

export function trustSkill(name: string, options: { skillsDir?: string; workspaceDir?: string } = {}): string {
  const skillName = normalizeSkillNameForOperation(name);
  const registry = SkillRegistry.discover(omitUndefined({ workspaceDir: options.workspaceDir, skillsDir: options.skillsDir }));
  const skill = registry.get(skillName);
  if (!skill) throw new Error(`skill '${skillName}' not found`);
  if (skill.system) throw new Error(`builtin skill '${skillName}' does not need trust`);
  writeSkillMarkerFile(join(skill.directory, TRUSTED_MARKER), new Date().toISOString() + "\n");
  return `Trusted skill '${skillName}'.`;
}

export function installSkillFromArchive(
  archive: Buffer,
  sourceSpec: string,
  skillsDir: string,
  maxSizeBytes = DEFAULT_SKILL_INSTALL_SIZE_BYTES,
  options: { force?: boolean; expectedName?: string } = {},
): InstalledSkill {
  const normalizedSourceSpec = normalizeInstallSourceSpec(sourceSpec);
  const normalizedSkillsDir = resolveSkillPath(skillsDir);
  const normalizedMaxSizeBytes = normalizeMaxSizeBytes(maxSizeBytes);
  const expectedName = options.expectedName !== undefined ? normalizeSkillNameForOperation(options.expectedName) : undefined;
  if (archive.byteLength > normalizedMaxSizeBytes) {
    throw new Error(`archive exceeds max_install_size_bytes (${normalizedMaxSizeBytes})`);
  }
  const checksum = sha256(archive);
  const tar = maybeGunzip(archive, normalizedMaxSizeBytes);
  const entries = parseTar(tar, normalizedMaxSizeBytes);
  const skillMd = entries
    .filter(entry => entry.kind === "file" && basename(entry.path) === "SKILL.md")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))[0];
  if (!skillMd) throw new Error("missing SKILL.md in archive");

  const prefix = dirname(skillMd.path) === "." ? "" : dirname(skillMd.path);
  const rawSkill = skillMd.data.toString("utf-8");
  const parsed = parseSkillDocument(rawSkill, "archive:SKILL.md", {
    scope: "global",
    source: normalizedSourceSpec,
    directory: "",
    system: false,
  });
  if (expectedName && parsed.name !== expectedName) {
    throw new Error(`archive skill name mismatch: expected '${expectedName}', got '${parsed.name}'`);
  }
  if (CONTROL_TEXT_RE.test(parsed.body)) throw new Error("SKILL.md body contains control characters");
  const destination = join(normalizedSkillsDir, parsed.name);
  if (existsSync(destination) && !options.force) {
    throw new Error(`skill '${parsed.name}' is already installed; use /skill update or uninstall it first`);
  }

  mkdirSync(normalizedSkillsDir, { recursive: true });
  const tempDir = mkdtempSync(join(normalizedSkillsDir, ".tmp-"));
  let backupDir: string | null = null;
  try {
    for (const entry of entries) {
      const rel = archiveRelativePath(entry.path, prefix);
      if (rel === null || rel === "") continue;
      if (isReservedInstallPath(rel)) throw new Error(`archive contains reserved skill metadata path: ${rel}`);
      const outPath = safeJoin(tempDir, rel);
      if (entry.kind === "directory") {
        mkdirSync(outPath, { recursive: true });
      } else if (entry.kind === "file") {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, entry.data, { mode: 0o644 });
      }
    }
    writeSkillMarkerFile(join(tempDir, INSTALLED_FROM_MARKER), safeJsonStringify({
      source: normalizedSourceSpec,
      checksum,
      installed_at: new Date().toISOString(),
    }, { space: 2 }));

    if (existsSync(destination)) {
      backupDir = uniqueInstallBackupPath(normalizedSkillsDir, parsed.name);
      renameSync(destination, backupDir);
    }
    renameSync(tempDir, destination);
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
    return { name: parsed.name, path: destination, source: normalizedSourceSpec, checksum };
  } catch (e) {
    rmSync(tempDir, { recursive: true, force: true });
    if (backupDir && existsSync(backupDir) && !existsSync(destination)) {
      renameSync(backupDir, destination);
    }
    throw e;
  }
}

async function downloadSkillArchive(
  spec: string,
  registryUrl: string,
  maxSizeBytes: number,
  seenRegistryNames: Set<string> = new Set(),
): Promise<{ archive: Buffer; sourceSpec: string }> {
  const source = parseInstallSource(spec);
  if (source.kind === "registry") {
    if (seenRegistryNames.has(source.value)) {
      throw new Error(`registry skill '${source.value}' resolves recursively`);
    }
    seenRegistryNames.add(source.value);
    const registry = await fetchRegistrySkills(registryUrl, maxSizeBytes);
    const found = registry.find(skill => skill.name === source.value);
    if (!found) throw new Error(`registry skill '${source.value}' not found`);
    const foundSpec = skillSourceSpec(found);
    if (!foundSpec) throw new Error(`registry skill '${source.value}' has no source/url/repo`);
    return downloadSkillArchive(foundSpec, registryUrl, maxSizeBytes, seenRegistryNames);
  }
  if (source.kind === "github") {
    const mainUrl = `https://github.com/${source.value}/archive/refs/heads/main.tar.gz`;
    try {
      return { archive: await fetchBinary(mainUrl, maxSizeBytes), sourceSpec: `github:${source.value}` };
    } catch (e: any) {
      const masterUrl = `https://github.com/${source.value}/archive/refs/heads/master.tar.gz`;
      return { archive: await fetchBinary(masterUrl, maxSizeBytes), sourceSpec: `github:${source.value}` };
    }
  }
  return { archive: await fetchBinary(source.value, maxSizeBytes), sourceSpec: source.value };
}

function parseInstallSource(spec: string): { kind: "github" | "url" | "registry"; value: string } {
  const trimmed = normalizeInstallSourceSpec(spec);
  if (!trimmed) throw new Error("install source must not be empty");
  if (trimmed.startsWith("github:")) {
    const repo = trimmed.slice("github:".length).replace(/\/+$/, "");
    validateGithubRepo(repo, trimmed);
    return { kind: "github", value: repo };
  }
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    const url = normalizeHttpUrl(trimmed, "install URL");
    const githubRepo = parseGithubBrowserUrl(url);
    if (githubRepo) return { kind: "github", value: githubRepo };
    return { kind: "url", value: url };
  }
  validateSkillName(trimmed, "registry skill");
  return { kind: "registry", value: trimmed };
}

function validateGithubRepo(repo: string, original: string): void {
  const parts = repo.split("/");
  if (parts.length !== 2 || !GITHUB_OWNER_RE.test(parts[0] || "") || !GITHUB_REPO_RE.test(parts[1] || "") || parts[1] === "." || parts[1] === "..") {
    throw new Error(`github source must be 'github:owner/repo' (got ${original})`);
  }
}

function parseGithubBrowserUrl(url: string): string | null {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (!["github.com", "www.github.com"].includes(host)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parsed.search || parsed.hash) return null;
  const owner = decodeURIComponent(parts[0] || "");
  const repo = decodeURIComponent(parts[1] || "").replace(/\.git$/, "");
  if (!owner || !repo) return null;
  validateGithubRepo(`${owner}/${repo}`, url);
  return `${owner}/${repo}`;
}

function skillSourceSpec(skill: RemoteSkill): string {
  if (skill.source) return normalizeRemoteInstallSource(skill.source) || "";
  if (skill.spec) return normalizeRemoteInstallSource(skill.spec) || "";
  if (skill.url) return normalizeRemoteUrl(skill.url) || "";
  if (skill.repo) {
    const repo = normalizeRemoteRepo(skill.repo);
    if (!repo) return "";
    return repo.startsWith("github:") ? repo : `github:${repo}`;
  }
  return "";
}

async function fetchText(url: string, maxSizeBytes: number): Promise<string> {
  return (await fetchBinary(url, maxSizeBytes)).toString("utf-8");
}

async function fetchBinary(url: string, maxSizeBytes: number): Promise<Buffer> {
  const safeUrl = normalizeHttpUrl(url, "download URL");
  const limit = normalizeMaxSizeBytes(maxSizeBytes);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(safeUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`fetch failed for ${safeUrl}: HTTP ${response.status}`);
    const length = parseContentLength(response.headers.get("content-length"));
    if (length !== undefined && length > limit) throw new Error(`download exceeds max_install_size_bytes (${limit})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limit) throw new Error(`download exceeds max_install_size_bytes (${limit})`);
    return buffer;
  } catch (e: any) {
    if (controller.signal.aborted) {
      throw new Error(`download timed out after ${SKILL_FETCH_TIMEOUT_MS}ms: ${safeUrl}`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

interface InstallMarker {
  source: string;
  checksum: string;
}

function readInstallMarker(dir: string): InstallMarker | null {
  try {
    const markerPath = join(dir, INSTALLED_FROM_MARKER);
    const markerStat = lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.size > MAX_INSTALL_MARKER_BYTES) return null;
    const parsed = JSON.parse(readFileSync(markerPath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.source !== "string" || !parsed.source || parsed.source.length > MAX_INSTALL_SOURCE_CHARS || CONTROL_TEXT_RE.test(parsed.source)) return null;
    if (typeof parsed.checksum !== "string" || !CHECKSUM_RE.test(parsed.checksum)) return null;
    return { source: normalizeInstallSourceSpec(parsed.source), checksum: parsed.checksum };
  } catch {
    return null;
  }
}

function skillMarkerFileExists(dir: string, markerName: string): boolean {
  try {
    return lstatSync(join(dir, markerName)).isFile();
  } catch {
    return false;
  }
}

function writeSkillMarkerFile(path: string, payload: string): void {
  try {
    const existing = lstatSync(path);
    if (!existing.isFile()) throw new Error(`refusing to write non-file skill marker: ${basename(path)}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const tempPath = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${skillMarkerWriteCounter++}`);
  try {
    writeFileSync(tempPath, payload, { encoding: "utf-8", mode: 0o644, flag: "wx" });
    try {
      const existing = lstatSync(path);
      if (!existing.isFile()) throw new Error(`refusing to replace non-file skill marker: ${basename(path)}`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function resolveHome(path: string, homeDir = process.env.HOME || "~"): string {
  if (
    typeof path !== "string"
    || typeof homeDir !== "string"
    || path.length > MAX_SKILL_PATH_CHARS
    || homeDir.length > MAX_SKILL_PATH_CHARS
    || CONTROL_TEXT_RE.test(path)
    || CONTROL_TEXT_RE.test(homeDir)
  ) {
    throw new Error("path must not contain control characters");
  }
  if (path === "~") return resolve(homeDir);
  if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
  return resolve(path);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function maybeGunzip(buffer: Buffer, maxSizeBytes: number): Buffer {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    return gunzipSync(buffer, { maxOutputLength: maxSizeBytes + 1 });
  }
  return buffer;
}

interface TarEntry {
  path: string;
  kind: "file" | "directory";
  data: Buffer;
}

function parseTar(buffer: Buffer, maxSizeBytes: number): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalSize = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const rawPath = prefix ? `${prefix}/${name}` : name;
    assertSafeArchivePath(rawPath);
    const typeflag = readTarString(header, 156, 1) || "0";
    const size = readTarOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error(`truncated tar entry: ${rawPath}`);
    totalSize += size;
    if (totalSize > maxSizeBytes) throw new Error(`uncompressed archive exceeds max_install_size_bytes (${maxSizeBytes})`);
    if (typeflag === "2" || typeflag === "1") throw new Error("symlinks and hardlinks are not allowed in skill archives");
    if (entries.length >= MAX_ARCHIVE_ENTRIES) throw new Error(`archive contains too many entries (>${MAX_ARCHIVE_ENTRIES})`);
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      entries.push({ path: normalizeArchivePath(rawPath), kind: "file", data: buffer.subarray(dataStart, dataEnd) });
    } else if (typeflag === "5") {
      entries.push({ path: normalizeArchivePath(rawPath), kind: "directory", data: Buffer.alloc(0) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : slice.length).toString("utf-8").trim();
}

function readTarOctal(header: Buffer, start: number, length: number): number {
  const raw = readTarString(header, start, length).replace(/\0/g, "").trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar size: ${raw}`);
  const parsed = parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid tar size: ${raw}`);
  return parsed;
}

function assertSafeArchivePath(path: string): void {
  if (!path || isAbsolute(path)) throw new Error(`entry escapes destination directory: ${path}`);
  if (path.length > MAX_ARCHIVE_PATH_CHARS) throw new Error("archive entry path is too long");
  if (CONTROL_TEXT_RE.test(path)) throw new Error("archive entry contains control characters");
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.some(part => part === "." || part === "..")) {
    throw new Error(`entry escapes destination directory: ${path}`);
  }
}

function normalizeArchivePath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join("/");
}

function archiveRelativePath(path: string, prefix: string): string | null {
  const normalizedPath = normalizeArchivePath(path);
  const normalizedPrefix = normalizeArchivePath(prefix);
  if (!normalizedPrefix) return normalizedPath;
  if (normalizedPath === normalizedPrefix) return "";
  if (!normalizedPath.startsWith(`${normalizedPrefix}/`)) return null;
  return normalizedPath.slice(normalizedPrefix.length + 1);
}

function isReservedInstallPath(relPath: string): boolean {
  const normalized = normalizeArchivePath(relPath);
  return normalized === INSTALLED_FROM_MARKER || normalized === TRUSTED_MARKER;
}

function safeJoin(root: string, relPath: string): string {
  const out = resolve(root, relPath);
  const rootResolved = resolve(root);
  if (out !== rootResolved && !out.startsWith(rootResolved + sep)) {
    throw new Error(`entry escapes destination directory: ${relPath}`);
  }
  return out;
}

function uniqueInstallBackupPath(skillsDir: string, skillName: string): string {
  const base = join(skillsDir, `${skillName}.bak-${Date.now()}`);
  for (let index = 0; index < MAX_INSTALL_BACKUP_ATTEMPTS; index++) {
    const candidate = index === 0 ? base : `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not choose backup path for skill '${skillName}'`);
}

function registrySkillRecords(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.skills)) return record.skills;
  const entries: unknown[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      entries.push({ name, ...(value as Record<string, unknown>) });
    }
  }
  return entries;
}

function normalizeRemoteSkill(record: Record<string, unknown>): RemoteSkill | null {
  const name = optionalNonEmptyString(record.name);
  if (!name || !isValidSkillName(name)) return null;
  const description = optionalNonEmptyString(record.description);
  const source = optionalRemoteInstallSource(record.source);
  const spec = optionalRemoteInstallSource(record.spec);
  const url = optionalRemoteUrl(record.url);
  const repo = optionalRemoteRepo(record.repo);
  return omitUndefined({ name, description, source, spec, url, repo });
}

function optionalRemoteInstallSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeRemoteInstallSource(value);
}

function optionalRemoteUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeRemoteUrl(value);
}

function optionalRemoteRepo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeRemoteRepo(value);
}

function normalizeRemoteInstallSource(value: string): string | undefined {
  const trimmed = optionalNonEmptyString(value);
  if (!trimmed) return undefined;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return normalizeRemoteUrl(trimmed);
  if (trimmed.startsWith("github:")) {
    const repo = normalizeRemoteRepo(trimmed.slice("github:".length));
    return repo ? `github:${repo}` : undefined;
  }
  return isValidSkillName(trimmed) ? trimmed : undefined;
}

function normalizeRemoteUrl(value: string): string | undefined {
  try {
    return normalizeHttpUrl(value, "remote skill URL");
  } catch {
    return undefined;
  }
}

function normalizeRemoteRepo(value: string): string | undefined {
  const trimmed = optionalNonEmptyString(value)?.replace(/^github:/, "").replace(/\/+$/, "");
  if (!trimmed) return undefined;
  try {
    validateGithubRepo(trimmed, trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REMOTE_FIELD_CHARS || CONTROL_TEXT_RE.test(trimmed)) return undefined;
  return sanitizeSkillText(trimmed, MAX_REMOTE_FIELD_CHARS);
}

function normalizeSkillNameForOperation(value: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  validateSkillName(name, "skill name");
  return name;
}

function validateSkillName(name: string, label: string): void {
  if (!isValidSkillName(name)) throw new Error(`invalid ${label}: ${name || "<empty>"}`);
}

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name) && !name.includes("\0");
}

function normalizeInstallSourceSpec(spec: string): string {
  if (typeof spec !== "string") throw new Error("install source must be a string");
  const trimmed = spec.trim();
  if (!trimmed || trimmed.length > MAX_INSTALL_SOURCE_CHARS || CONTROL_TEXT_RE.test(trimmed)) throw new Error("install source must not be empty");
  return trimmed;
}

function normalizeHttpUrl(value: string, label: string): string {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${label} must be an http:// or https:// URL`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`${label} must not contain credentials`);
    }
    parsed.hash = "";
    const normalized = parsed.toString();
    if (normalized.length > MAX_INSTALL_SOURCE_CHARS || CONTROL_TEXT_RE.test(normalized)) {
      throw new Error(`${label} is too long`);
    }
    return normalized;
  } catch (e: any) {
    if (e?.message?.includes(label)) throw e;
    throw new Error(`${label} must be an http:// or https:// URL`);
  }
}

function normalizeMaxSizeBytes(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_SKILL_INSTALL_SIZE_BYTES;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("max_install_size_bytes must be a positive integer");
  }
  if (value > MAX_SKILL_INSTALL_SIZE_BYTES) {
    throw new Error(`max_install_size_bytes must be at most ${MAX_SKILL_INSTALL_SIZE_BYTES}`);
  }
  return value;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`invalid content-length: ${value}`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid content-length: ${value}`);
  return parsed;
}

function resolveSafePath(path: string, label: string): string {
  if (typeof path !== "string" || path.length > MAX_SKILL_PATH_CHARS || CONTROL_TEXT_RE.test(path)) throw new Error(`${label} must not contain control characters`);
  return resolve(path);
}
