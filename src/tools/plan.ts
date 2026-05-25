/** Plan and todo tools — checklist_write, update_plan, note.
 *
 * Adopted from DeepSeek-TUI's decomposition-first approach.
 * checklist_write: granular leaf tasks
 * update_plan: high-level strategic phases
 * note: persistent cross-session memory
 */

import { PermissionLevel } from "./base.js";
import { getRegistry } from "./registry.js";

// ── State types ──────────────────────────────────────────────

interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
  started_at?: number;
  completed_at?: number;
}

interface TodoItem {
  id: number;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

const VALID_STATUSES = new Set<PlanStep["status"]>(["pending", "in_progress", "completed"]);
const MAX_CHECKLIST_ITEMS = 200;
const MAX_PLAN_STEPS = 100;
const MAX_STATE_TEXT_CHARS = 1000;
const MAX_EXPLANATION_CHARS = 2000;
const MAX_NOTES = 100;
const MAX_NOTE_TITLE_CHARS = 200;
const MAX_NOTE_CONTENT_CHARS = 20_000;
const STATE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// ── In-memory state ──────────────────────────────────────────

let planSteps: PlanStep[] = [];
let todoItems: TodoItem[] = [];
let nextTodoId = 1;
let notes: Array<{ title: string; content: string; created_at: string }> = [];

export function getPlanState() { return planSteps.map(step => ({ ...step })); }
export function getTodoState() { return todoItems.map(item => ({ ...item })); }
export function getNoteState() { return notes.map(note => ({ ...note })); }
export function clearPlanState() { planSteps = []; todoItems = []; nextTodoId = 1; notes = []; }

export function formatTodoState(limit = 20): string {
  if (!todoItems.length) return "";
  const inProgress = todoItems.filter(item => item.status === "in_progress").length;
  const completed = todoItems.filter(item => item.status === "completed").length;
  const lines = [`Checklist: ${todoItems.length} tasks, ${inProgress} in progress, ${completed} completed`];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_CHECKLIST_ITEMS) : 20;
  for (const item of todoItems.slice(0, safeLimit)) {
    lines.push(`  ${STATUS_SYMBOLS[item.status]} [${item.id}] ${item.content}`);
  }
  if (todoItems.length > safeLimit) lines.push(`  ... ${todoItems.length - safeLimit} more`);
  return lines.join("\n");
}

function normalizeNoteAction(value: unknown): "add" | "set" | "get" | "list" | "delete" | string {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "add";
}

function validatePlanItemsInput(plan: unknown): string | null {
  if (plan === undefined) return null;
  if (!Array.isArray(plan)) return "plan must be an array";
  if (plan.length > MAX_PLAN_STEPS) return `plan must contain at most ${MAX_PLAN_STEPS} items`;
  for (const item of plan) {
    if (!item || typeof item !== "object") return "each plan item must be an object";
    const step = normalizeBoundedText((item as { step?: unknown }).step, "step", MAX_STATE_TEXT_CHARS, { required: true });
    if ("error" in step) return step.error === "step must be a string." ? "step is required for each plan item" : step.error;
    const rawStatus = (item as { status?: unknown }).status;
    if (rawStatus !== undefined && !VALID_STATUSES.has(rawStatus as PlanStep["status"])) {
      return "status must be pending, in_progress, or completed";
    }
  }
  return null;
}

function normalizeChecklistItemsInput(items: unknown): { items: Array<{ content: string; status: TodoItem["status"] }> } | { error: string } {
  if (!Array.isArray(items)) return { error: "items must be an array" };
  if (items.length > MAX_CHECKLIST_ITEMS) return { error: `items must contain at most ${MAX_CHECKLIST_ITEMS} entries` };

  const normalizedItems: Array<{ content: string; status: TodoItem["status"] }> = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return { error: "each item must be an object" };
    const content = normalizeBoundedText((item as { content?: unknown }).content, "content", MAX_STATE_TEXT_CHARS, { required: true });
    if ("error" in content) return { error: content.error === "content must be a string." ? "content is required for each checklist item" : content.error };
    const rawStatus = (item as { status?: unknown }).status === undefined ? "pending" : (item as { status?: unknown }).status;
    if (!VALID_STATUSES.has(rawStatus as TodoItem["status"])) {
      return { error: "status must be pending, in_progress, or completed" };
    }
    normalizedItems.push({ content: content.value, status: rawStatus as TodoItem["status"] });
  }

  return { items: normalizedItems };
}

