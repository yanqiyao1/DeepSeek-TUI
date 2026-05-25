import { explainConfig, migrateProjectConfig, migrateUserConfig, validateConfig } from "../config.js";
import { p } from "../ui/palette.js";
import type { SlashCommandHandler } from "./types.js";
import { safeJsonStringify } from "../utils/json-safe.js";

export const configCommand: SlashCommandHandler = ({ parts, write }) => {
  const subcmd = (parts[1] || "explain").trim().toLowerCase();
  if (subcmd === "validate") {
    if (parts.length > 2) {
      write(p.error("Usage: /config validate"));
      return;
    }
    const report = validateConfig();
    write(safeJsonStringify(report, { space: 2 }));
    return;
  }
  if (subcmd === "migrate") {
    const target = (parts[2] || "user").trim().toLowerCase();
    if (target !== "user" && target !== "project") {
      write(p.error("Usage: /config migrate [user|project] [--dry-run]"));
      return;
    }
    const allowedFlags = new Set(["--dry-run"]);
    for (const part of parts.slice(3)) {
      if (!allowedFlags.has(part)) {
        write(p.error("Usage: /config migrate [user|project] [--dry-run]"));
        return;
      }
    }
    const dryRun = parts.includes("--dry-run");
    const report = target === "project" ? migrateProjectConfig({ dryRun }) : migrateUserConfig({ dryRun });
    write(safeJsonStringify(report, { space: 2 }));
    return;
  }
  if (subcmd === "explain") {
    if (parts.length > 2) {
      write(p.error("Usage: /config explain"));
      return;
    }
    write(safeJsonStringify(explainConfig(), { space: 2 }));
    return;
  }
  write(p.error("Usage: /config [validate|migrate user|migrate project|explain] [--dry-run]"));
};
