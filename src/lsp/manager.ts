import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePathAlias } from "../tools/path-resolution.js";
import { safeSliceTextBoundary, safeTailTextBoundary, safeUtf8PrefixByBytes } from "../utils/text-boundary.js";
import { findTypeScriptLanguageServer, inferCharacter, isTypeScriptLikeFile, TypeScriptLanguageServerSession } from "./typescript-lsp.js";

const MAX_LSP_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LSP_QUERY_CHARS = 256;
const MAX_LSP_RADIUS = 20;
const MAX_LSP_TEXT_CHARS = 1000;
const MAX_LSP_LOCAL_SYMBOLS = 500;
const MAX_LSP_DEFINITION_MATCHES = 100;
const MAX_LSP_SEARCH_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LSP_WORKDIR_CHARS = 4096;
const MAX_LSP_SESSIONS = 8;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface DocumentSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "method";
  file: string;
  line: number;
  text: string;
}

export interface DefinitionMatch {
  file: string;
  line: number;
  text: string;
}

export type LspBackend = "json-rpc" | "local-fallback";

export interface LspResult<T> {
  backend: LspBackend;
  value: T;
}

export class LspManager {
  private readonly tsSessions = new Map<string, TypeScriptLanguageServerSession>();

  documentSymbols(file: string, workdir = process.cwd()): DocumentSymbol[] {
    const path = resolveLspFile(file, workdir, "return");
    if (!path) return [];
    if (!isRegularFile(path)) return [];
    if (safeFileSize(path) > MAX_LSP_FALLBACK_FILE_BYTES) return [];
    try {
      const content = readFileSync(path, "utf-8");
      return extractSymbols(content, path);
    } catch {
      return [];
    }
  }

  async documentSymbolsWithBackend(file: string, workdir = process.cwd()): Promise<LspResult<DocumentSymbol[]>> {
    const path = resolveLspFile(file, workdir);
    if (!existsSync(path)) return { backend: "local-fallback", value: [] };
    const session = this.typescriptSessionFor(path, workdir);
    if (session) {
      try {
        return { backend: "json-rpc", value: await session.documentSymbols(path) };
      } catch {
        this.dropTypescriptSession(workdir, session);
      }
    }
    return { backend: "local-fallback", value: this.documentSymbols(path, workdir) };
  }

