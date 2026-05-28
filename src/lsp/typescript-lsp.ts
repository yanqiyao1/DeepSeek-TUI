import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonRpcProcessClient } from "./json-rpc.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";
import type { DefinitionMatch, DocumentSymbol } from "./manager.js";

export interface LanguageServerCommand {
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

const MAX_LSP_OPEN_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LSP_SYMBOLS = 500;
const MAX_LSP_SYMBOL_DEPTH = 20;
const MAX_LSP_DEFINITIONS = 100;
const MAX_LSP_TEXT_CHARS = 1000;
const MAX_LSP_HOVER_CHARS = 8000;
const MAX_LSP_HOVER_PARTS = 50;
const MAX_LSP_ARG_COUNT = 64;
const MAX_LSP_ARG_CHARS = 4096;
const MAX_LSP_OPEN_FILES = 128;
const MAX_LSP_ENV_CHARS = 16_384;
const MAX_LSP_ENV_ENTRIES = 512;
const MAX_LSP_URI_CHARS = 4096;
const MAX_LSP_INLINE_TEXT_CHARS = 1000;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CONTROL_TEXT_PRESENT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SAFE_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

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
    return lspSymbolsToDocumentSymbols(raw, path, this.workdir);
  }

  async definition(file: string, line: number, character: number): Promise<DefinitionMatch[]> {
    const path = resolve(file);
    await this.ensureOpen(path);
    const position = safeLspPosition(line, character);
    const raw = await this.client.request<unknown>("textDocument/definition", {
      textDocument: { uri: pathToFileURL(path).toString() },
      position,
    });
    return lspDefinitionsToMatches(raw, this.workdir);
  }

  async hover(file: string, line: number, character: number): Promise<string> {
    const path = resolve(file);
    await this.ensureOpen(path);
    const position = safeLspPosition(line, character);
    const raw = await this.client.request<unknown>("textDocument/hover", {
      textDocument: { uri: pathToFileURL(path).toString() },
      position,
    });
    return lspHoverToText(raw);
  }

  async dispose(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // Disposing a failed language server is best-effort.
    }
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
    if (this.opened.size >= MAX_LSP_OPEN_FILES) {
      throw new Error(`too many files opened in TypeScript language server session (${MAX_LSP_OPEN_FILES})`);
    }
    const stat = statSync(file);
    if (!stat.isFile()) {
      throw new Error(`not a regular file for LSP open: ${file}`);
    }
    const size = stat.size;
    if (!Number.isSafeInteger(size) || size > MAX_LSP_OPEN_FILE_BYTES) {
      throw new Error(`file too large for LSP open: ${file}`);
    }
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
  const explicit = safeEnvString(safeProperty(env, "SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER")) || safeEnvString(safeProperty(env, "DEEPSEEK_TYPESCRIPT_LANGUAGE_SERVER"));
  if (explicit) {
    const argString = safeEnvString(safeProperty(env, "SEEKCODE_TYPESCRIPT_LANGUAGE_SERVER_ARGS")) || safeEnvString(safeProperty(env, "DEEPSEEK_TYPESCRIPT_LANGUAGE_SERVER_ARGS")) || "--stdio";
    return {
      command: explicit,
      args: splitArgs(argString),
      source: "env",
    };
  }

  const local = findLocalBin(workdir, "typescript-language-server");
  if (local) return { command: local, args: ["--stdio"], source: "local" };

  const pathLookup = spawnSync("typescript-language-server", ["--version"], {
    encoding: "utf-8",
    env: sanitizeProcessEnv(env),
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
  if (safeFileSize(file) > MAX_LSP_OPEN_FILE_BYTES) return 0;
  try {
    const lines = readFileSync(file, "utf-8").split("\n");
    const safeLine = safeOneBasedLine(line, lines.length);
    const text = lines[safeLine - 1] || "";
    const match = text.match(/\S/);
    return match?.index ?? 0;
  } catch {
    return 0;
  }
}

function lspSymbolsToDocumentSymbols(raw: unknown, file: string, workdir: string): DocumentSymbol[] {
  if (!Array.isArray(raw)) return [];
  const symbols: DocumentSymbol[] = [];
  for (const item of raw.slice(0, MAX_LSP_SYMBOLS * 2)) {
    try {
      appendSymbol(symbols, item, file, workdir, 0);
    } catch {
      // Skip hostile LSP result objects while preserving subsequent symbols.
    }
    if (symbols.length >= MAX_LSP_SYMBOLS) break;
  }
  return symbols;
}

function appendSymbol(symbols: DocumentSymbol[], item: unknown, fallbackFile: string, workdir: string, depth: number): void {
  if (symbols.length >= MAX_LSP_SYMBOLS || depth > MAX_LSP_SYMBOL_DEPTH) return;
  if (!isRecord(item)) return;
  const rawName = safeProperty(item, "name");
  const rawKind = safeProperty(item, "kind");
  if (typeof rawName !== "string" || typeof rawKind !== "number" || !Number.isFinite(rawKind)) return;
  const name = safeLspText(rawName, MAX_LSP_TEXT_CHARS);
  if (!name) return;
  const location = safeProperty(item, "location");
  const range = safeRange(safeProperty(item, "selectionRange")) || safeRange(safeProperty(item, "range")) || safeRange(safeProperty(location, "range"));
  const uri = safeProperty(location, "uri") || fallbackFile;
  if (!safeUriText(uri)) return;
  const file = uriToPath(uri);
  if (!isPathInsideWorkdir(file, workdir)) return;
  symbols.push({
    name,
    kind: symbolKindName(rawKind),
    file,
    line: lineFromRangeStart(safeProperty(range, "start")),
    text: name,
  });
  const children = safeProperty(item, "children");
  if (Array.isArray(children)) {
    for (const child of children.slice(0, MAX_LSP_SYMBOLS)) appendSymbol(symbols, child, fallbackFile, workdir, depth + 1);
  }
}

function lspDefinitionsToMatches(raw: unknown, workdir: string): DefinitionMatch[] {
  const values = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const matches: DefinitionMatch[] = [];
  for (const value of values.slice(0, MAX_LSP_DEFINITIONS * 2)) {
    try {
      if (!isRecord(value)) continue;
      const uri = safeProperty(value, "targetUri") || safeProperty(value, "uri");
      const range = safeRange(safeProperty(value, "targetRange")) || safeRange(safeProperty(value, "range"));
      const start = safeProperty(range, "start");
      if (!safeUriText(uri) || !start) continue;
      const file = uriToPath(uri);
      if (!isPathInsideWorkdir(file, workdir)) continue;
      const line = lineFromRangeStart(start);
      const inlineText = safeProperty(value, "lineText") || safeProperty(value, "line");
      matches.push({
        file,
        line,
        text: safeLspText(typeof inlineText === "string" ? inlineText : readLine(file, line), MAX_LSP_INLINE_TEXT_CHARS),
      });
    } catch {
      continue;
    }
    if (matches.length >= MAX_LSP_DEFINITIONS) break;
  }
  return matches;
}

function lspHoverToText(raw: unknown): string {
  if (!isRecord(raw)) return "";
  return safeLspText(hoverContentToText(safeProperty(raw, "contents")), MAX_LSP_HOVER_CHARS);
}

function hoverContentToText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return safeLspText(content, MAX_LSP_HOVER_CHARS);
  if (Array.isArray(content)) return content.slice(0, MAX_LSP_HOVER_PARTS).map(hoverContentToText).filter(Boolean).join("\n\n");
  const value = safeProperty(content, "value");
  if (isRecord(content) && typeof value === "string") return safeLspText(value, MAX_LSP_HOVER_CHARS);
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
  if (uri.length > MAX_LSP_URI_CHARS || CONTROL_TEXT_PRESENT_RE.test(uri)) return "";
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
    if (safeFileSize(file) > MAX_LSP_OPEN_FILE_BYTES) return "";
    const lines = readFileSync(file, "utf-8").split("\n");
    const safeLine = safeOneBasedLine(line, lines.length);
    return safeLspText((lines[safeLine - 1] || "").trim(), MAX_LSP_TEXT_CHARS);
  } catch {
    return "";
  }
}

