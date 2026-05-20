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
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
  const workspace = resolve(workspaceDir);
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
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    const skill = join(dir, "SKILL.md");
    if (existsSync(skill) && statSync(skill).isFile()) {
      found.push(skill);
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
  if (!raw.trim()) throw new Error("SKILL.md is empty");
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error("SKILL.md must start with YAML frontmatter");
  const name = parsed.frontmatter.name?.trim();
  const description = parsed.frontmatter.description?.trim();
  if (!name) throw new Error("SKILL.md frontmatter missing required field: name");
  if (!description) throw new Error("SKILL.md frontmatter missing required field: description");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) {
    throw new Error(`invalid skill name '${name}'`);
  }
  const directory = meta.directory;
  const markerDir = meta.system ? "" : directory;
  return {
    name,
    description,
    location,
    directory,
    content: parsed.body,
    body: parsed.body,
    enabled: true,
    scope: meta.scope,
    source: meta.source,
    installed: !!markerDir && existsSync(join(markerDir, INSTALLED_FROM_MARKER)),
    trusted: !!markerDir && existsSync(join(markerDir, TRUSTED_MARKER)),
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

export function buildSkillsContext(skills: SkillInfo[]): string {
  const enabled = skills.filter(skill => skill.enabled);
  if (!enabled.length) return "";
  const lines = enabled
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(skill => `- ${skill.name}: ${skill.description} (${skill.location})`);
  return [
    "## Skills",
    "",
    "Skills are available as optional, task-specific instruction packs. If the user names a skill, or the request clearly matches a skill description, read that skill's SKILL.md before applying it. Do not assume skill details from the name alone.",
    "",
    ...lines,
  ].join("\n");
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
  const normalized = name === "new" ? "skill-creator" : name;
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
    `description: ${skill.description}`,
    `location: ${skill.location}`,
    "",
    skill.body,
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
  const body = await fetchText(registryUrl, maxSizeBytes);
  const parsed = JSON.parse(body);
  const rawSkills: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.skills)
      ? parsed.skills
      : parsed && typeof parsed === "object"
        ? Object.entries(parsed).map(([name, value]) => ({ name, ...(value as Record<string, unknown>) }))
        : [];
  return rawSkills
    .filter((item: unknown): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item: Record<string, unknown>) => {
      const record = item as Record<string, unknown>;
      return omitUndefined({
        name: typeof record.name === "string" ? record.name : "",
        description: typeof record.description === "string" ? record.description : undefined,
        source: typeof record.source === "string" ? record.source : undefined,
        spec: typeof record.spec === "string" ? record.spec : undefined,
        url: typeof record.url === "string" ? record.url : undefined,
        repo: typeof record.repo === "string" ? record.repo : undefined,
      });
    })
    .filter((skill: RemoteSkill) => !!skill.name);
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
  const maxSizeBytes = options.maxSizeBytes || DEFAULT_SKILL_INSTALL_SIZE_BYTES;
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
  const skillsDir = resolveSkillPath(options.skillsDir || defaultSkillsDir());
  const dir = join(skillsDir, name);
  const marker = readInstallMarker(dir);
  if (!marker) throw new Error(`skill '${name}' was not installed by /skill install`);
  const maxSizeBytes = options.maxSizeBytes || DEFAULT_SKILL_INSTALL_SIZE_BYTES;
  const downloaded = await downloadSkillArchive(marker.source, options.registryUrl || DEFAULT_SKILLS_REGISTRY_URL, maxSizeBytes);
  const checksum = sha256(downloaded.archive);
  if (checksum === marker.checksum) {
    return {
      status: "unchanged",
      skill: { name, path: dir, source: marker.source, checksum },
    };
  }
  const skill = installSkillFromArchive(downloaded.archive, downloaded.sourceSpec, skillsDir, maxSizeBytes, {
    force: true,
    expectedName: name,
  });
  return { status: "updated", skill };
}

