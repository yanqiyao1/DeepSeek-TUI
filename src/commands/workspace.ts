import { resolve } from "node:path";
import { restoreWorkspace, revertLastTurn } from "../rollback/restore.js";
import { p } from "../ui/palette.js";
import type { SlashCommandHandler } from "./types.js";

export const restoreCommand: SlashCommandHandler = async ({ parts, write }) => {
  if (parts.length > 2 || (parts[1] && parts[1] !== "revert")) {
    write(p.dim("Usage: /restore [revert]"));
    return;
  }
  if (parts[1] === "revert") {
    const result = await revertLastTurn(resolve("."));
    write(p.success(result));
    return;
  }

  const snapshots = await restoreWorkspace(resolve("."));
  if (!snapshots.length) {
    write(p.dim("No snapshots available."));
    return;
  }
  write(p.blueBold("Snapshots:"));
  for (const s of snapshots.slice(0, 10)) {
    write(`  ${p.blue(s.hash.slice(0, 8))} ${s.message} [${s.date?.slice(0, 19) || ""}]`);
  }
};
