/** Project instruction files — hierarchical project context injection.
 *
 * Adopted from OpenAI Codex: reads AGENTS.md from the workspace root and
 * parent directories (up to filesystem boundary or ~). For migration from
 * Claude Code, it also reads CLAUDE.md and .claude/CLAUDE.md when present.
 */

import { lstatSync, existsSync } from "node:fs";
import { resolve, dirname, parse } from "node:path";
import { homeDir } from "../paths.js";
import { readBoundedRegularFileSync } from "../utils/safe-file.js";

export interface AgentsMdResult {
  content: string;
  sourceFiles: string[];
}

interface InstructionSegment {
  label: string;
  path: string;
  content: string;
}

const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;

/**
 * Read project instruction files hierarchically from cwd up to a boundary.
 *
 * Strategy:
 * 1. Start at cwd, walk up directory tree
 * 2. Read AGENTS.md and Claude-compatible instruction files at each level
 * 3. Stop at filesystem root, home directory, or .git boundary
 * 4. Child directories override parent (more specific wins)
 * 5. Aggregate into a single context block
 */
export function readAgentsMd(cwd: string = process.cwd()): AgentsMdResult {
  const segments: InstructionSegment[] = [];
  let current = resolve(cwd);
  const home = resolve(homeDir());
  const root = parse(current).root;

  const visited = new Set<string>();
  const addDirectoryInstructions = (dir: string) => {
    const found: InstructionSegment[] = [];
    for (const candidate of [
      { label: "AGENTS.md", path: resolve(dir, "AGENTS.md") },
      { label: "CLAUDE.md", path: resolve(dir, "CLAUDE.md") },
      { label: ".claude/CLAUDE.md", path: resolve(dir, ".claude", "CLAUDE.md") },
    ]) {
      if (!existsSync(candidate.path) || visited.has(candidate.path)) continue;
      visited.add(candidate.path);
      try {
        if (!isSafeInstructionFile(candidate.path, dir)) continue;
        const content = readBoundedRegularFileSync(candidate.path, MAX_INSTRUCTION_FILE_BYTES, "project instruction file").trim();
        if (content) found.push({ ...candidate, content });
      } catch {
        // Skip unreadable files
      }
    }
    if (found.length) segments.unshift(...found);
  };

  while (true) {
    if (visited.has(current)) break;
    visited.add(current);

    addDirectoryInstructions(current);

    // Stop conditions
    if (current === root) break;
    if (current === home) break;

    // Stop at .git boundary (project root)
    if (existsSync(resolve(current, ".git"))) {
      // Read this level's AGENTS.md but don't go further up
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      // Check one level above .git for monorepo scenarios
      addDirectoryInstructions(current);
      break;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const content = segments.length > 0
    ? `${instructionHeading(segments)}\n\n${formatInstructionSegments(segments)}`
    : "";

  return { content, sourceFiles: segments.map(segment => segment.path) };
}

function isSafeInstructionFile(path: string, boundary: string): boolean {
  const stop = resolve(boundary);
  let current = resolve(path);
  try {
    while (current !== stop) {
      const stat = lstatSync(current);
      if (current === resolve(path)) {
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INSTRUCTION_FILE_BYTES) return false;
      } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return false;
      }
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
    const boundaryStat = lstatSync(stop);
    return !boundaryStat.isSymbolicLink() && boundaryStat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Inject AGENTS.md content into the system prompt if found.
 */
export function injectAgentsMd(systemPrompt: string, cwd?: string): string {
  const result = readAgentsMd(cwd);
  const { content, sourceFiles } = result;

  if (!content || sourceFiles.length === 0) {
    return systemPrompt;
  }

  const injection = [
    content,
    `\n_Source: ${sourceFiles.join(", ")}_`,
    `\n${followInstructionText(result)}`,
  ].join("\n");

  return systemPrompt + "\n\n" + injection;
}

export function followInstructionText(result: AgentsMdResult): string {
  const hasClaude = result.sourceFiles.some(source => /(^|[/\\])(?:CLAUDE\.md|\.claude[/\\]CLAUDE\.md)$/i.test(source));
  const hasAgents = result.sourceFiles.some(source => /(^|[/\\])AGENTS\.md$/i.test(source));
  if (hasAgents && !hasClaude) {
    return "Follow any project-specific conventions, guidelines, and instructions from AGENTS.md above. These instructions supplement, and may override, the default agent behavior.";
  }
  if (hasClaude && !hasAgents) {
    return "Follow the Claude-compatible project instructions above when they apply. Treat them as migration compatibility context for Seek Code, not as a change to Seek's tool or safety rules.";
  }
  return "Follow the project-specific instructions above when they apply. AGENTS.md remains Seek's native convention; Claude-compatible files are included to ease migration and do not change Seek's tool or safety rules.";
}

function instructionHeading(segments: InstructionSegment[]): string {
  const labels = new Set(segments.map(segment => segment.label));
  if (labels.size === 1 && labels.has("AGENTS.md")) return "## Project Context (AGENTS.md)";
  if (labels.has("AGENTS.md")) return "## Project Context (AGENTS.md + Claude compatibility)";
  return "## Claude Compatibility Context (CLAUDE.md)";
}

function formatInstructionSegments(segments: InstructionSegment[]): string {
  const labels = new Set(segments.map(segment => segment.label));
  if (labels.size === 1 && labels.has("AGENTS.md")) {
    return segments.map(segment => segment.content).join("\n\n---\n\n");
  }
  return segments
    .map(segment => `### ${segment.label}\n\n${segment.content}`)
    .join("\n\n---\n\n");
}
