import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePathAlias } from "../tools/path-resolution.js";
import { findTypeScriptLanguageServer, inferCharacter, isTypeScriptLikeFile, TypeScriptLanguageServerSession } from "./typescript-lsp.js";

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
    const path = resolveLspFile(file, workdir);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf-8");
    return extractSymbols(content, path);
  }

  async documentSymbolsWithBackend(file: string, workdir = process.cwd()): Promise<LspResult<DocumentSymbol[]>> {
    const path = resolveLspFile(file, workdir);
    if (!existsSync(path)) return { backend: "local-fallback", value: [] };
    const session = this.typescriptSessionFor(path, workdir);
    if (session) {
      try {
        return { backend: "json-rpc", value: await session.documentSymbols(path) };
      } catch {
        this.dropTypescriptSession(workdir);
      }
    }
    return { backend: "local-fallback", value: this.documentSymbols(path, workdir) };
  }

  definition(symbol: string, workdir = process.cwd()): DefinitionMatch[] {
    const query = symbol.trim();
    if (!query) return [];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = `(function|class|interface|type|const|let|var|async function)\\s+${escaped}\\b|${escaped}\\s*[:=]\\s*(async\\s*)?(function|\\()`;
    const rg = spawnSync("rg", ["--line-number", "--no-heading", "--color", "never", "--glob", "!node_modules", "--glob", "!.git", "--", pattern, resolve(workdir)], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (rg.status === 0) return parseRgMatches(rg.stdout);

    const grep = spawnSync("grep", ["-rnE", pattern, resolve(workdir)], {
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
    const query = symbol.trim();
    if (!query) return { backend: "local-fallback", value: [] };
    const file = position?.file ? resolveLspFile(position.file, workdir) : "";
    const line = Number.isSafeInteger(position?.line) && position!.line! > 0 ? position!.line! : undefined;
    if (file && line !== undefined && existsSync(file)) {
      const session = this.typescriptSessionFor(file, workdir);
      if (session) {
        try {
          const character = inferCharacter(file, line, position?.character);
          const matches = await session.definition(file, line, character);
          if (matches.length) return { backend: "json-rpc", value: matches };
        } catch {
          this.dropTypescriptSession(workdir);
        }
      }
    }
    return { backend: "local-fallback", value: this.definition(query, workdir) };
  }

  hover(file: string, line: number, workdir = process.cwd(), radius = 2): string {
    const path = resolveLspFile(file, workdir);
    if (!existsSync(path)) return `Error: file not found: ${file}`;
    const lines = readFileSync(path, "utf-8").split("\n");
    const target = Math.max(1, Math.min(Math.floor(line), lines.length));
    const start = Math.max(1, target - radius);
    const end = Math.min(lines.length, target + radius);
    return lines.slice(start - 1, end).map((text, index) => {
      const n = start + index;
      const marker = n === target ? ">" : " ";
      return `${marker} ${n}: ${text}`;
    }).join("\n");
  }

  async hoverWithBackend(file: string, line: number, workdir = process.cwd(), radius = 2, character?: unknown): Promise<LspResult<string>> {
    const path = resolveLspFile(file, workdir);
    if (existsSync(path)) {
      const session = this.typescriptSessionFor(path, workdir);
      if (session) {
        try {
          const text = await session.hover(path, line, inferCharacter(path, line, character));
          if (text) return { backend: "json-rpc", value: text };
        } catch {
          this.dropTypescriptSession(workdir);
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
    if (!isTypeScriptLikeFile(file)) return null;
    const root = resolve(workdir);
    const existing = this.tsSessions.get(root);
    if (existing) return existing;
    const command = findTypeScriptLanguageServer(root);
    if (!command) return null;
    const session = new TypeScriptLanguageServerSession(root, command);
    this.tsSessions.set(root, session);
    return session;
  }

  private dropTypescriptSession(workdir: string): void {
    const root = resolve(workdir);
    const session = this.tsSessions.get(root);
    if (!session) return;
    this.tsSessions.delete(root);
    void session.dispose();
  }
}

let manager: LspManager | null = null;

export function getLspManager(): LspManager {
  if (!manager) manager = new LspManager();
  return manager;
}

export function clearLspManagerForTests(): void {
  void manager?.dispose();
  manager = null;
}

function extractSymbols(content: string, file: string): DocumentSymbol[] {
  const result: DocumentSymbol[] = [];
  const lines = content.split("\n");
  lines.forEach((text, index) => {
    const line = index + 1;
    const trimmed = text.trim();
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
  });
  return result;
}

function parseRgMatches(output: string): DefinitionMatch[] {
  return output.split("\n").filter(Boolean).slice(0, 100).map(line => {
    const match = line.match(/^(.*?):(\d+):(.*)$/);
    if (!match) return null;
    return {
      file: match[1] || basename(line),
      line: Number(match[2]),
      text: match[3]?.trim() || "",
    };
  }).filter((item): item is DefinitionMatch => !!item);
}

function resolveLspFile(file: string, workdir: string): string {
  const root = realpathSync(resolve(workdir));
  const path = resolvePathAlias(file, root);
  if (!existsSync(path)) return path;
  const realPath = realpathSync(path);
  if (!isInsideRoot(realPath, root)) {
    throw new Error(`file is outside workdir: ${file}`);
  }
  return realPath;
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
}
