import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonRpcProcessClient } from "./json-rpc.js";
import type { DefinitionMatch, DocumentSymbol } from "./manager.js";

interface LanguageServerCommand {
  command: string;
  args: string[];
  source: "env" | "local" | "path";
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end?: LspPosition;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
}

interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
}

interface LspSymbolInformation {
  name: string;
  kind: number;
  location?: LspLocation;
}

interface LspMarkupContent {
  kind: string;
  value: string;
}

type LspHoverContent = string | LspMarkupContent | Array<string | LspMarkupContent>;

interface LspHover {
  contents?: LspHoverContent;
}

export class TypeScriptLanguageServerSession {
  private readonly client: JsonRpcProcessClient;
  private readonly opened = new Set<string>();
  private initialized?: Promise<void>;

  constructor(private readonly workdir: string, command: LanguageServerCommand) {
    this.client = new JsonRpcProcessClient(command.command, command.args, workdir);
  }

  async documentSymbols(file: string): Promise<DocumentSymbol[]> {
    const path = resolve(file);
    await this.ensureOpen(path);
    const raw = await this.client.request<unknown>("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(path).toString() },
    });
    return lspSymbolsToDocumentSymbols(raw, path);
  }

  async definition(file: string, line: number, character: number): Promise<DefinitionMatch[]> {
    const path = resolve(file);
    await this.ensureOpen(path);
    const raw = await this.client.request<unknown>("textDocument/definition", {
      textDocument: { uri: pathToFileURL(path).toString() },
      position: { line: Math.max(0, Math.floor(line) - 1), character: Math.max(0, Math.floor(character)) },
    });
    return lspDefinitionsToMatches(raw);
  }

  async hover(file: string, line: number, character: number): Promise<string> {
    const path = resolve(file);
    await this.ensureOpen(path);
    const raw = await this.client.request<unknown>("textDocument/hover", {
      textDocument: { uri: pathToFileURL(path).toString() },
      position: { line: Math.max(0, Math.floor(line) - 1), character: Math.max(0, Math.floor(character)) },
    });
    return lspHoverToText(raw);
  }

  async dispose(): Promise<void> {
    await this.client.close();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.client.request("initialize", {
          processId: process.pid,
          rootUri: pathToFileURL(this.workdir).toString(),
          workspaceFolders: [{ uri: pathToFileURL(this.workdir).toString(), name: basename(this.workdir) || "workspace" }],
          capabilities: {
            textDocument: {
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              definition: {},
              hover: { contentFormat: ["markdown", "plaintext"] },
            },
            workspace: { workspaceFolders: true },
          },
        });
        this.client.notify("initialized", {});
      })();
    }
    return this.initialized;
  }

  private async ensureOpen(file: string): Promise<void> {
    await this.ensureInitialized();
    if (this.opened.has(file)) return;
    const text = readFileSync(file, "utf-8");
    this.client.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(file).toString(),
        languageId: languageIdForFile(file),
        version: 1,
        text,
      },
    });
    this.opened.add(file);
  }
}

export function findTypeScriptLanguageServer(workdir: string, env: NodeJS.ProcessEnv = process.env): LanguageServerCommand | null {
  const explicit = env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER || env.DEEPSEEK_TYPESCRIPT_LANGUAGE_SERVER;
  if (explicit) {
    return {
      command: explicit,
      args: splitArgs(env.SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS || env.DEEPSEEK_TYPESCRIPT_LANGUAGE_SERVER_ARGS || "--stdio"),
      source: "env",
    };
  }

  const local = findLocalBin(workdir, "typescript-language-server");
  if (local) return { command: local, args: ["--stdio"], source: "local" };

  const pathLookup = spawnSync("typescript-language-server", ["--version"], {
    encoding: "utf-8",
    timeout: 1_000,
    maxBuffer: 128 * 1024,
  });
  if (!pathLookup.error) return { command: "typescript-language-server", args: ["--stdio"], source: "path" };
  return null;
}

export function isTypeScriptLikeFile(file: string): boolean {
  return /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i.test(file);
}