function normalizeBoundedText(
  value: unknown,
  label: string,
  maxChars: number,
  options: { required?: boolean; trim?: boolean } = {},
): { value: string } | { error: string } {
  if (typeof value !== "string") return { error: `${label} must be a string.` };
  const text = options.trim === false ? value : value.trim();
  if (text.includes("\0")) return { error: `${label} must not contain NUL bytes.` };
  if (STATE_CONTROL_RE.test(text)) return { error: `${label} must not contain control characters.` };
  if (options.required !== false && !text.trim()) return { error: `${label} is required.` };
  if (text.length > maxChars) return { error: `${label} must be at most ${maxChars} characters.` };
  return { value: text };
}

function ensureSingleInProgress<T extends { status: PlanStep["status"] }>(items: T[]): T[] {
  let seenInProgress = false;
  return items.map(item => {
    if (item.status !== "in_progress") return item;
    if (seenInProgress) return { ...item, status: "pending" };
    seenInProgress = true;
    return item;
  });
}

function enforceSingleActivePlanStep(activeText: string): void {
  for (const step of planSteps) {
    if (step.text !== activeText && step.status === "in_progress") step.status = "pending";
  }
}

// ── checklist_write ──────────────────────────────────────────

const STATUS_SYMBOLS: Record<string, string> = {
  pending: "○",
  in_progress: "◎",
  completed: "●",
};

async function checklistWrite(args: Record<string, unknown>): Promise<string> {
  const normalized = normalizeChecklistItemsInput(args.items);
  if ("error" in normalized) return `Error: ${normalized.error}`;
  const items = ensureSingleInProgress(normalized.items);

  const nextItems: TodoItem[] = [];
  const lines: string[] = [];
  let inProgressCount = 0;

  for (const item of items) {
    const { content, status } = item;
    if (status === "in_progress") inProgressCount++;
    const ti: TodoItem = { id: nextTodoId + nextItems.length, content, status };
    nextItems.push(ti);
    lines.push(`  ${STATUS_SYMBOLS[status]} [${ti.id}] ${ti.content}`);
  }

  todoItems = nextItems;
  nextTodoId = nextItems.length + 1;
  const header = `${todoItems.length} tasks, ${inProgressCount} in progress:\n`;
  return header + lines.join("\n");
}

// ── update_plan ──────────────────────────────────────────────

async function updatePlan(args: Record<string, unknown>): Promise<string> {
  const explanationText = args.explanation === undefined
    ? { value: "" }
    : normalizeBoundedText(args.explanation, "explanation", MAX_EXPLANATION_CHARS, { required: false });
  if ("error" in explanationText) {
    return `Error: ${explanationText.error}`;
  }
  const planError = validatePlanItemsInput(args.plan);
  if (planError) return `Error: ${planError}`;
  const explanation = explanationText.value;
  const plan = args.plan as Array<{ step: string; status?: string }> | undefined;

  // If updating specific steps
  if (plan && Array.isArray(plan)) {
    for (const item of plan) {
      if (typeof item.step !== "string") return "Error: step is required for each plan item";
      const stepText = item.step.trim();
      const existing = planSteps.find(s => s.text === stepText);
      if (existing) {
        const previousStatus = existing.status;
        existing.status = (item.status as PlanStep["status"]) || existing.status;
        if (item.status === "in_progress" && !existing.started_at) {
          existing.started_at = Date.now();
        }
        if (item.status === "in_progress") enforceSingleActivePlanStep(existing.text);
        if (item.status === "completed" && previousStatus !== "completed") {
          existing.completed_at = Date.now();
        }
      }
    }
  } else if (explanation) {
    // Narrative update — just add context, don't change plan
    return `Plan context updated: ${explanation.slice(0, 500)}`;
  }

  // Render current plan
  if (planSteps.length === 0) {
    return "No active plan. Use update_plan with plan items to create one.";
  }

  const lines: string[] = [];
  if (explanation) lines.push(`Context: ${explanation}\n`);

  const completed = planSteps.filter(s => s.status === "completed").length;
  const total = planSteps.length;
  const pct = Math.round((completed / total) * 100);
  lines.push(`Progress: ${completed}/${total} (${pct}%)`);

  for (const step of planSteps) {
    const sym = STATUS_SYMBOLS[step.status];
    let timing = "";
    if (step.started_at && step.completed_at) {
      const secs = Math.round((step.completed_at - step.started_at) / 1000);
      timing = ` (${secs}s)`;
    }
    lines.push(`  ${sym} ${step.text}${timing}`);
  }

  return lines.join("\n");
}

