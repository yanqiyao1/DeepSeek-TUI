/** Claude Code compatibility for markdown slash commands. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { homeDir } from "../paths.js";

export type CompatCommandScope = "project" | "user";

export interface CompatSlashCommand {
  name: string;
  description: string;
  body: string;
  sourceFile: string;
  scope: CompatCommandScope;
  argumentHint?: string;
  argumentNames: string[];
}

interface ParsedCommandDocument {
  frontmatter: Record<string, string>;
  body: string;
}

const COMMAND_CACHE = new Map<string, CompatSlashCommand[]>();

export function discoverClaudeCommands(workspacePath = process.cwd(), userHome = homeDir()): CompatSlashCommand[] {
  const key = `${resolve(workspacePath)}\0${resolve(userHome)}`;
  const cached = COMMAND_CACHE.get(key);
  if (cached) return cached;

  const commands: CompatSlashCommand[] = [];
  const seen = new Set<string>();
  for (const root of projectCommandRoots(workspacePath, userHome)) {
    addCommandRoot(commands, seen, root, "project");
  }
  addCommandRoot(commands, seen, resolve(userHome, ".claude", "commands"), "user");

  const sorted = commands.sort((a, b) => a.name.localeCompare(b.name));
  COMMAND_CACHE.set(key, sorted);
  return sorted;
}

export function clearClaudeCommandCache(): void {
  COMMAND_CACHE.clear();
}

export function findClaudeCommand(
  input: string,
  workspacePath = process.cwd(),
): { command: CompatSlashCommand; args: string } | null {
  const trimmed = input.trim();
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const name = normalizeFullCommandName(match[1]);
  if (!name) return null;
  const command = discoverClaudeCommands(workspacePath).find(item => item.name === name);
  return command ? { command, args: match[2] || "" } : null;
}

export function expandClaudeCommand(command: CompatSlashCommand, args: string): string {
  const expanded = substituteArguments(command.body, args, command.argumentNames);
  return [
    `[Claude-compatible slash command: /${command.name}]`,
    `Source: ${command.sourceFile}`,
    "",
    expanded,
  ].join("\n");
}

function projectCommandRoots(workspacePath: string, userHome = homeDir()): string[] {
  const roots: string[] = [];
  const visited = new Set<string>();
  let current = resolve(workspacePath);
  const home = resolve(userHome);
  const filesystemRoot = parse(current).root;
  while (true) {
    if (visited.has(current)) break;
    visited.add(current);
    const commands = resolve(current, ".claude", "commands");
    if (existsSync(commands)) roots.push(commands);
    if (current === filesystemRoot || current === home) break;
    if (existsSync(resolve(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function addCommandRoot(
  commands: CompatSlashCommand[],
  seen: Set<string>,
  root: string,
  scope: CompatCommandScope,
): void {
  if (!existsSync(root)) return;
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  for (const file of collectMarkdownFiles(root)) {
    const command = parseCommandFile(file, root, scope);
    if (!command || seen.has(command.name)) continue;
    seen.add(command.name);
    commands.push(command);
  }
}

function collectMarkdownFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".tmp-")) continue;
        walk(path, depth + 1);
        continue;
      }
      if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(path);
    }
  };
  walk(root, 0);
  return found.sort();
}

function parseCommandFile(file: string, root: string, scope: CompatCommandScope): CompatSlashCommand | null {
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = parseCommandDocument(raw);
    const scopedName = commandNameFromPath(file, root, scope);
    if (!scopedName) return null;
    const description = parsed.frontmatter.description
      || firstHeading(parsed.body)
      || `${scope} Claude-compatible command`;
    const argumentHint = parsed.frontmatter["argument-hint"];
    return {
      name: scopedName,
      description,
      body: parsed.body.trim(),
      sourceFile: file,
      scope,
      ...(argumentHint ? { argumentHint } : {}),
      argumentNames: parseArgumentNames(parsed.frontmatter.arguments),
    };
  } catch {
    return null;
  }
}

function commandNameFromPath(file: string, root: string, scope: CompatCommandScope): string | null {
  const relativePath = relative(root, file).replace(/\\/g, "/").replace(/\.md$/i, "");
  const parts = relativePath.split("/").map(normalizeCommandName).filter(Boolean);
  if (!parts.length) return null;
  return `${scope}:${parts.join(":")}`;
}

function parseCommandDocument(raw: string): ParsedCommandDocument {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatterText = match[1] ?? "";
  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}

function substituteArguments(content: string, args: string, argumentNames: string[]): string {
  const parsed = parseArguments(args);
  let next = content;
  for (let index = 0; index < argumentNames.length; index++) {
    const name = argumentNames[index];
    if (!name) continue;
    next = next.replace(new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, "g"), parsed[index] ?? "");
  }
  next = next.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => parsed[Number(index)] ?? "");
  next = next.replace(/\$(\d+)(?!\w)/g, (_match, index: string) => parsed[Number(index)] ?? "");
  next = next.replaceAll("$ARGUMENTS", args);
  if (next === content && args.trim()) next = `${next.trimEnd()}\n\nARGUMENTS: ${args}`;
  return next;
}

function parseArguments(args: string): string[] {
  const values: string[] = [];
  for (const match of args.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g)) {
    values.push((match[1] || match[2] || match[3] || "").replace(/\\"/g, "\""));
  }
  return values;
}

function parseArgumentNames(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).map(normalizeCommandName).filter(name => !!name && !/^\d+$/.test(name));
}

function normalizeFullCommandName(value: string | undefined): string {
  return (value || "").split(":").map(normalizeCommandName).filter(Boolean).join(":");
}

function firstHeading(body: string): string | null {
  const match = body.match(/^\s*#{1,6}\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function normalizeCommandName(value: string | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