export function inferCharacter(file: string, line: number, explicit?: unknown): number {
  if (typeof explicit === "number" && Number.isSafeInteger(explicit)) return Math.max(0, explicit > 0 ? explicit - 1 : explicit);
  if (typeof explicit === "string" && /^[-+]?\d+$/.test(explicit.trim())) {
    const numeric = Number(explicit.trim());
    if (!Number.isSafeInteger(numeric)) return 0;
    return Math.max(0, Math.floor(numeric > 0 ? numeric - 1 : numeric));
  }
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, "utf-8").split("\n");
  const text = lines[Math.max(0, Math.min(lines.length - 1, Math.floor(line) - 1))] || "";
  const match = text.match(/\S/);
  return match?.index ?? 0;
}

function lspSymbolsToDocumentSymbols(raw: unknown, file: string): DocumentSymbol[] {
  if (!Array.isArray(raw)) return [];
  const symbols: DocumentSymbol[] = [];
  for (const item of raw) appendSymbol(symbols, item, file);
  return symbols;
}

function appendSymbol(symbols: DocumentSymbol[], item: unknown, fallbackFile: string): void {
  if (!isRecord(item) || typeof item.name !== "string" || typeof item.kind !== "number") return;
  const documentSymbol = item as Partial<LspDocumentSymbol>;
  const infoSymbol = item as Partial<LspSymbolInformation>;
  const range = documentSymbol.selectionRange || documentSymbol.range || infoSymbol.location?.range;
  const uri = infoSymbol.location?.uri || fallbackFile;
  symbols.push({
    name: item.name,
    kind: symbolKindName(item.kind),
    file: uriToPath(uri),
    line: (range?.start?.line ?? 0) + 1,
    text: item.name,
  });
  if (Array.isArray(documentSymbol.children)) {
    for (const child of documentSymbol.children) appendSymbol(symbols, child, fallbackFile);
  }
}

function lspDefinitionsToMatches(raw: unknown): DefinitionMatch[] {
  const values = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return values.map(value => {
    if (!isRecord(value)) return null;
    const link = value as Partial<LspLocationLink>;
    const location = value as Partial<LspLocation>;
    const uri = link.targetUri || location.uri;
    const range = link.targetRange || location.range;
    if (!uri || !range?.start) return null;
    const file = uriToPath(uri);
    return {
      file,
      line: range.start.line + 1,
      text: readLine(file, range.start.line + 1),
    };
  }).filter((item): item is DefinitionMatch => Boolean(item));
}

function lspHoverToText(raw: unknown): string {
  if (!isRecord(raw)) return "";
  const hover = raw as LspHover;
  return hoverContentToText(hover.contents).trim();
}

function hoverContentToText(content: LspHoverContent | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(hoverContentToText).filter(Boolean).join("\n\n");
  if (isRecord(content) && typeof content.value === "string") return content.value;
  return "";
}

function symbolKindName(kind: number): DocumentSymbol["kind"] {
  if (kind === 5) return "class";
  if (kind === 6) return "method";
  if (kind === 11) return "interface";
  if (kind === 12) return "function";
  if (kind === 13 || kind === 14) return "variable";
  if (kind === 26) return "type";
  return "variable";
}

function languageIdForFile(file: string): string {
  if (/\.tsx$/i.test(file)) return "typescriptreact";
  if (/\.jsx$/i.test(file)) return "javascriptreact";
  if (/\.(js|mjs|cjs)$/i.test(file)) return "javascript";
  return "typescript";
}

function uriToPath(uri: string): string {
  if (uri.startsWith("file:")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }
  return uri;
}

function readLine(file: string, line: number): string {
  try {
    const lines = readFileSync(file, "utf-8").split("\n");
    return (lines[line - 1] || "").trim();
  } catch {
    return "";
  }
}

function findLocalBin(workdir: string, name: string): string | null {
  let current = resolve(workdir);
  while (true) {
    const candidate = join(current, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
    if (isExecutableFile(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function splitArgs(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map(item => item.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