// Also provide a way to set the full plan
async function setPlan(args: Record<string, unknown>): Promise<string> {
  const explanationText = args.explanation === undefined
    ? { value: "" }
    : normalizeBoundedText(args.explanation, "explanation", MAX_EXPLANATION_CHARS, { required: false });
  if ("error" in explanationText) {
    return `Error: ${explanationText.error}`;
  }
  const planError = validatePlanItemsInput(args.plan);
  if (planError) return `Error: ${planError}`;
  const explanation = explanationText.value;
  const plan = args.plan as Array<{ step: string; status?: string }> | undefined;

  if (plan && Array.isArray(plan)) {
    const normalizedPlan = ensureSingleInProgress(plan.map(p => ({
      ...p,
      step: p.step.trim(),
      status: (p.status as PlanStep["status"]) || "pending",
    })));
    if (planSteps.length === 0) {
      planSteps = normalizedPlan.map(p => makePlanStep(p.step, p.status));
    } else {
      for (const item of normalizedPlan) {
        if (typeof item.step !== "string") return "Error: step is required for each plan item";
        const stepText = item.step;
        const existing = planSteps.find(step => step.text === stepText);
        if (existing) {
          const previousStatus = existing.status;
          existing.status = item.status;
          if (item.status === "in_progress" && !existing.started_at) existing.started_at = Date.now();
          if (item.status === "in_progress") enforceSingleActivePlanStep(existing.text);
          if (item.status === "completed" && previousStatus !== "completed") existing.completed_at = Date.now();
          continue;
        }
        planSteps.push(makePlanStep(stepText, item.status));
        if (item.status === "in_progress") enforceSingleActivePlanStep(stepText);
      }
    }
    return updatePlan({ ...args, plan: normalizedPlan });
  }

  return updatePlan(args);
}

function makePlanStep(text: string, status: PlanStep["status"]): PlanStep {
  const step: PlanStep = { text, status };
  if (status === "in_progress") step.started_at = Date.now();
  if (status === "completed") step.completed_at = Date.now();
  return step;
}

// ── note ─────────────────────────────────────────────────────

async function note(args: Record<string, unknown>): Promise<string> {
  if (args.action !== undefined && typeof args.action !== "string") {
    return "Error: action must be a string.";
  }
  const action = normalizeNoteAction(args.action);
  if (typeof action === "string" && action.includes("\0")) return "Error: action must not contain NUL bytes.";
  if (typeof action === "string" && STATE_CONTROL_RE.test(action)) return "Error: action must not contain control characters.";
  const titleResult = normalizeBoundedText(args.title, "title", MAX_NOTE_TITLE_CHARS, { required: true });
  const title = "value" in titleResult ? titleResult.value : "";
  const contentResult = args.content === undefined
    ? { value: "" }
    : normalizeBoundedText(args.content, "content", MAX_NOTE_CONTENT_CHARS, { required: false, trim: false });

  if (action !== "list" && "error" in titleResult) {
    return `Error: ${titleResult.error}`;
  }
  if ((action === "add" || action === "set") && "error" in contentResult) {
    return `Error: ${contentResult.error}`;
  }

  if (action === "add" || action === "set") {
    if ("error" in contentResult) return `Error: ${contentResult.error}`;
    const noteContent = contentResult.value;
    // Update existing or add new
    const existing = notes.find(n => n.title === title);
    if (existing) {
      existing.content = noteContent;
      existing.created_at = new Date().toISOString();
    } else {
      notes.push({ title, content: noteContent, created_at: new Date().toISOString() });
      if (notes.length > MAX_NOTES) notes = notes.slice(-MAX_NOTES);
    }
    return `Note saved: "${title}"`;
  }

  if (action === "list") {
    if (!notes.length) return "No notes saved.";
    return notes.map(n =>
      `- **${n.title}** (${n.created_at.slice(0, 10)}): ${n.content.slice(0, 200)}`
    ).join("\n");
  }

  if (action === "get") {
    const n = notes.find(n => n.title === title);
    return n ? `**${n.title}** (${n.created_at.slice(0, 10)}):\n${n.content}` : `Note not found: "${title}"`;
  }

  if (action === "delete") {
    const idx = notes.findIndex(n => n.title === title);
    if (idx >= 0) { notes.splice(idx, 1); return `Note deleted: "${title}"`; }
    return `Note not found: "${title}"`;
  }

  return `Unknown action: ${action}. Use add/set, get, list, or delete.`;
}

