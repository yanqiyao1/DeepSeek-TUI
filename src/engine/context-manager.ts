/** Layered context management and capacity intervention planning. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import type { ConversationHistory } from "../session/history.js";
import type { Message } from "../session/types.js";
import type { CapacityDecision, GuardrailAction } from "./capacity.js";
import { ContextCompactor, estimateMessagesTokens, projectMessagesForRequest, type CompactionResult } from "./compact.js";

export type ContextLayerKind = "pinned" | "summary" | "recent" | "refresh" | "verification";

export interface ContextLayer {
  kind: ContextLayerKind;
  label: string;
  tokens: number;
  message_count: number;
}

export interface ContextIntervention {
  action: GuardrailAction;
  risk: CapacityDecision["risk"];
  reason: string;
  tokens_before: number;
  tokens_after: number;
  layers: ContextLayer[];
  injected_message?: string;
  compaction?: CompactionResult;
}

export class LayeredContextManager {
  private config: Config;
  private compactor: ContextCompactor;
  private refreshCounter = 0;

  constructor(config: Config, compactor = new ContextCompactor(config)) {
    this.config = config;
    this.compactor = compactor;
  }

  inspect(history: ConversationHistory): ContextLayer[] {
    const messages = projectMessagesForRequest(history.session.messages);
    const refresh = messages.filter(message => isContextMarker(message, "refresh"));
    const verification = messages.filter(message => isContextMarker(message, "verification"));
    const summary = messages.filter(message => isContextMarker(message, "summary"));
    const system = messages.filter(message => message.role === "system" && !refresh.includes(message) && !verification.includes(message) && !summary.includes(message));
    const recent = messages.filter(message => !system.includes(message) && !refresh.includes(message) && !verification.includes(message) && !summary.includes(message)).slice(-12);
    return [
      layer("pinned", "system/tool policy", system),
      layer("summary", "compressed history", summary),
      layer("recent", "recent conversation", recent),
      layer("refresh", "targeted refresh markers", refresh),
      layer("verification", "verification markers", verification),
    ].filter(item => item.message_count > 0);
  }

  apply(history: ConversationHistory, decision: CapacityDecision, workspacePath: string): ContextIntervention | null {
    if (!this.config.context_refresh_enabled || decision.action === "no_intervention") return null;
    const before = estimateMessagesTokens(projectMessagesForRequest(history.session.messages));
    let injected: string | undefined;
    let compaction: CompactionResult | undefined;

    if (decision.action === "targeted_context_refresh") {
      injected = this.injectRefresh(history, workspacePath, decision.reason);
    } else if (decision.action === "verify_with_tool_replay") {
      injected = this.injectVerification(history, "Verify the latest tool outputs and user request before making further edits.");
    } else if (decision.action === "verify_and_replan") {
      compaction = this.compactor.compact(history);
      injected = this.injectVerification(history, "Context pressure is severe. Re-derive the current goal from the latest messages, verify assumptions with tools, then replan before continuing.");
    }

    return {
      action: decision.action,
      risk: decision.risk,
      reason: decision.reason,
      tokens_before: before,
      tokens_after: estimateMessagesTokens(projectMessagesForRequest(history.session.messages)),
      layers: this.inspect(history),
      ...(injected ? { injected_message: injected } : {}),
      ...(compaction ? { compaction } : {}),
    };
  }

  compactNow(history: ConversationHistory, _workspacePath: string, reason: string): ContextIntervention {
    const before = estimateMessagesTokens(projectMessagesForRequest(history.session.messages));
    const compaction = this.compactor.compact(history);
    const injected = compaction.status === "compacted"
      ? this.injectVerification(history, "Prompt was too long for the provider. Continue from the compacted summary, verify assumptions with tools if needed, then retry the user request.")
      : undefined;
    return {
      action: "verify_and_replan",
      risk: "high",
      reason,
      tokens_before: before,
      tokens_after: estimateMessagesTokens(projectMessagesForRequest(history.session.messages)),
      layers: this.inspect(history),
      ...(injected ? { injected_message: injected } : {}),
      compaction,
    };
  }

  private injectRefresh(history: ConversationHistory, workspacePath: string, reason: string): string {
    this.refreshCounter++;
    const refresh = buildWorkspaceRefresh(workspacePath);
    const message = [
      `[Context refresh ${this.refreshCounter}] ${reason}.`,
      "Use this as a local seam: keep the current user request, recent tool evidence, and workspace facts aligned.",
      refresh,
    ].filter(Boolean).join("\n");
    history.session.messages.push(markerMessage("refresh", message));
    pruneMarkers(history.session.messages, "refresh", 3);
    return message;
  }

  private injectVerification(history: ConversationHistory, instruction: string): string {
    const message = `[Context verification] ${instruction}`;
    history.session.messages.push(markerMessage("verification", message));
    pruneMarkers(history.session.messages, "verification", 4);
    return message;
  }
}

function layer(kind: ContextLayerKind, label: string, messages: Message[]): ContextLayer {
  return {
    kind,
    label,
    message_count: messages.length,
    tokens: estimateMessagesTokens(messages),
  };
}

function markerMessage(kind: "refresh" | "verification", content: string): Message {
  return {
    role: "system",
    content,
    tool_calls: null,
    tool_call_id: null,
    name: `context_${kind}`,
    reasoning_content: null,
  };
}

function isContextMarker(message: Message, kind: "refresh" | "verification" | "summary"): boolean {
  if (message.name === `context_${kind}`) return true;
  if (kind === "summary") {
    if (message.name === "context_compaction_boundary" || message.name === "context_summary") return true;
    return typeof message.content === "string"
      && (message.content.startsWith("[Earlier conversation summarized")
        || message.content.startsWith("[Context compaction boundary]"));
  }
  return false;
}

function pruneMarkers(messages: Message[], kind: "refresh" | "verification", keep: number): void {
  const indexes = messages
    .map((message, index) => isContextMarker(message, kind) ? index : -1)
    .filter(index => index >= 0);
  for (const index of indexes.slice(0, Math.max(0, indexes.length - keep)).reverse()) {
    messages.splice(index, 1);
  }
}

function buildWorkspaceRefresh(workspacePath: string): string {
  const root = resolve(workspacePath || ".");
  const lines = [`Workspace: ${root}`];
  try {
    const entries = readdirSync(root, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist")
      .slice(0, 16)
      .map(entry => {
        const suffix = entry.isDirectory() ? "/" : "";
        let size = "";
        if (entry.isFile()) {
          try { size = ` (${statSync(join(root, entry.name)).size} bytes)`; } catch { /* ignore */ }
        }
        return `${entry.name}${suffix}${size}`;
      });
    lines.push(`Top-level files: ${entries.join(", ") || "(empty)"}`);
    for (const marker of ["package.json", "tsconfig.json", "Cargo.toml", "pyproject.toml", "go.mod"]) {
      const path = join(root, marker);
      if (existsSync(path)) lines.push(`Detected project marker: ${relative(root, path) || basename(path)}`);
    }
  } catch (e: any) {
    lines.push(`Workspace scan failed: ${e.message}`);
  }
  return lines.join("\n");
}
