/** Pure rendering functions — return strings, no side effects.
 *
 * Design principles:
 * - Every function returns a string, never writes to stdout
 * - Consistent palette from palette.ts
 * - Box-drawing for structured elements only
 * - Simple, predictable output
 */

import { p, box } from "./palette.js";
import { fitAnsi, stripAnsi, truncateAnsi, visibleLength, wrapAnsi } from "./ansi.js";
import { renderMarkdown, thinkingMarkdownStyle } from "./markdown.js";

const MAX_STATUS_TEXT_CHARS = 500;
const MAX_RENDER_TEXT_CHARS = 200_000;
const MAX_RENDER_LINE_CHARS = 20_000;
const MAX_APPROVAL_ARG_COUNT = 24;
const MAX_APPROVAL_ARG_CHARS = 2_000;
const MAX_TOOL_PREVIEW_CHARS = 20_000;
const MAX_DIFF_PREVIEW_CHARS = 200_000;
const MAX_SUMMARY_CHARS = 40_000;
const CONTROL_TEXT_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const w = () => safeTerminalWidth(process.stdout.columns);

// ── Welcome Banner ───────────────────────────────────────────

export function welcomeBanner(version: string, model: string, mode: string, toolCount: number): string {
  const width = Math.max(36, Math.min(w() - 4, 64));
  const top = p.dim(box.tl + box.h.repeat(width - 2) + box.tr);
  const bottom = p.dim(box.bl + box.h.repeat(width - 2) + box.br);
  const v = p.dim(box.v);

  const modeColor = mode === "plan" ? p.modePlan : mode === "yolo" ? p.modeYolo : p.modeAgent;

  void toolCount;

  const innerWidth = width - 2;
  const row = (content = "") => `${v}${fitAnsi(content, innerWidth)}${v}`;
  const centered = (content = "") => {
    const pad = Math.max(0, Math.floor((innerWidth - visibleLength(content)) / 2));
    return row(" ".repeat(pad) + content);
  };

  const rows = [
    centered(p.blueBold("Seek Code")),
    centered(p.dim("v" + version)),
    row(),
    centered(p.blue("     /\\_____/\\     ")),
    centered(p.blue("    /  o   o  \\    ")),
    centered(p.blue("   ( ==  ^  == )   ")),
    centered(p.blue("    )         (    ")),
    centered(p.blue("   (           )   ")),
    centered(p.blue("  ( (  )   (  ) )  ")),
    row(),
    centered(`${p.text(model)} · ${modeColor(mode)}`),
  ];

  return `${top}\n${rows.join("\n")}\n${bottom}`;
}

// ── Thinking ─────────────────────────────────────────────────

export function thinkingStatusLine(elapsedMs?: number, interruptHint = false): string {
  const elapsed = elapsedMs !== undefined ? ` ${formatElapsed(elapsedMs)}` : "";
  const hint = interruptHint ? " · esc to interrupt" : "";
  return p.thinking(`  💭 Thinking${elapsed}${hint}`);
}

export function thinkingHeader(elapsedMs?: number, interruptHint = false): string {
  return `\n${thinkingStatusLine(elapsedMs, interruptHint)}`;
}

export function thinkingText(text: string): string {
  const prefix = "  ";
  const contentWidth = Math.max(1, w() - visibleLength(prefix));
  const rendered = renderMarkdown(safeRenderText(text).trimEnd(), { style: thinkingMarkdownStyle });
  const lines = rendered.split("\n").flatMap(line => wrapAnsi(line, contentWidth));
  return lines.map(line => prefix + line).join("\n");
}

// ── User Messages ───────────────────────────────────────────

export function userMessageBlock(text: string): string {
  const lines = safeRenderText(text).split("\n");
  const firstPrefix = `${p.blue("›")} `;
  const continuationPrefix = `${p.dim(box.v)} `;
  return "\n" + lines.map((line, index) => {
    const prefix = index === 0 ? firstPrefix : continuationPrefix;
    return `${prefix}${p.text(line)}`;
  }).join("\n");
}

// ── Tool Calls ───────────────────────────────────────────────

export function toolCallLine(name: string): string {
  return `\n  ${p.toolName("⚙ " + safeRenderLine(name, 120))} `;
}