export function registerPlanTools(): void {
  const r = getRegistry();

  r.register({
    name: "checklist_write",
    description: "Create an action checklist for your current coding session. Break work into concrete, verifiable steps. Mark the first one in_progress. Updates the sidebar so the user can track progress. Use this BEFORE starting any non-trivial task.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Array of {content: string, status?: 'pending'|'in_progress'|'completed'} objects",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Task description" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], default: "pending" },
            },
            required: ["content"],
          },
        },
      },
      required: ["items"],
    },
    execute: checklistWrite,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: false,
    validateInput: (args) => {
      const normalized = normalizeChecklistItemsInput(args.items);
      return "error" in normalized
        ? { ok: false as const, message: normalized.error }
        : { ok: true as const, args: { ...args, items: ensureSingleInProgress(normalized.items) } };
    },
    searchHint: "write task checklist",
    resultKind: "task",
  });

  r.register({
    name: "update_plan",
    description: "Manage a high-level strategic plan (3-6 phases). Use this for complex multi-phase work. Layer checklist_write under each phase for granular steps. Update status as phases progress. Include an explanation field for narrative context.",
    parameters: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Narrative explanation of the plan or progress update" },
        plan: {
          type: "array",
          description: "Array of {step: string, status?: 'pending'|'in_progress'|'completed'} objects",
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: "Phase or step name" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], default: "pending" },
            },
            required: ["step"],
          },
        },
      },
    },
    execute: setPlan,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: false,
    validateInput: (args) => {
      if (args.explanation !== undefined) {
        const explanation = normalizeBoundedText(args.explanation, "explanation", MAX_EXPLANATION_CHARS, { required: false });
        if ("error" in explanation) return { ok: false as const, message: explanation.error };
      }
      const planError = validatePlanItemsInput(args.plan);
      return planError ? { ok: false as const, message: planError } : { ok: true as const, args };
    },
    searchHint: "update work plan",
    resultKind: "task",
  });

  r.register({
    name: "note",
    description: "Persistent memory for cross-session context. Use sparingly for important decisions, open blockers, and architectural context. Not for temporary scratch notes — use think for that.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title (used as key)" },
        content: { type: "string", description: "Note content" },
        action: { type: "string", enum: ["add", "set", "get", "list", "delete"], default: "set" },
      },
    },
    execute: note,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: false,
    validateInput: (args) => {
      if (args.action !== undefined && typeof args.action !== "string") {
        return { ok: false as const, message: "action must be a string" };
      }
      const action = normalizeNoteAction(args.action || "set");
      if (action.includes("\0")) return { ok: false as const, message: "action must not contain NUL bytes" };
      if (STATE_CONTROL_RE.test(action)) return { ok: false as const, message: "action must not contain control characters" };
      if (action === "list") return { ok: true, args: { ...args, action } };
      const title = normalizeBoundedText(args.title, "title", MAX_NOTE_TITLE_CHARS, { required: true });
      if ("error" in title) return { ok: false, message: title.error === "title must be a string." ? "title is required" : title.error };
      if ((action === "add" || action === "set") && args.content !== undefined) {
        const content = normalizeBoundedText(args.content, "content", MAX_NOTE_CONTENT_CHARS, { required: false, trim: false });
        if ("error" in content) return { ok: false, message: content.error };
      }
      return { ok: true, args: { ...args, action, title: title.value } };
    },
    searchHint: "persistent notes",
    resultKind: "text",
    readOnly: (args) => ["list", "get"].includes(normalizeNoteAction(args.action)),
  });

  // Also add a debug command
  r.register({
    name: "plan_status",
    description: "Show current plan and checklist state. Read-only diagnostic.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      const lines: string[] = [];
      if (planSteps.length) {
        lines.push("## Plan\n");
        const pct = Math.round((planSteps.filter(s => s.status === "completed").length / planSteps.length) * 100);
        lines.push(`Progress: ${pct}%\n`);
        for (const s of planSteps) lines.push(`  ${STATUS_SYMBOLS[s.status]} ${s.text}`);
      }
      if (todoItems.length) {
        lines.push("\n## Checklist\n");
        for (const t of todoItems) lines.push(`  ${STATUS_SYMBOLS[t.status]} [${t.id}] ${t.content}`);
      }
      return lines.join("\n") || "No active plan or checklist.";
    },
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "meta",
    parallelOk: true,
    readOnly: true,
    searchHint: "show plan state",
    resultKind: "task",
  });
}