  definition(symbol: string, workdir = process.cwd()): DefinitionMatch[] {
    const query = safeQuery(symbol);
    if (!query) return [];
    const root = logicalWorkdirRoot(workdir);
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = `(function|class|interface|type|const|let|var|async function)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(async\\s*)?(function|\\()`;
    const rg = spawnSync("rg", ["--line-number", "--no-heading", "--color", "never", "--glob", "!node_modules", "--glob", "!**/node_modules/**", "--glob", "!.git", "--glob", "!**/.git/**", "--", pattern, root], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (rg.status === 0) return parseRgMatches(rg.stdout);

    const grep = spawnSync("grep", ["-rnE", "--exclude-dir=node_modules", "--exclude-dir=.git", "--", pattern, root], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return grep.status === 0 ? parseRgMatches(grep.stdout) : [];
  }

  async definitionWithBackend(
    symbol: string,
    workdir = process.cwd(),
    position?: { file?: string; line?: number; character?: unknown },
  ): Promise<LspResult<DefinitionMatch[]>> {
    const query = safeQuery(symbol);
    if (!query) return { backend: "local-fallback", value: [] };
    const file = position?.file ? resolveLspFile(position.file, workdir) : "";
    const line = typeof position?.line === "number" && Number.isSafeInteger(position.line) && position.line > 0
      ? position.line
      : undefined;
    if (file && line !== undefined && isRegularFile(file)) {
      const session = this.typescriptSessionFor(file, workdir);
      if (session) {
        try {
          const character = inferCharacter(file, line, position?.character);
          const matches = await session.definition(file, line, character);
          if (matches.length) return { backend: "json-rpc", value: matches };
        } catch {
          this.dropTypescriptSession(workdir, session);
        }
      }
    }
    return { backend: "local-fallback", value: this.definition(query, workdir) };
  }

  hover(file: string, line: number, workdir = process.cwd(), radius = 2): string {
    const path = resolveLspFile(file, workdir, "return");
    if (!path) return `Error: file not found: ${safeText(file) || "unknown"}`;
    if (!isRegularFile(path)) return `Error: file not found: ${safeText(file) || "unknown"}`;
    if (safeFileSize(path) > MAX_LSP_FALLBACK_FILE_BYTES) return `Error: file too large for hover: ${safeText(file) || "unknown"}`;
    let lines: string[];
    try {
      lines = readFileSync(path, "utf-8").split("\n");
    } catch {
      return `Error: unable to read file: ${file}`;
    }
    const target = safeLine(line, lines.length);
    const safeRadius = safeHoverRadius(radius);
    const start = Math.max(1, target - safeRadius);
    const end = Math.min(lines.length, target + safeRadius);
    return lines.slice(start - 1, end).map((text, index) => {
      const n = start + index;
      const marker = n === target ? ">" : " ";
      return `${marker} ${n}: ${safeText(text)}`;
    }).join("\n");
  }

  async hoverWithBackend(file: string, line: number, workdir = process.cwd(), radius = 2, character?: unknown): Promise<LspResult<string>> {
    const path = resolveLspFile(file, workdir);
    if (isRegularFile(path)) {
      const session = this.typescriptSessionFor(path, workdir);
      if (session) {
        try {
          const text = await session.hover(path, line, inferCharacter(path, line, character));
          if (text) return { backend: "json-rpc", value: text };
        } catch {
          this.dropTypescriptSession(workdir, session);
        }
      }
    }
    return { backend: "local-fallback", value: this.hover(file, line, workdir, radius) };
  }

  async dispose(): Promise<void> {
    const sessions = [...this.tsSessions.values()];
    this.tsSessions.clear();
    await Promise.allSettled(sessions.map(session => session.dispose()));
  }

  private typescriptSessionFor(file: string, workdir: string): TypeScriptLanguageServerSession | null {
    if (!isTypeScriptLikeFile(file) || !isRegularFile(file)) return null;
    const root = resolveWorkdirRoot(workdir);
    const existing = this.tsSessions.get(root);
    if (existing) return existing;
    if (this.tsSessions.size >= MAX_LSP_SESSIONS) this.dropOldestTypescriptSession();
    const command = findTypeScriptLanguageServer(root);
    if (!command) return null;
    const session = new TypeScriptLanguageServerSession(root, command);
    this.tsSessions.set(root, session);
    return session;
  }

  private dropTypescriptSession(workdir: string, expected?: TypeScriptLanguageServerSession): void {
    const root = resolveWorkdirRoot(workdir);
    const session = this.tsSessions.get(root);
    if (!session || (expected && session !== expected)) return;
    this.tsSessions.delete(root);
    void session.dispose();
  }

  private dropOldestTypescriptSession(): void {
    const oldest = this.tsSessions.keys().next().value;
    if (oldest === undefined) return;
    const session = this.tsSessions.get(oldest);
    this.tsSessions.delete(oldest);
    void session?.dispose();
  }
}

let manager: LspManager | null = null;

export function getLspManager(): LspManager {
  if (!manager) manager = new LspManager();
  return manager;
}

export async function shutdownLspManager(): Promise<void> {
  const current = manager;
  manager = null;
  await current?.dispose();
}

export function clearLspManagerForTests(): void {
  void shutdownLspManager();
}

function extractSymbols(content: string, file: string): DocumentSymbol[] {
  const result: DocumentSymbol[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const trimmed = safeText(lines[index] ?? "");
    const matchers: Array<[RegExp, DocumentSymbol["kind"]]> = [
      [/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/, "function"],
      [/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, "class"],
      [/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/, "interface"],
      [/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/, "type"],
      [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, "variable"],
      [/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, "method"],
    ];
    for (const [regex, kind] of matchers) {
      const match = trimmed.match(regex);
      if (!match?.[1]) continue;
      result.push({ name: match[1], kind, file, line, text: trimmed });
      break;
    }
    if (result.length >= MAX_LSP_LOCAL_SYMBOLS) break;
  }
  return result;
}

function parseRgMatches(output: string): DefinitionMatch[] {
  const safeOutput = safeUtf8PrefixByBytes(output, MAX_LSP_SEARCH_OUTPUT_BYTES);
  return safeOutput.split("\n").filter(Boolean).slice(0, MAX_LSP_DEFINITION_MATCHES * 2).map(entry => {
    const match = entry.match(/^(.*?):(\d+):(.*)$/);
    if (!match) return null;
    const file = safePathResult(match[1]);
    const lineNumber = Number(match[2]);
    const text = match[3];
    if (!file || !Number.isSafeInteger(lineNumber) || lineNumber <= 0 || !text) return null;
    return {
      file,
      line: lineNumber,
      text: safeText(text),
    };
  }).filter((item): item is DefinitionMatch => !!item).slice(0, MAX_LSP_DEFINITION_MATCHES);
}

function resolveLspFile(file: string, workdir: string, onEscape: "throw" | "return" = "throw"): string {
  // Resolve to the caller's logical path so results are reported in the same path
  // convention the caller used (e.g. /tmp/... rather than /private/tmp/... on macOS,
  // where system directories are symlinks). Containment is still enforced via realpath
  // below so symlinks that escape the workdir are rejected.
  const logicalRoot = logicalWorkdirRoot(workdir);
  const logicalPath = resolvePathAlias(safePathInput(file), logicalRoot);
  if (!existsSync(logicalPath)) return logicalPath;
  const realRoot = resolveWorkdirRoot(workdir);
  let realPath: string;
  try {
    realPath = realpathSync(logicalPath);
  } catch {
    return onEscape === "return" ? "" : logicalPath;
  }
  if (!isInsideRoot(realPath, realRoot)) {
    if (onEscape === "return") return "";
    throw new Error(`file is outside workdir: ${file}`);
  }
  return logicalPath;
}

function logicalWorkdirRoot(workdir: string): string {
  return resolve(safePathInput(workdir) || process.cwd());
}

function resolveWorkdirRoot(workdir: string): string {
  const path = resolve(safePathInput(workdir) || process.cwd());
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

function isInsideRoot(path: string, root: string): boolean {
  try {
    const rel = relative(root, path);
    return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
  } catch {
    return false;
  }
}

function safeQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.replace(CONTROL_TEXT_RE, " ").trim();
  return safeSliceTextBoundary(trimmed, MAX_LSP_QUERY_CHARS);
}

function safeLine(value: unknown, maxLine: number): number {
  const max = Number.isSafeInteger(maxLine) && maxLine > 0 ? maxLine : 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function safeHoverRadius(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 2;
  return Math.min(Math.floor(value), MAX_LSP_RADIUS);
}

function safeText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(CONTROL_TEXT_RE, " ").trim();
  return safeSliceTextBoundary(text, MAX_LSP_TEXT_CHARS);
}

function safePathResult(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(CONTROL_TEXT_RE, " ").trim();
  return safeTailTextBoundary(text, MAX_LSP_WORKDIR_CHARS);
}

function safePathInput(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(CONTROL_TEXT_RE, " ").trim();
  return text.length > MAX_LSP_WORKDIR_CHARS ? "" : text;
}

function safeFileSize(path: string): number {
  try {
    const size = statSync(path).size;
    return Number.isSafeInteger(size) && size >= 0 ? size : Infinity;
  } catch {
    return Infinity;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