export function toolCallStatus(name: string, status: "running" | "success" | "error" | "denied", preview?: string): string {
  const icon = status === "running" ? "⠋" : status === "success" ? "✓" : status === "denied" ? "⊘" : "✗";
  const color = status === "success" ? p.success : status === "running" ? p.toolName : status === "denied" ? p.warning : p.error;
  const suffix = preview ? `  ${p.dim(truncateAnsi(safeRenderLine(preview, MAX_TOOL_PREVIEW_CHARS).replace(/\s+/g, " ").trim(), 90))}` : "";
  return `  ${color(icon)} ${p.toolName(safeRenderLine(name, 120))}${suffix}`;
}

export function toolSuccess(): string {
  return p.success("✓");
}

export function toolResultPreview(text: string, maxLen = 300): string {
  const preview = safeRenderText(text, MAX_TOOL_PREVIEW_CHARS).trimEnd().split("\n").slice(0, 5).join("\n");
  const safeMaxLen = safePreviewCharLimit(maxLen, 300, MAX_TOOL_PREVIEW_CHARS);
  const truncated = preview.length > safeMaxLen ? preview.slice(0, safeMaxLen) + "..." : preview;
  return p.dim(truncated.split("\n").map(l => `  ${p.dim(box.v)} ${l}`).join("\n"));
}

// ── Approval ─────────────────────────────────────────────────

export function approvalPrompt(toolName: string, args: Record<string, unknown>): string {
  const width = Math.min(Math.max(44, w() - 6), 72);
  const argStr = safeApprovalArgs(args);
  const line = (text = "") => p.warning(`  ${box.v}${fitAnsi(text, width - 2)}${box.v}`);
  return [
    p.warning(`  ${box.tl}${box.h.repeat(width - 2)}${box.tr}`),
    line(` Approval required: ${safeRenderLine(toolName, 120)}`),
    line(` ${truncateAnsi(argStr, width - 4)}`),
    line(),
    line(" y yes   n no   a always allow"),
    p.warning(`  ${box.bl}${box.h.repeat(width - 2)}${box.br}`),
  ].join("\n");
}

// ── Footer ───────────────────────────────────────────────────

export function footerDivider(sessionId?: string): string {
  const width = w();
  if (sessionId) {
    const label = ` ${safeStatusText(sessionId)} `;
    if (visibleLength(label) >= width) return p.dim(truncateAnsi(label, width));
    const side = Math.max(0, Math.floor((width - visibleLength(label)) / 2));
    return p.dim(box.h.repeat(side) + label + box.h.repeat(width - side - visibleLength(label)));
  }
  return p.dim(box.h.repeat(width));
}

export function statusBar(
  mode: string, model: string, tokens: number, cost: number, keyHints?: string, workspace?: string,
): string {
  const width = w();
  const safeMode = safeStatusText(mode, "agent").toLowerCase();
  const m = safeMode.toUpperCase();
  const mc = safeMode === "plan" ? p.modePlan : safeMode === "yolo" ? p.modeYolo : p.modeAgent;
  const safeTokens = safeCount(tokens);
  const safeCost = safeMetric(cost);
  const cwd = workspace ? p.dim(`  ${safeStatusText(workspace)}`) : "";
  const left = `${mc(` ${m} `)}  ${p.dim(safeStatusText(model, "unknown"))}${cwd}  ${safeTokens > 0 ? p.dim(`${safeTokens.toLocaleString()}tk`) : ""}${safeCost > 0 ? p.dim(`  $${safeCost.toFixed(3)}`) : ""}`;
  const right = keyHints ? p.subtle(safeStatusText(keyHints)) : "";
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  if (leftLen + rightLen + 1 > width) return fitAnsi(left, width);
  const pad = Math.max(1, width - leftLen - rightLen);
  return left + " ".repeat(pad) + right;
}

export interface StatusBarState {
  mode: string;
  model: string;
  workspace?: string;
  tokens?: number;
  contextLimit?: number;
  cacheTokens?: number;
  activeTools?: number;
  elapsedMs?: number;
  cost?: number;
  keyHints?: string;
}

export type StatusItemName =
  | "mode"
  | "model"
  | "workspace"
  | "context"
  | "cache"
  | "tools"
  | "elapsed"
  | "cost"
  | "hints";

