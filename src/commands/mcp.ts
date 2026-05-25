import {
  addMCPServer,
  getMCPManager,
  reloadMCPManager,
  removeMCPServer,
  setMCPServerEnabled,
} from "../mcp/manager.js";
import { p } from "../ui/palette.js";
import type { SlashCommandHandler } from "./types.js";
import { safeJsonStringify } from "../utils/json-safe.js";

const MAX_MCP_NAME_CHARS = 80;
const MAX_MCP_COMMAND_CHARS = 4096;
const MAX_MCP_ARGS = 128;
const MAX_MCP_ARG_CHARS = 4096;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;

export const mcpCommand: SlashCommandHandler = async ({ cfg, parts, write }) => {
  const subcmd = (parts[1] || "list").trim().toLowerCase();
  try {
    if (subcmd === "list") {
      if (parts.length > 2) {
        write(p.error("Usage: /mcp list"));
        return;
      }
      write(safeJsonStringify(getMCPManager(cfg).list(), { space: 2 }));
      return;
    }
    if (subcmd === "reload") {
      if (parts.length > 2) {
        write(p.error("Usage: /mcp reload"));
        return;
      }
      const manager = await reloadMCPManager(cfg);
      write(safeJsonStringify({ reloaded: true, servers: manager.list() }, { space: 2 }));
      return;
    }
    if (subcmd === "enable" || subcmd === "disable") {
      const name = normalizeMCPName(parts[2]);
      if (!name || parts.length > 3) {
        write(p.error("Usage: /mcp enable|disable <name>"));
        return;
      }
      setMCPServerEnabled(name, subcmd === "enable");
      write(p.success(`${subcmd === "enable" ? "Enabled" : "Disabled"} MCP server ${name}. Run /mcp reload to apply.`));
      return;
    }
    if (subcmd === "remove" || subcmd === "delete") {
      const name = normalizeMCPName(parts[2]);
      if (!name || parts.length > 3) {
        write(p.error("Usage: /mcp remove <name>"));
        return;
      }
      removeMCPServer(name);
      write(p.success(`Removed MCP server ${name}. Run /mcp reload to apply.`));
      return;
    }
    if (subcmd === "add") {
      const name = normalizeMCPName(parts[2]);
      const command = normalizeMCPCommand(parts[3]);
      const args = normalizeMCPArgs(parts.slice(4));
      if (!name || !command || args === null) {
        write(p.error("Usage: /mcp add <name> <command> [args...]"));
        return;
      }
      addMCPServer({ name, transport: "stdio", command, args, env: {}, enabled: true });
      write(p.success(`Added MCP server ${name}. Run /mcp reload to apply.`));
      return;
    }
    write(p.error("Usage: /mcp [list|add|enable|disable|remove|reload]"));
  } catch (e: any) {
    write(p.error(`MCP error: ${e.message}`));
  }
};

function normalizeMCPName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_MCP_NAME_CHARS && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : "";
}

function normalizeMCPCommand(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_MCP_COMMAND_CHARS && !CONTROL_TEXT_RE.test(trimmed) ? trimmed : "";
}

function normalizeMCPArgs(values: string[]): string[] | null {
  if (values.length > MAX_MCP_ARGS) return null;
  const args: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_MCP_ARG_CHARS || CONTROL_TEXT_RE.test(trimmed)) return null;
    args.push(trimmed);
  }
  return args;
}