export function uninstallSkill(name: string, options: { skillsDir?: string } = {}): string {
  const skillsDir = resolveSkillPath(options.skillsDir || defaultSkillsDir());
  const dir = join(skillsDir, name);
  if (!existsSync(dir)) throw new Error(`skill '${name}' is not installed`);
  if (!existsSync(join(dir, INSTALLED_FROM_MARKER))) {
    throw new Error(`refusing to uninstall '${name}': missing ${INSTALLED_FROM_MARKER}`);
  }
  rmSync(dir, { recursive: true, force: true });
  return `Uninstalled skill '${name}'.`;
}

export function trustSkill(name: string, options: { skillsDir?: string; workspaceDir?: string } = {}): string {
  const registry = SkillRegistry.discover(omitUndefined({ workspaceDir: options.workspaceDir, skillsDir: options.skillsDir }));
  const skill = registry.get(name);
  if (!skill) throw new Error(`skill '${name}' not found`);
  if (skill.system) throw new Error(`builtin skill '${name}' does not need trust`);
  writeFileSync(join(skill.directory, TRUSTED_MARKER), new Date().toISOString() + "\n", "utf-8");
  return `Trusted skill '${name}'.`;
}

export function installSkillFromArchive(
  archive: Buffer,
  sourceSpec: string,
  skillsDir: string,
  maxSizeBytes = DEFAULT_SKILL_INSTALL_SIZE_BYTES,
  options: { force?: boolean; expectedName?: string } = {},
): InstalledSkill {
  if (archive.byteLength > maxSizeBytes) {
    throw new Error(`archive exceeds max_install_size_bytes (${maxSizeBytes})`);
  }
  const checksum = sha256(archive);
  const tar = maybeGunzip(archive);
  const entries = parseTar(tar, maxSizeBytes);
  const skillMd = entries
    .filter(entry => entry.kind === "file" && basename(entry.path) === "SKILL.md")
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))[0];
  if (!skillMd) throw new Error("missing SKILL.md in archive");

  const prefix = dirname(skillMd.path) === "." ? "" : dirname(skillMd.path);
  const rawSkill = skillMd.data.toString("utf-8");
  const parsed = parseSkillDocument(rawSkill, "archive:SKILL.md", {
    scope: "global",
    source: sourceSpec,
    directory: "",
    system: false,
  });
  if (options.expectedName && parsed.name !== options.expectedName) {
    throw new Error(`archive skill name mismatch: expected '${options.expectedName}', got '${parsed.name}'`);
  }
  if (parsed.body.includes("\0")) throw new Error("SKILL.md body contains NUL byte");
  const destination = join(resolveSkillPath(skillsDir), parsed.name);
  if (existsSync(destination) && !options.force) {
    throw new Error(`skill '${parsed.name}' is already installed; use /skill update or uninstall it first`);
  }

  mkdirSync(resolveSkillPath(skillsDir), { recursive: true });
  const tempDir = mkdtempSync(join(resolveSkillPath(skillsDir), ".tmp-"));
  let backupDir: string | null = null;
  try {
    for (const entry of entries) {
      const rel = archiveRelativePath(entry.path, prefix);
      if (rel === null || rel === "") continue;
      const outPath = safeJoin(tempDir, rel);
      if (entry.kind === "directory") {
        mkdirSync(outPath, { recursive: true });
      } else if (entry.kind === "file") {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, entry.data, { mode: 0o644 });
      }
    }
    writeFileSync(join(tempDir, INSTALLED_FROM_MARKER), JSON.stringify({
      source: sourceSpec,
      checksum,
      installed_at: new Date().toISOString(),
    }, null, 2), "utf-8");

    if (existsSync(destination)) {
      backupDir = `${destination}.bak-${Date.now()}`;
      renameSync(destination, backupDir);
    }
    renameSync(tempDir, destination);
    if (backupDir) rmSync(backupDir, { recursive: true, force: true });
    return { name: parsed.name, path: destination, source: sourceSpec, checksum };
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
): Promise<{ archive: Buffer; sourceSpec: string }> {
  const source = parseInstallSource(spec);
  if (source.kind === "registry") {
    const registry = await fetchRegistrySkills(registryUrl, maxSizeBytes);
    const found = registry.find(skill => skill.name === source.value);
    if (!found) throw new Error(`registry skill '${source.value}' not found`);
    const foundSpec = skillSourceSpec(found);
    if (!foundSpec) throw new Error(`registry skill '${source.value}' has no source/url/repo`);
    return downloadSkillArchive(foundSpec, registryUrl, maxSizeBytes);
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
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("install source must not be empty");
  if (trimmed.startsWith("github:")) {
    const repo = trimmed.slice("github:".length).replace(/\/+$/, "");
    validateGithubRepo(repo, trimmed);
    return { kind: "github", value: repo };
  }
  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    const githubRepo = parseGithubBrowserUrl(trimmed);
    if (githubRepo) return { kind: "github", value: githubRepo };
    return { kind: "url", value: trimmed };
  }
  return { kind: "registry", value: trimmed };
}

