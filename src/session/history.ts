/** Conversation history manager. */

import type { Message, Session, ToolCall, ToolResult } from "./types.js";
import { cloneMessage, createSession, normalizeToolCalls, safeSessionString, safeToolCallId, safeToolName } from "./types.js";
import { estimateMessagesTokens } from "../engine/compact.js";

export class ConversationHistory {
  session: Session;

  constructor(session?: Session) {
    this.session = session || createSession();
  }

  addSystem(content: string): void {
    this.session.messages.push({ role: "system", content: safeSessionString(content) ?? "", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null });
  }

  addUser(content: string): void {
    this.session.messages.push({ role: "user", content: safeSessionString(content) ?? "", tool_calls: null, tool_call_id: null, name: null, reasoning_content: null });
  }

  addAssistant(
    content?: string | null,
    toolCalls?: ToolCall[] | null,
    reasoningContent?: string | null,
  ): Message {
    const normalizedToolCalls = normalizeToolCalls(toolCalls);
    const msg: Message = {
      role: "assistant",
      content: safeSessionString(content) ?? "",
      tool_calls: normalizedToolCalls.length ? normalizedToolCalls : null,
      tool_call_id: null,
      name: null,
      reasoning_content: safeSessionString(reasoningContent),
    };
    this.session.messages.push(msg);
    return cloneMessage(msg);
  }

  addToolResult(result: ToolResult): void {
    const toolCallId = safeToolCallId(result.tool_call_id);
    const name = safeToolName(result.name);
    if (!toolCallId || !name) return;
    this.session.messages.push({
      role: "tool",
      content: safeSessionString(result.content) ?? "",
      tool_calls: null,
      tool_call_id: toolCallId,
      name,
      reasoning_content: null,
      is_error: result.is_error === true,
    });
  }

  getMessages(): Message[] {
    return this.session.messages.map(cloneMessage);
  }

  approximateTokenCount(): number {
    return estimateMessagesTokens(this.session.messages);
  }

  clear(): void {
    this.session.messages = [];
  }
}
