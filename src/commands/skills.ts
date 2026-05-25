import { resolve } from "node:path";
import {
  activateSkill,
  installSkill,
  listRemoteSkills,
  listSkills,
  trustSkill,
  uninstallSkill,
  updateSkill,
} from "../engine/skills.js";
import { p } from "../ui/palette.js";
import type { SlashCommandHandler } from "./types.js";

const MAX_SKILL_SLASH_ARG_CHARS = 4_096;
const CONTROL_TEXT_RE = /[\u0000-\u001F\u007F]/;

export const skillsCommand: SlashCommandHandler = async ({ cfg, parts, write }) => {
  if (parts.length > 2 || (parts[1] && parts[1] !== "--remote" && parts[1] !== "remote")) {
    write(p.error("Usage: /skills [--remote]"));
    return;
  }
  if (parts[1] === "--remote" || parts[1] === "remote") {
    try {
      write(await listRemoteSkills(cfg.skills_registry_url, cfg.skills_max_install_size_bytes));
    } catch (e: any) {
      write(p.error(`Could not fetch remote skills: ${e.message}`));
    }
    return;
  }
  write(listSkills(resolve("."), cfg.skills_dir));
};

export const skillCommand: SlashCommandHandler = async ({ cfg, parts, runtime, write }) => {
  const subcmdOrName = parts[1];
  if (!subcmdOrName) {
    write(p.error("Usage: /skill <name|new|install <spec>|update <name>|uninstall <name>|trust <name>>"));
    return;
  }
  const subcmdError = validateSkillSlashArg(subcmdOrName, "skill name");
  if (subcmdError) {
    write(p.error(subcmdError));
    return;
  }
  try {
    if (subcmdOrName === "install") {
      const spec = parts.slice(2).join(" ");
      const specError = validateSkillSlashArg(spec, "install source");
      if (!spec || specError) {
        write(p.error("Usage: /skill install <github:owner/repo|https://...|registry-name>"));
        return;
      }
      const result = await installSkill(spec, {
        skillsDir: cfg.skills_dir,
        registryUrl: cfg.skills_registry_url,
        maxSizeBytes: cfg.skills_max_install_size_bytes,
      });
      runtime.rebuildSystemPrompt();
      write(p.success(`Installed skill '${result.skill.name}' at ${result.skill.path}`));
      return;
    }
    if (subcmdOrName === "update") {
      const name = parts[2];
      if (!name || parts.length !== 3 || validateSkillSlashArg(name, "skill name")) {
        write(p.error("Usage: /skill update <name>"));
        return;
      }
      const result = await updateSkill(name, {
        skillsDir: cfg.skills_dir,
        registryUrl: cfg.skills_registry_url,
        maxSizeBytes: cfg.skills_max_install_size_bytes,
      });
      runtime.rebuildSystemPrompt();
      write(p.success(`Skill '${result.skill.name}' ${result.status}.`));
      return;
    }
    if (subcmdOrName === "uninstall") {
      const name = parts[2];
      if (!name || parts.length !== 3 || validateSkillSlashArg(name, "skill name")) {
        write(p.error("Usage: /skill uninstall <name>"));
        return;
      }
      write(p.success(uninstallSkill(name, { skillsDir: cfg.skills_dir })));
      runtime.rebuildSystemPrompt();
      return;
    }
    if (subcmdOrName === "trust") {
      const name = parts[2];
      if (!name || parts.length !== 3 || validateSkillSlashArg(name, "skill name")) {
        write(p.error("Usage: /skill trust <name>"));
        return;
      }
      write(p.success(trustSkill(name, { skillsDir: cfg.skills_dir, workspaceDir: resolve(".") })));
      return;
    }
    const result = activateSkill(subcmdOrName, { workspaceDir: resolve("."), skillsDir: cfg.skills_dir });
    if (!result.ok || !result.instruction) {
      write(p.error(result.message));
      return;
    }
    runtime.setActiveSkill?.(result.instruction);
    write(p.success(result.message));
  } catch (e: any) {
    write(p.error(`Skill error: ${e.message}`));
  }
};

function validateSkillSlashArg(value: string, label: string): string | null {
  if (typeof value !== "string" || !value.trim()) return `${label} is required`;
  if (value.length > MAX_SKILL_SLASH_ARG_CHARS) return `${label} is too long`;
  if (CONTROL_TEXT_RE.test(value)) return `${label} contains control characters`;
  return null;
}