function validateGithubRepo(repo: string, original: string): void {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`github source must be 'github:owner/repo' (got ${original})`);
  }
}

function parseGithubBrowserUrl(url: string): string | null {
  const withoutScheme = url.replace(/^https?:\/\//, "");
  const parts = withoutScheme.split("/").filter(Boolean);
  const host = parts[0]?.toLowerCase();
  if (!host || !["github.com", "www.github.com"].includes(host)) return null;
  if (parts.length !== 3) return null;
  const owner = parts[1];
  const repo = parts[2];
  if (!owner || !repo) return null;
  return `${owner}/${repo.replace(/\.git$/, "")}`;
}

function skillSourceSpec(skill: RemoteSkill): string {
  if (skill.source) return skill.source;
  if (skill.spec) return skill.spec;
  if (skill.url) return skill.url;
  if (skill.repo) return skill.repo.startsWith("github:") ? skill.repo : `github:${skill.repo}`;
  return "";
}

async function fetchText(url: string, maxSizeBytes: number): Promise<string> {
  return (await fetchBinary(url, maxSizeBytes)).toString("utf-8");
}

async function fetchBinary(url: string, maxSizeBytes: number): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed for ${url}: HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxSizeBytes) throw new Error(`download exceeds max_install_size_bytes (${maxSizeBytes})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxSizeBytes) throw new Error(`download exceeds max_install_size_bytes (${maxSizeBytes})`);
  return buffer;
}

interface InstallMarker {
  source: string;
  checksum: string;
}

function readInstallMarker(dir: string): InstallMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, INSTALLED_FROM_MARKER), "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.source !== "string" || !parsed.source) return null;
    if (typeof parsed.checksum !== "string" || !parsed.checksum) return null;
    return { source: parsed.source, checksum: parsed.checksum };
  } catch {
    return null;
  }
}

function resolveHome(path: string, homeDir = process.env.HOME || "~"): string {
  if (path === "~") return resolve(homeDir);
  if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
  return resolve(path);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function maybeGunzip(buffer: Buffer): Buffer {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return gunzipSync(buffer);
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
  const parsed = parseInt(raw, 8);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid tar size: ${raw}`);
  return parsed;
}

function assertSafeArchivePath(path: string): void {
  if (!path || isAbsolute(path)) throw new Error(`entry escapes destination directory: ${path}`);
  if (path.includes("\0")) throw new Error("archive entry contains NUL byte");
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

function safeJoin(root: string, relPath: string): string {
  const out = resolve(root, relPath);
  const rootResolved = resolve(root);
  if (out !== rootResolved && !out.startsWith(rootResolved + sep)) {
    throw new Error(`entry escapes destination directory: ${relPath}`);
  }
  return out;
}
