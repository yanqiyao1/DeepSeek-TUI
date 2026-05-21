/** Core session dataclasses: Message, ToolCall, Session, Turn. */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  is_error: boolean;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string | null;
  name?: string | null;
  reasoning_content?: string | null;
  is_error?: boolean | null;
}

export function messageToApiDict(m: Message): Record<string, unknown> {
  const d: Record<string, unknown> = { role: m.role };
  if (m.content !== null && m.content !== undefined) d.content = m.content;
  if (m.tool_calls && m.tool_calls.length > 0) {
    d.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));
  }
  if (m.tool_call_id) d.tool_call_id = m.tool_call_id;
  if (m.name) d.name = m.name;
  if (m.reasoning_content) d.reasoning_content = m.reasoning_content;
  return d;
}

export function toolCallFromApi(tc: Record<string, unknown>): ToolCall {
  const fn = ((tc as any).function || {}) as Record<string, unknown>;
  let args = fn.arguments || {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    args = {};
  }
  return {
    id: typeof tc.id === "string" ? tc.id : "",
    name: typeof fn.name === "string" ? fn.name : "",
    arguments: args as Record<string, unknown>,
  };
}

export interface Turn {
  index: number;
  user_message: string;
  assistant_messages: Message[];
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  tokens_in: number;
  tokens_out: number;
  cost: number;
  duration_s: number;
  artifact_ids?: string[];
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  mode: string;
  model: string;
  turns: Turn[];
  messages: Message[];
  cumulative_tokens_in: number;
  cumulative_tokens_out: number;
  cumulative_cost: number;
  workspace_path: string;
  artifact_index: Record<string, string[]>;
  prefix_hash?: string;
}

export function createSession(opts?: Partial<Session>): Session {
  const session: Session = {
    id: Math.random().toString(36).slice(2, 14),
    title: "Untitled session",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    mode: "agent",
    model: "deepseek-v4-pro",
    turns: [],
    messages: [],
    cumulative_tokens_in: 0,
    cumulative_tokens_out: 0,
    cumulative_cost: 0,
    workspace_path: process.cwd(),
    artifact_index: {},
  };
  const merged = { ...session, ...opts };
  if (merged.prefix_hash === undefined) delete merged.prefix_hash;
  return merged;
}