export function statusBarFromItems(items: string[], state: StatusBarState): string {
  const width = w();
  const normalized = Array.isArray(items) && items.length ? items : ["mode", "model", "workspace"];
  const leftParts: string[] = [];
  let right = "";
  for (const item of normalized) {
    const rendered = renderStatusItem(item as StatusItemName, state);
    if (!rendered) continue;
    if (item === "hints") right = rendered;
    else leftParts.push(rendered);
  }
  const left = leftParts.join(p.dim("  "));
  const leftLen = visibleLength(left);
  const rightLen = visibleLength(right);
  if (!right) return fitAnsi(left, width);
  if (leftLen + rightLen + 1 > width) {
    if (rightLen >= width) return fitAnsi(right, width);
    const fittedLeft = fitAnsi(left, Math.max(0, width - rightLen - 1));
    const fittedLeftLen = visibleLength(fittedLeft);
    if (!fittedLeftLen) return fitAnsi(right, width);
    return fittedLeft + " ".repeat(Math.max(1, width - fittedLeftLen - rightLen)) + right;
  }
  return left + " ".repeat(Math.max(1, width - leftLen - rightLen)) + right;
}

function renderStatusItem(item: StatusItemName, state: StatusBarState): string {
  switch (item) {
    case "mode": {
      const mode = safeStatusText(state.mode, "agent").toLowerCase();
      const m = mode.toUpperCase();
      const mc = mode === "plan" ? p.modePlan : mode === "yolo" ? p.modeYolo : p.modeAgent;
      return mc(` ${m} `);
    }
    case "model":
      return p.dim(safeStatusText(state.model, "unknown"));
    case "workspace":
      return state.workspace ? p.dim(safeStatusText(state.workspace)) : "";
    case "context": {
      const tokens = safeCount(state.tokens);
      if (!tokens) return "";
      const limit = safeCount(state.contextLimit);
      const ratio = limit ? `/${compactNumber(limit)}` : "";
      return p.dim(`ctx ${compactNumber(tokens)}${ratio}`);
    }
    case "cache":
      return safeCount(state.cacheTokens) ? p.dim(`cache ${compactNumber(safeCount(state.cacheTokens))}`) : "";
    case "tools":
      return safeCount(state.activeTools) ? p.dim(`tools ${compactNumber(safeCount(state.activeTools))}`) : "";
    case "elapsed":
      return safeMetric(state.elapsedMs) ? p.dim(`elapsed ${formatElapsed(safeMetric(state.elapsedMs))}`) : "";
    case "cost":
      return safeMetric(state.cost) ? p.dim(`$${safeMetric(state.cost).toFixed(3)}`) : "";
    case "hints":
      return state.keyHints ? p.subtle(safeStatusText(state.keyHints)) : "";
  }
}

function compactNumber(value: number): string {
  value = safeCount(value);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.max(0, Math.floor(value)));
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(safeMetric(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

function safeTerminalWidth(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 1_000)
    : 80;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, Number.MAX_SAFE_INTEGER)
    : 0;
}

function safeMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, 1_000_000_000)
    : 0;
}

function safeStatusText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const text = stripAnsi(value).replace(CONTROL_TEXT_RE, " ").trim();
  return text ? text.slice(0, MAX_STATUS_TEXT_CHARS) : fallback;
}

export function toolDiffPreview(result: string, maxLines = 14): string {
  const source = safeRenderText(result, MAX_DIFF_PREVIEW_CHARS);
  const marker = "\n[diff]\n";
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const block = source.slice(start + marker.length).split(/\n\n\[[a-z-]+]/i)[0] || "";
  const rawLines = block.split("\n").filter(line => line.trim().length > 0);
  if (!rawLines.length) return "";
  const selected = rawLines.slice(0, safePreviewLineLimit(maxLines, 14));
  const rendered = selected.map(line => {
    if (line.startsWith("+") && !line.startsWith("+++")) return p.diffAdd(`  ${line}`);
    if (line.startsWith("-") && !line.startsWith("---")) return p.diffDel(`  ${line}`);
    if (line.startsWith("@@")) return p.info(`  ${line}`);
    if (line.startsWith("---") || line.startsWith("+++")) return p.dim(`  ${line}`);
    return p.dim(`  ${line}`);
  });
  if (rawLines.length > selected.length) rendered.push(p.dim(`  ... (${rawLines.length - selected.length} more diff lines)`));
  return rendered.join("\n");
}

export function footerFull(
  mode: string, model: string, tokens: number, cost: number,
  sessionId?: string, keyHints?: string, workspace?: string,
): string {
  return footerDivider(sessionId) + "\n" +
    statusBar(mode, model, tokens, cost, keyHints, workspace);
}

export function footerConfigured(sessionId: string | undefined, items: string[], state: StatusBarState): string {
  return footerDivider(sessionId) + "\n" + statusBarFromItems(items, state);
}