function safeLspPosition(line: number, character: number): LspPosition {
  return {
    line: Math.max(0, safeOneBasedLine(line) - 1),
    character: safeZeroBasedCharacter(character),
  };
}

function safeOneBasedLine(value: unknown, maxLine = Number.MAX_SAFE_INTEGER): number {
  const line = typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 1;
  const max = Number.isSafeInteger(maxLine) && maxLine > 0 ? maxLine : Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.min(line, max));
}

function safeZeroBasedCharacter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 1_000_000)
    : 0;
}

function lineFromRangeStart(start: unknown): number {
  const rawLine = safeProperty(start, "line");
  const line = typeof rawLine === "number" && Number.isSafeInteger(rawLine) && rawLine >= 0
    && rawLine < Number.MAX_SAFE_INTEGER
    ? rawLine + 1
    : 1;
  return line;
}

function safeRange(value: unknown): LspRange | undefined {
  if (!isRecord(value) || !isRecord(safeProperty(value, "start"))) return undefined;
  return value as unknown as LspRange;
}

function safeUriText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_LSP_URI_CHARS
    && !CONTROL_TEXT_PRESENT_RE.test(value);
}

function isPathInsideWorkdir(path: string, workdir: string): boolean {
  if (!path) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && !path.startsWith("file:")) return false;
  try {
    const root = canonicalPath(workdir);
    const resolved = canonicalPath(path);
    const rel = relative(root, resolved);
    return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
  } catch {
    return false;
  }
}

