import { basename } from "node:path";
import { saveSession, loadSession, listSessions, deleteSession } from "../session/store.js";
import { createSession } from "../session/types.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";
import { p } from "../ui/palette.js";
import { confirmPrompt, pickFromList } from "./picker.js";
import type { SlashCommandHandler } from "./types.js";

const SESSION_COMMAND_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SESSION_META_CHARS = 80;
const MAX_SESSION_LIST_TITLE_CHARS = 120;

function isSessionCommandId(value: string | undefined): value is string {
  return !!value && value !== "." && value !== ".." && SESSION_COMMAND_ID_RE.test(value);
}

function usage(write: (message: unknown, isError?: boolean) => void, message: string): void {
  write(p.dim(message));
}

function displayField(value: unknown, maxChars = MAX_SESSION_META_CHARS): string {
  if (typeof value !== "string" || maxChars <= 0) return "";
  return safeSliceTextBoundary(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim(), maxChars);
}

function sessionWorkspaceLabel(workspacePath: string): string {
  return displayField(basename(workspacePath || "") || workspacePath || "", MAX_SESSION_META_CHARS);
}

function sessionItemDescription(session: ReturnType<typeof listSessions>[number]): string {
  const title = displayField(session.title, MAX_SESSION_LIST_TITLE_CHARS);
  const updated = displayField(session.updated_at?.slice(0, 16) || "", 16);
  const mode = displayField(session.mode, 16);
  return `${title}  ${p.dim(`${updated}  ${session.message_count} msgs  ${mode}  ${sessionWorkspaceLabel(session.workspace_path)}`)}`;
}

export const saveCommand: SlashCommandHandler = ({ parts, session, write }) => {
  if (parts.length !== 1) {
    usage(write, "Usage: /save");
    return;
  }
  try {
    const id = saveSession(session);
    write(p.success(`Session saved: ${id} — ${session.title}`));
  } catch (e: any) {
    write(p.error(`Could not save session: ${e.message}`));
  }
};

export const loadCommand: SlashCommandHandler = async ({ parts, runtime, write }) => {
  const id = parts[1];
  if (parts.length > 2 || (id && !isSessionCommandId(id))) {
    usage(write, "Usage: /load <id>");
    return;
  }
  if (id) {
    const loaded = loadSession(id);
    if (!loaded) {
      write(p.error(`Session not found: ${id}`));
      return;
    }
    runtime.applyLoadedSession(loaded);
    runtime.renderLoadedSession();
    write(p.success(`Loaded session: ${loaded.title} (${loaded.messages.filter(message => message.role !== "system").length} messages)`));
    return true;
  }

  const sessions = listSessions();
  if (!sessions.length) {
    write(p.dim("No saved sessions."));
    return;
  }
  const selected = await pickFromList(
    sessions.map(s => ({ name: s.id, desc: sessionItemDescription(s) })),
    "Select session to load",
    runtime.renderPicker,
    runtime.clearModal,
  );
  if (!selected) return;
  const loaded = loadSession(selected);
  if (!loaded) {
    write(p.error(`Session not found: ${selected}`));
    return;
  }
  runtime.applyLoadedSession(loaded);
  runtime.renderLoadedSession();
  write(p.success(`Loaded session: ${loaded.title} (${loaded.messages.filter(message => message.role !== "system").length} messages)`));
  return true;
};

export const deleteCommand: SlashCommandHandler = async ({ parts, session, runtime, write }) => {
  let id: string | undefined = parts[1];
  if (parts.length > 2 || (id && !isSessionCommandId(id))) {
    usage(write, "Usage: /delete [id]");
    return;
  }
  const sessions = listSessions();
  if (!id) {
    if (!sessions.length) {
      write(p.dim("No saved sessions."));
      return;
    }
    id = await pickFromList(
      sessions.map(s => ({ name: s.id, desc: sessionItemDescription(s) })),
      "Select session to delete",
      runtime.renderPicker,
      runtime.clearModal,
    ) || undefined;
    if (!id) return;
  }

  const loadedTarget = loadSession(id);
  const target = sessions.find(s => s.id === id) || (loadedTarget ? {
    id,
    title: loadedTarget.title || id,
    created_at: "",
    updated_at: "",
    mode: "",
    model: "",
    workspace_path: "",
    message_count: 0,
  } : null);
  if (!target) {
    write(p.error(`Session not found: ${id}`));
    return;
  }
  const confirmed = await confirmPrompt(`Delete session ${id}?`, runtime.renderPicker, runtime.clearModal);
  if (!confirmed) {
    write(p.dim("Delete cancelled."));
    return;
  }

  if (deleteSession(id)) {
    if (id === session.id) {
      session.id = createSession().id;
    }
    write(p.success(`Deleted session: ${id} — ${target.title}`));
  } else {
    write(p.error(`Could not delete session: ${id}`));
  }
};

export const sessionsCommand: SlashCommandHandler = ({ parts, write }) => {
  if (parts.length !== 1) {
    usage(write, "Usage: /sessions");
    return;
  }
  const sessions = listSessions();
  if (!sessions.length) {
    write(p.dim("No saved sessions."));
    return;
  }
  write(p.blueBold(`Saved sessions (${sessions.length}):`));
  for (const s of sessions.slice(0, 10)) {
    write(`  ${p.blue(displayField(s.id, 128))} | ${displayField(s.title, MAX_SESSION_LIST_TITLE_CHARS)} | ${displayField(s.updated_at?.slice(0, 16) || "", 16)} | ${s.message_count} msgs | ${displayField(s.mode, 16)} | ${sessionWorkspaceLabel(s.workspace_path)}`);
  }
};

export const exitCommand: SlashCommandHandler = ({ parts, session, runtime, write }) => {
  if (parts.length !== 1) {
    usage(write, "Usage: /exit");
    return;
  }
  try {
    const sid = saveSession(session);
    runtime.setExitSummary?.([
      p.dim("Goodbye!"),
      p.success(`Session saved as ${sid} — ${session.title}`),
      p.dim(`Resume with: seek    then: /load ${sid}`),
    ].join("\n"));
  } catch (e: any) {
    runtime.setExitSummary?.([
      p.dim("Goodbye!"),
      p.warning(`Could not save session: ${e.message}`),
    ].join("\n"));
  }
  return "exit";
};