// ── Prompt ───────────────────────────────────────────────────

export function promptSymbol(mode: string): string {
  const syms: Record<string, string> = { plan: "◉", agent: "●", yolo: "▲" };
  return p.blue(`${syms[mode] || ">"} `);
}

// ── Diff ─────────────────────────────────────────────────────

export function diffLines(
  oldStr: string,
  newStr: string,
  filePath?: string,
  options: { maxLines?: number; maxChars?: number } = {},
): string {
  const h = filePath ? p.info(`\n  ── ${safeRenderLine(filePath, 500)} ──`) : "";
  const oldLines = safeRenderText(oldStr).split("\n");
  const newLines = safeRenderText(newStr).split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const lines: string[] = [h];
  const maxLines = typeof options.maxLines === "number" && Number.isFinite(options.maxLines) ? Math.max(1, Math.floor(options.maxLines)) : Number.POSITIVE_INFINITY;
  const maxChars = typeof options.maxChars === "number" && Number.isFinite(options.maxChars) ? Math.max(120, Math.floor(options.maxChars)) : Number.POSITIVE_INFINITY;
  let omittedLines = 0;
  let visibleChars = stripAnsi(h).length;
  const pushLine = (line: string) => {
    lines.push(line);
    visibleChars += stripAnsi(line).length + 1;
  };
  for (let i = 0; i < max; i++) {
    if (lines.length >= maxLines) {
      omittedLines = max - i;
      break;
    }
    if (oldLines[i] === newLines[i]) {
      if (oldLines[i] !== undefined) pushLine(`  ${oldLines[i]}`);
    } else {
      if (oldLines[i] !== undefined) {
        if (lines.length >= maxLines) {
          omittedLines = max - i;
          break;
        }
        pushLine(p.diffDel(`- ${oldLines[i]}`));
      }
      if (newLines[i] !== undefined) {
        if (lines.length >= maxLines) {
          omittedLines = max - i;
          break;
        }
        pushLine(p.diffAdd(`+ ${newLines[i]}`));
      }
    }
    if (visibleChars >= maxChars) {
      omittedLines = Math.max(0, max - i - 1);
      break;
    }
  }
  if (omittedLines > 0) pushLine(p.dim(`  ... (${omittedLines} more diff lines)`));
  return lines.join("\n");
}

// ── Interrupt ────────────────────────────────────────────────

export function interruptedMsg(): string {
  return p.warning("\n  ⏎ Interrupted");
}

// ── Helpers ──────────────────────────────────────────────────

export function toolResultSummary(result: string): string {
  const safeResult = safeRenderText(result, MAX_SUMMARY_CHARS);
  const lines = safeResult.trimEnd().split("\n");
  if (lines.length <= 3) return safeResult;
  return lines.slice(0, 3).join("\n") + p.dim(`\n  ... (${lines.length - 3} more lines)`);
}

export function commandOutput(text: string): string {
  const safeText = safeRenderText(text, MAX_SUMMARY_CHARS).trimEnd();
  return safeText ? safeText : p.dim("(no output)");
}

function safeRenderText(value: unknown, maxChars = MAX_RENDER_TEXT_CHARS): string {
  if (typeof value !== "string" || maxChars <= 0) return "";
  const normalized = stripAnsi(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(CONTROL_TEXT_RE, " ");
  return safeSliceText(normalized, maxChars);
}

function safeRenderLine(value: unknown, maxChars = MAX_RENDER_LINE_CHARS): string {
  return safeRenderText(value, maxChars).replace(/\n+/g, " ").trim();
}

function safeSliceText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = Math.max(0, Math.floor(maxChars));
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return text.slice(0, end);
}

function safePreviewLineLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(200, Math.floor(parsed));
}

function safePreviewCharLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function safeApprovalArgs(args: Record<string, unknown>): string {
  const entries = args && typeof args === "object" ? Object.entries(args).slice(0, MAX_APPROVAL_ARG_COUNT) : [];
  const parts = entries.map(([key, value]) => {
    const safeKey = safeRenderLine(key, 120);
    const safeValue = safeRenderLine(stringifyApprovalValue(value), MAX_APPROVAL_ARG_CHARS);
    return `${safeKey}=${safeValue}`;
  });
  if (args && typeof args === "object" && Object.keys(args).length > entries.length) parts.push("...");
  return parts.join(" ");
}

function stringifyApprovalValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}