function canonicalPath(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : resolve(path);
  } catch {
    return resolve(path);
  }
}

function findLocalBin(workdir: string, name: string): string | null {
  let current = resolve(workdir);
  const seen = new Set<string>();
  while (true) {
    const realCurrent = canonicalPath(current);
    if (seen.has(realCurrent)) break;
    seen.add(realCurrent);
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
    .map(item => safeEnvText(item.replace(/^["']|["']$/g, ""), MAX_LSP_ARG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LSP_ARG_COUNT);
}

function safeEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.includes("\0")) return undefined;
  const trimmed = safeEnvText(value, MAX_LSP_ENV_CHARS);
  return trimmed || undefined;
}

function sanitizeProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  let entries = 0;
  for (const [key, value] of safeObjectEntries(env)) {
    if (entries >= MAX_LSP_ENV_ENTRIES) break;
    if (!SAFE_ENV_KEY_RE.test(key)) continue;
    const safeValue = safeEnvText(value, MAX_LSP_ENV_CHARS);
    if (!safeValue) continue;
    sanitized[key] = safeValue;
    entries++;
  }
  return sanitized;
}

function safeFileSize(path: string): number {
  try {
    const size = statSync(path).size;
    return Number.isSafeInteger(size) && size >= 0 ? size : Infinity;
  } catch {
    return Infinity;
  }
}

function safeLspText(value: string, maxChars: number): string {
  const normalized = value.replace(CONTROL_TEXT_RE, " ").trim();
  return safeSliceTextBoundary(normalized, maxChars);
}

function safeEnvText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  if (value.includes("\0")) return "";
  const trimmed = value.replace(CONTROL_TEXT_RE, " ").trim();
  return trimmed && trimmed.length <= maxChars ? trimmed : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeObjectEntries(value: unknown): Array<[string, unknown]> {
  if (!value || typeof value !== "object") return [];
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: Array<[string, unknown]> = [];
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if ("value" in descriptor) {
        entries.push([key, descriptor.value]);
        continue;
      }
      if (typeof descriptor.get !== "function") continue;
      try {
        entries.push([key, descriptor.get.call(value)]);
      } catch {
        // Ignore hostile process.env accessors supplied by tests or wrappers.
      }
    }
    return entries;
  } catch {
    try {
      return Object.entries(value as Record<string, unknown>);
    } catch {
      return [];
    }
  }
}
