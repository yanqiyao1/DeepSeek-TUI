import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearPersistentTaskStateForTests, getTaskManager } from "../src/engine/task-lifecycle.js";
import { clearGoalState, getGoalState, registerGoalTools, trackGoalElapsed, trackGoalTokenUsage, trackGoalTurn } from "../src/tools/goal.js";
import { clearPlanState, formatTodoState, getNoteState, getPlanState, getTodoState, registerPlanTools } from "../src/tools/plan.js";
import { getRegistry } from "../src/tools/registry.js";
import { registerTaskTools } from "../src/tools/tasks.js";
import { registerThinkTool } from "../src/tools/think.js";

beforeEach(() => {
  getRegistry().clear();
  clearPlanState();
  clearGoalState();
  clearPersistentTaskStateForTests();
});

afterEach(() => {
  getRegistry().clear();
  clearPlanState();
  clearGoalState();
  clearPersistentTaskStateForTests();
});

describe("plan tools", () => {
  it("rejects malformed checklist payloads", async () => {
    registerPlanTools();
    const checklistTool = getRegistry().lookup("checklist_write")!;

    expect(await checklistTool.validateInput?.(
      { items: "nope" as any },
      { tool_name: "checklist_write", workspace_path: "/tmp/workspace", tool_def: checklistTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("items must be an array"),
    });

    expect(await checklistTool.execute({ items: "nope" as any })).toBe("Error: items must be an array");
  });

  it("rejects malformed checklist items during validation instead of deferring shape errors until execution", async () => {
    registerPlanTools();
    const checklistTool = getRegistry().lookup("checklist_write")!;

    expect(await checklistTool.validateInput?.(
      { items: [{ status: "completed" } as any] },
      { tool_name: "checklist_write", workspace_path: "/tmp/workspace", tool_def: checklistTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("content is required"),
    });

    expect(await checklistTool.validateInput?.(
      { items: [{ content: "bad", status: "done" as any }] },
      { tool_name: "checklist_write", workspace_path: "/tmp/workspace", tool_def: checklistTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("status must be pending, in_progress, or completed"),
    });
  });

  it("rejects malformed checklist items without mutating existing checklist state", async () => {
    registerPlanTools();
    await getRegistry().lookup("checklist_write")!.execute({
      items: [{ content: "keep me", status: "pending" }],
    });

    const result = await getRegistry().lookup("checklist_write")!.execute({
      items: [{ status: "completed" } as any],
    });

    expect(result).toContain("content is required");
    expect(getTodoState()).toMatchObject([{ id: 1, content: "keep me", status: "pending" }]);
  });

  it("rejects malformed falsy checklist statuses instead of silently defaulting them to pending", async () => {
    registerPlanTools();
    await getRegistry().lookup("checklist_write")!.execute({
      items: [{ content: "keep me", status: "pending" }],
    });

    const result = await getRegistry().lookup("checklist_write")!.execute({
      items: [{ content: "bad status", status: "" as any }],
    });

    expect(result).toContain("status must be pending, in_progress, or completed");
    expect(getTodoState()).toMatchObject([{ id: 1, content: "keep me", status: "pending" }]);
  });

  it("renders checklist summaries with truncation", async () => {
    registerPlanTools();
    await getRegistry().lookup("checklist_write")!.execute({
      items: Array.from({ length: 5 }, (_, index) => ({
        content: `task-${index}`,
        status: index === 0 ? "in_progress" : index === 4 ? "completed" : "pending",
      })),
    });

    expect(formatTodoState(3)).toContain("Checklist: 5 tasks, 1 in progress, 1 completed");
    expect(formatTodoState(3)).toContain("... 2 more");
  });

  it("keeps only one checklist item in progress when multiple active items are supplied", async () => {
    registerPlanTools();
    const checklistTool = getRegistry().lookup("checklist_write")!;

    expect(await checklistTool.validateInput?.(
      {
        items: [
          { content: "first", status: "in_progress" },
          { content: "second", status: "in_progress" },
          { content: "third", status: "completed" },
        ],
      },
      { tool_name: "checklist_write", workspace_path: "/tmp/workspace", tool_def: checklistTool },
    )).toMatchObject({
      ok: true,
      args: {
        items: [
          { content: "first", status: "in_progress" },
          { content: "second", status: "pending" },
          { content: "third", status: "completed" },
        ],
      },
    });

    await checklistTool.execute({
      items: [
        { content: "first", status: "in_progress" },
        { content: "second", status: "in_progress" },
      ],
    });

    expect(getTodoState().map(item => item.status)).toEqual(["in_progress", "pending"]);
  });

  it("rejects oversized or NUL-containing checklist content without mutating state", async () => {
    registerPlanTools();
    const checklistTool = getRegistry().lookup("checklist_write")!;
    await checklistTool.execute({ items: [{ content: "keep", status: "pending" }] });

    expect(await checklistTool.execute({
      items: [{ content: `bad${String.fromCharCode(0)}item`, status: "pending" }],
    })).toContain("content must not contain NUL bytes");
    expect(await checklistTool.execute({
      items: [{ content: "x".repeat(1001), status: "pending" }],
    })).toContain("content must be at most 1000 characters");
    expect(await checklistTool.execute({
      items: Array.from({ length: 201 }, (_, index) => ({ content: `task-${index}` })),
    })).toContain("items must contain at most 200 entries");
    expect(getTodoState()).toMatchObject([{ content: "keep", status: "pending" }]);
  });

  it("rejects control-character checklist content without mutating state", async () => {
    registerPlanTools();
    const checklistTool = getRegistry().lookup("checklist_write")!;
    await checklistTool.execute({ items: [{ content: "keep", status: "pending" }] });

    expect(await checklistTool.validateInput?.(
      { items: [{ content: "bad\u0007item", status: "pending" }] },
      { tool_name: "checklist_write", workspace_path: "/tmp/workspace", tool_def: checklistTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("content must not contain control characters"),
    });
    expect(await checklistTool.execute({
      items: [{ content: "bad\u0007item", status: "pending" }],
    })).toContain("content must not contain control characters");
    expect(getTodoState()).toMatchObject([{ content: "keep", status: "pending" }]);
  });

  it("creates and updates a multi-step plan with progress tracking", async () => {
    registerPlanTools();

    await getRegistry().lookup("update_plan")!.execute({
      plan: [
        { step: "Survey repo", status: "completed" },
        { step: "Add tests", status: "in_progress" },
        { step: "Fix bugs", status: "pending" },
      ],
    });
    const updated = await getRegistry().lookup("update_plan")!.execute({
      explanation: "moving forward",
      plan: [
        { step: "Add tests", status: "completed" },
        { step: "Fix bugs", status: "in_progress" },
      ],
    });

    expect(updated).toContain("Progress: 2/3 (67%)");
    expect(updated).toContain("Context: moving forward");
    expect(getPlanState().map(step => step.status)).toEqual(["completed", "completed", "in_progress"]);
  });

  it("keeps only one plan step in progress when creating or updating a plan", async () => {
    registerPlanTools();
    const updatePlan = getRegistry().lookup("update_plan")!;

    await updatePlan.execute({
      plan: [
        { step: "One", status: "in_progress" },
        { step: "Two", status: "in_progress" },
        { step: "Three", status: "pending" },
      ],
    });

    expect(getPlanState().map(step => step.status)).toEqual(["in_progress", "pending", "pending"]);

    await updatePlan.execute({
      plan: [{ step: "Three", status: "in_progress" }],
    });

    expect(getPlanState().map(step => step.status)).toEqual(["pending", "pending", "in_progress"]);
  });

  it("rejects oversized or NUL-containing plan text and explanations without mutating state", async () => {
    registerPlanTools();
    const updatePlan = getRegistry().lookup("update_plan")!;
    await updatePlan.execute({ plan: [{ step: "Keep this", status: "pending" }] });

    expect(await updatePlan.execute({
      plan: [{ step: `bad${String.fromCharCode(0)}step`, status: "pending" }],
    })).toContain("step must not contain NUL bytes");
    expect(await updatePlan.execute({
      plan: [{ step: "x".repeat(1001), status: "pending" }],
    })).toContain("step must be at most 1000 characters");
    expect(await updatePlan.execute({
      plan: Array.from({ length: 101 }, (_, index) => ({ step: `step-${index}` })),
    })).toContain("plan must contain at most 100 items");
    expect(await updatePlan.execute({ explanation: "x".repeat(2001) })).toContain("explanation must be at most 2000 characters");
    expect(getPlanState()).toMatchObject([{ text: "Keep this", status: "pending" }]);
  });

  it("rejects control-character plan steps and explanations without mutating state", async () => {
    registerPlanTools();
    const updatePlan = getRegistry().lookup("update_plan")!;
    await updatePlan.execute({ plan: [{ step: "Keep this", status: "pending" }] });

    expect(await updatePlan.validateInput?.(
      { plan: [{ step: "bad\u0007step", status: "pending" }] },
      { tool_name: "update_plan", workspace_path: "/tmp/workspace", tool_def: updatePlan },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("step must not contain control characters"),
    });
    expect(await updatePlan.execute({
      plan: [{ step: "bad\u0007step", status: "pending" }],
    })).toContain("step must not contain control characters");
    expect(await updatePlan.execute({ explanation: "bad\u0007context" })).toContain("explanation must not contain control characters");
    expect(getPlanState()).toMatchObject([{ text: "Keep this", status: "pending" }]);
  });

  it("returns defensive copies of plan, checklist, and note state", async () => {
    registerPlanTools();
    await getRegistry().lookup("update_plan")!.execute({ plan: [{ step: "Safe", status: "pending" }] });
    await getRegistry().lookup("checklist_write")!.execute({ items: [{ content: "Safe item", status: "pending" }] });
    await getRegistry().lookup("note")!.execute({ title: "Safe note", content: "content" });

    getPlanState()[0]!.text = "mutated";
    getTodoState()[0]!.content = "mutated";
    getNoteState()[0]!.title = "mutated";

    expect(getPlanState()[0]!.text).toBe("Safe");
    expect(getTodoState()[0]!.content).toBe("Safe item");
    expect(getNoteState()[0]!.title).toBe("Safe note");
  });

  it("returns a narrative update when no plan exists yet", async () => {
    registerPlanTools();
    expect(await getRegistry().lookup("update_plan")!.execute({ explanation: "thinking out loud" })).toBe("Plan context updated: thinking out loud");
  });

  it("rejects malformed update_plan items without mutating existing plan state", async () => {
    registerPlanTools();
    await getRegistry().lookup("update_plan")!.execute({
      plan: [{ step: "Keep this", status: "pending" }],
    });

    const result = await getRegistry().lookup("update_plan")!.execute({
      plan: [{ status: "completed" } as any],
    });

    expect(result).toContain("step is required");
    expect(getPlanState()).toMatchObject([{ text: "Keep this", status: "pending" }]);
  });

  it("rejects non-array update_plan payloads instead of treating them like harmless narrative updates", async () => {
    registerPlanTools();
    const updatePlanTool = getRegistry().lookup("update_plan")!;

    await updatePlanTool.execute({
      plan: [{ step: "Keep this", status: "pending" }],
    });

    expect(await updatePlanTool.validateInput?.(
      { plan: { step: "bad shape" } as any },
      { tool_name: "update_plan", workspace_path: "/tmp/workspace", tool_def: updatePlanTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("plan must be an array"),
    });

    const result = await updatePlanTool.execute({
      plan: { step: "bad shape" } as any,
    });

    expect(result).toContain("plan must be an array");
    expect(getPlanState()).toMatchObject([{ text: "Keep this", status: "pending" }]);
  });

  it("rejects invalid plan statuses instead of corrupting progress state", async () => {
    registerPlanTools();

    const result = await getRegistry().lookup("update_plan")!.execute({
      plan: [{ step: "Broken", status: "done" as any }],
    });

    expect(result).toContain("status must be pending, in_progress, or completed");
    expect(getPlanState()).toEqual([]);
  });

  it("rejects non-string update_plan explanations instead of throwing", async () => {
    registerPlanTools();

    await expect(getRegistry().lookup("update_plan")!.execute({
      explanation: { detail: "bad" } as any,
    })).resolves.toContain("explanation must be a string");
  });

  it("stores, lists, reads, updates, and deletes notes", async () => {
    registerPlanTools();
    const note = getRegistry().lookup("note")!;

    expect(await note.execute({ title: "idea", content: "first version" })).toContain("Note saved");
    expect(await note.execute({ action: "get", title: "idea" })).toContain("first version");
    expect(await note.execute({ title: "idea", content: "second version", action: "set" })).toContain("Note saved");
    expect(await note.execute({ action: "list" })).toContain("second version");
    expect(getNoteState()).toHaveLength(1);
    expect(await note.execute({ action: "delete", title: "idea" })).toContain("Note deleted");
    expect(await note.execute({ action: "get", title: "idea" })).toContain("Note not found");
  });

  it("reports unknown note actions clearly", async () => {
    registerPlanTools();
    expect(await getRegistry().lookup("note")!.execute({ action: "archive", title: "idea" })).toContain("Unknown action: archive");
  });

  it("normalizes note actions case-insensitively across validation and execution", async () => {
    registerPlanTools();
    const noteTool = getRegistry().lookup("note")!;

    expect(await noteTool.execute({ title: "idea", content: "mixed case works" })).toContain("Note saved");
    expect(await noteTool.execute({ action: "GET", title: "idea" })).toContain("mixed case works");
    expect(await noteTool.execute({ action: "LIST" })).toContain("mixed case works");

    expect(await noteTool.validateInput?.(
      { action: "GET", title: "idea" },
      { tool_name: "note", workspace_path: "/tmp/workspace", tool_def: noteTool },
    )).toMatchObject({
      ok: true,
      args: { action: "get", title: "idea" },
    });
  });

  it("rejects direct note get/delete calls without a title instead of using an Untitled fallback", async () => {
    registerPlanTools();
    const noteTool = getRegistry().lookup("note")!;

    expect(await noteTool.execute({ action: "get" })).toContain("title must be a string");
    expect(await noteTool.execute({ action: "delete" })).toContain("title must be a string");
  });

  it("rejects non-string note content instead of corrupting note state", async () => {
    registerPlanTools();
    const noteTool = getRegistry().lookup("note")!;

    expect(await noteTool.validateInput?.(
      { title: "idea", content: { nested: true } as any },
      { tool_name: "note", workspace_path: "/tmp/workspace", tool_def: noteTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("content must be a string"),
    });

    expect(await noteTool.execute({ title: "idea", content: { nested: true } as any })).toContain("content must be a string");
    expect(getNoteState()).toEqual([]);
  });

  it("bounds note titles, content, and retained note count", async () => {
    registerPlanTools();
    const noteTool = getRegistry().lookup("note")!;

    expect(await noteTool.execute({ title: `bad${String.fromCharCode(0)}title`, content: "x" })).toContain("title must not contain NUL bytes");
    expect(await noteTool.execute({ title: "x".repeat(201), content: "x" })).toContain("title must be at most 200 characters");
    expect(await noteTool.execute({ title: "large", content: "x".repeat(20_001) })).toContain("content must be at most 20000 characters");

    for (let index = 0; index < 105; index++) {
      await noteTool.execute({ title: `note-${index}`, content: "x" });
    }

    expect(getNoteState()).toHaveLength(100);
    expect(getNoteState()[0]!.title).toBe("note-5");
  });

  it("rejects note control characters beyond NUL consistently", async () => {
    registerPlanTools();
    const noteTool = getRegistry().lookup("note")!;

    expect(await noteTool.validateInput?.(
      { action: "set", title: "bad\u0007title", content: "x" },
      { tool_name: "note", workspace_path: "/tmp/workspace", tool_def: noteTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("title must not contain control characters"),
    });
    expect(await noteTool.execute({ title: "bad\u0007title", content: "x" })).toContain("title must not contain control characters");
    expect(await noteTool.execute({ title: "ok", content: "bad\u0007content" })).toContain("content must not contain control characters");
    expect(await noteTool.execute({ action: "GET\u0007", title: "ok" })).toContain("action must not contain control characters");
    expect(getNoteState()).toEqual([]);
  });

  it("validates title requirements by note action instead of requiring one for list", async () => {
    registerPlanTools();
    const noteTool = getRegistry().lookup("note")!;

    expect(await noteTool.validateInput?.(
      { action: "list" },
      { tool_name: "note", workspace_path: "/tmp/workspace", tool_def: noteTool },
    )).toMatchObject({ ok: true });

    expect(await noteTool.validateInput?.(
      { action: "get" },
      { tool_name: "note", workspace_path: "/tmp/workspace", tool_def: noteTool },
    )).toMatchObject({ ok: false, message: expect.stringContaining("title is required") });
  });

  it("rejects non-string note titles during validation instead of stringifying them into note keys", async () => {
    registerPlanTools();
    const noteTool = getRegistry().lookup("note")!;

    expect(await noteTool.validateInput?.(
      { title: { nested: true } as any, content: "bad title" },
      { tool_name: "note", workspace_path: "/tmp/workspace", tool_def: noteTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("title is required"),
    });
  });

  it("rejects malformed note actions during validation and execution instead of silently defaulting to add", async () => {
    registerPlanTools();
    const noteTool = getRegistry().lookup("note")!;

    expect(await noteTool.validateInput?.(
      { action: { nested: true } as any, title: "idea", content: "bad action" },
      { tool_name: "note", workspace_path: "/tmp/workspace", tool_def: noteTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("action must be a string"),
    });

    expect(await noteTool.execute({ action: { nested: true } as any, title: "idea", content: "bad action" })).toContain("action must be a string");
    expect(getNoteState()).toEqual([]);
  });

  it("rejects malformed update_plan step values during execution instead of stringifying them into fake plan text", async () => {
    registerPlanTools();
    await getRegistry().lookup("update_plan")!.execute({
      plan: [{ step: "Keep this", status: "pending" }],
    });

    const result = await getRegistry().lookup("update_plan")!.execute({
      plan: [{ step: { nested: true } as any, status: "completed" }],
    });

    expect(result).toContain("step is required");
    expect(getPlanState()).toMatchObject([{ text: "Keep this", status: "pending" }]);
  });
});

describe("goal tools", () => {
  it("rejects empty objectives and non-positive budgets", async () => {
    registerGoalTools();
    const create = getRegistry().lookup("create_goal")!;

    expect(await create.execute({ objective: "   " })).toContain("objective is required");
    expect(await create.execute({ objective: "ship it", token_budget: 0 })).toContain("token_budget must be a positive integer");
    expect(await create.execute({ objective: "ship it", token_budget: -1 })).toContain("token_budget must be a positive integer");
  });

  it("rejects non-integer and non-numeric goal budgets instead of coercing them into tracked limits", async () => {
    registerGoalTools();
    const create = getRegistry().lookup("create_goal")!;

    expect(await create.validateInput?.(
      { objective: "ship it", token_budget: "500" as any },
      { tool_name: "create_goal", workspace_path: "/tmp/workspace", tool_def: create },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("token_budget must be a positive integer"),
    });
    expect(await create.execute({ objective: "ship it", token_budget: "500" as any })).toContain("token_budget must be a positive integer");
    expect(await create.execute({ objective: "ship it", token_budget: 1.5 })).toContain("token_budget must be a positive integer");
    expect(getGoalState()).toBeNull();
  });

  it("rejects non-string goal objectives without throwing", async () => {
    registerGoalTools();

    await expect(getRegistry().lookup("create_goal")!.execute({ objective: 42 as any })).resolves.toContain("objective is required");
  });

  it("tracks goal token, turn, and elapsed usage", async () => {
    registerGoalTools();
    await getRegistry().lookup("create_goal")!.execute({ objective: "stabilize runtime", token_budget: 500 });

    trackGoalTokenUsage(123);
    trackGoalTurn();
    trackGoalTurn();
    trackGoalElapsed();

    const snapshot = getGoalState();
    const rendered = await getRegistry().lookup("get_goal")!.execute({});

    expect(snapshot).toMatchObject({ tokens_used: 123, turns_used: 2, token_budget: 500, status: "active" });
    expect(rendered).toContain("123 / 500 tokens");
    expect(rendered).toContain("Turns: 2");
  });

  it("ignores invalid goal usage counters", async () => {
    registerGoalTools();
    await getRegistry().lookup("create_goal")!.execute({ objective: "count safely", token_budget: 500 });

    trackGoalTokenUsage(Number.NaN);
    trackGoalTokenUsage(-5);
    trackGoalTokenUsage(1.5);
    trackGoalTokenUsage(25);
    trackGoalTurn();
    trackGoalElapsed();

    expect(getGoalState()).toMatchObject({ tokens_used: 25, turns_used: 1 });
  });

  it("prevents duplicate active goals and supports completion and abandonment", async () => {
    registerGoalTools();
    const create = getRegistry().lookup("create_goal")!;
    const update = getRegistry().lookup("update_goal")!;

    expect(await create.execute({ objective: "first" })).toContain("Goal created");
    expect(await create.execute({ objective: "second" })).toContain("already active");
    expect(await update.execute({ status: "complete", result: "done" })).toContain("Goal marked complete");
    expect(getGoalState()).toBeNull();
    expect(await create.execute({ objective: "second" })).toContain("Goal created");

    clearGoalState();
    await create.execute({ objective: "third" });
    expect(await update.execute({ status: "abandon" })).toContain("Goal abandoned");
    expect(getGoalState()).toBeNull();
  });

  it("normalizes surrounding whitespace in goal update statuses during execution", async () => {
    registerGoalTools();
    const update = getRegistry().lookup("update_goal")!;

    await getRegistry().lookup("create_goal")!.execute({ objective: "trim complete" });
    expect(await update.execute({ status: " complete " })).toContain("Goal marked complete");

    clearGoalState();
    await getRegistry().lookup("create_goal")!.execute({ objective: "trim abandon" });
    expect(await update.execute({ status: " abandon " })).toContain("Goal abandoned");
  });

  it("reports goal update errors without an active goal or status", async () => {
    registerGoalTools();
    const update = getRegistry().lookup("update_goal")!;

    expect(await update.execute({ status: "complete" })).toContain("No active goal");
    await getRegistry().lookup("create_goal")!.execute({ objective: "test goal" });
    expect(await update.execute({})).toContain("status is required");
    expect(await update.execute({ status: "pause" })).toContain("Unknown status: pause");
  });

  it("rejects unsupported goal update statuses during validation instead of deferring them to execution", async () => {
    registerGoalTools();
    const update = getRegistry().lookup("update_goal")!;
    await getRegistry().lookup("create_goal")!.execute({ objective: "test goal" });

    expect(await update.validateInput?.(
      { status: "pause" },
      { tool_name: "update_goal", workspace_path: "/tmp/workspace", tool_def: update },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("status must be 'complete' or 'abandon'"),
    });
  });

  it("rejects non-string goal update statuses without coercing them", async () => {
    registerGoalTools();
    await getRegistry().lookup("create_goal")!.execute({ objective: "test goal" });

    expect(await getRegistry().lookup("update_goal")!.execute({ status: { nested: true } as any })).toContain("status is required");
  });

  it("rejects oversized or NUL-containing goal objective and result text", async () => {
    registerGoalTools();
    const create = getRegistry().lookup("create_goal")!;
    const update = getRegistry().lookup("update_goal")!;

    expect(await create.execute({ objective: `bad${String.fromCharCode(0)}goal` })).toContain("objective must not contain NUL bytes");
    expect(await create.execute({ objective: "x".repeat(2001) })).toContain("objective must be at most 2000 characters");
    await create.execute({ objective: "bounded result" });
    expect(await update.execute({ status: "complete", result: `bad${String.fromCharCode(0)}result` })).toContain("result must not contain NUL bytes");
    expect(await update.execute({ status: "complete", result: "x".repeat(10_001) })).toContain("result must be at most 10000 characters");
    expect(getGoalState()?.status).toBe("active");
  });

  it("rejects non-string goal completion results without silently marking the goal complete", async () => {
    registerGoalTools();
    const update = getRegistry().lookup("update_goal")!;
    await getRegistry().lookup("create_goal")!.execute({ objective: "test goal" });

    expect(await update.validateInput?.(
      { status: "complete", result: { nested: true } as any },
      { tool_name: "update_goal", workspace_path: "/tmp/workspace", tool_def: update },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("result must be a string"),
    });
    expect(await update.execute({ status: "complete", result: { nested: true } as any })).toContain("result must be a string");
    expect(getGoalState()?.status).toBe("active");
  });
});

describe("task tools", () => {
  it("rejects unknown task types instead of silently coercing them to background", async () => {
    registerTaskTools();
    const created = await getRegistry().lookup("task_create")!.execute({
      description: "weird type",
      type: "mystery",
    });

    expect(created).toContain("type must be one of");
    expect(await getRegistry().lookup("task_list")!.execute({})).toBe("No tasks.");
  });

  it("accepts prompt as a fallback task description", async () => {
    registerTaskTools();
    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({
      prompt: "follow up later",
    }));

    expect(created.description).toBe("follow up later");
  });

  it("normalizes prompt into description for task_create validation", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;
    const validation = await taskCreate.validateInput?.(
      { prompt: "follow up later" },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: { description: "follow up later" },
    });
  });

  it("rejects non-string task_create descriptions instead of coercing them into persisted tasks", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;

    expect(await taskCreate.validateInput?.(
      { description: { nested: true } as any },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("description is required"),
    });
    expect(await taskCreate.validateInput?.(
      { prompt: { nested: true } as any },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("description is required"),
    });

    expect(await taskCreate.execute({ description: { nested: true } as any })).toContain("description is required");
    expect(await taskCreate.execute({ prompt: { nested: true } as any })).toContain("description is required");
    expect(await getRegistry().lookup("task_list")!.execute({})).toBe("No tasks.");
  });

  it("rejects non-string task_create commands instead of stringifying them into durable shell tasks", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;

    expect(await taskCreate.validateInput?.(
      { description: "queue shell work", command: { nested: true } as any },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("command must be a string"),
    });

    expect(await getRegistry().lookup("task_create")!.execute({
      description: "queue shell work",
      command: { nested: true } as any,
    })).toContain("command must be a string");
    expect(await getRegistry().lookup("task_list")!.execute({})).toBe("No tasks.");
  });

  it("rejects malformed task_create workdir and numeric options instead of silently normalizing them away", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;

    expect(await taskCreate.validateInput?.(
      { description: "queue shell work", workdir: { nested: true } as any },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await taskCreate.validateInput?.(
      { description: "queue shell work", cwd: { nested: true } as any },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await taskCreate.validateInput?.(
      { description: "queue shell work", timeout: { nested: true } as any },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("timeout must be a number"),
    });
    expect(await taskCreate.validateInput?.(
      { description: "queue shell work", max_attempts: { nested: true } as any },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_attempts must be a number"),
    });

    expect(await taskCreate.execute({
      description: "queue shell work",
      workdir: { nested: true } as any,
    })).toContain("workdir must be a string");
    expect(await taskCreate.execute({
      description: "queue shell work",
      cwd: { nested: true } as any,
    })).toContain("workdir must be a string");
    expect(await taskCreate.execute({
      description: "queue shell work",
      timeout: { nested: true } as any,
    })).toContain("timeout must be a number");
    expect(await taskCreate.execute({
      description: "queue shell work",
      max_attempts: { nested: true } as any,
    })).toContain("max_attempts must be a number");
    expect(await getRegistry().lookup("task_list")!.execute({})).toBe("No tasks.");
  });

  it("rejects non-positive and over-limit task_create numeric options instead of defaulting them", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;

    for (const value of [0, -1, "0", "-5"]) {
      expect(await taskCreate.validateInput?.(
        { description: "bad timeout", command: "printf ok", timeout: value },
        { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("timeout must be a positive integer"),
      });
      expect(await taskCreate.execute({
        description: "bad timeout",
        command: "printf ok",
        timeout: value,
      })).toContain("timeout must be a positive integer");

      expect(await taskCreate.validateInput?.(
        { description: "bad attempts", command: "printf ok", max_attempts: value },
        { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("max_attempts must be a positive integer"),
      });
      expect(await taskCreate.execute({
        description: "bad attempts",
        command: "printf ok",
        max_attempts: value,
      })).toContain("max_attempts must be a positive integer");
    }

    expect(await taskCreate.validateInput?.(
      { description: "too long timeout", command: "printf ok", timeout: 86_400_001 },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("timeout must be at most 86400000"),
    });
    expect(await taskCreate.execute({
      description: "too long timeout",
      command: "printf ok",
      timeout: 86_400_001,
    })).toContain("timeout must be at most 86400000");
    expect(await getRegistry().lookup("task_list")!.execute({})).toBe("No tasks.");
  });

  it("rejects malformed task_create types instead of silently coercing them into background tasks", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;

    expect(await taskCreate.validateInput?.(
      { description: "typed task", type: { nested: true } as any },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("type must be one of"),
    });
    expect(await taskCreate.validateInput?.(
      { description: "typed task", type: "weird" },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("type must be one of"),
    });

    expect(await taskCreate.execute({
      description: "typed task",
      type: { nested: true } as any,
    })).toContain("type must be one of");
    expect(await taskCreate.execute({
      description: "typed task",
      type: "weird",
    })).toContain("type must be one of");
    expect(await getRegistry().lookup("task_list")!.execute({})).toBe("No tasks.");
  });

  it("trims task_create workdir aliases during validation and execution", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;
    const workdir = mkdtempSync(join(tmpdir(), "seek-code-task-workdir-"));

    try {
      expect(await taskCreate.validateInput?.(
        { description: "trimmed pwd task", command: "pwd", cwd: `  ${workdir}  ` },
        { tool_name: "task_create", workspace_path: workdir, tool_def: taskCreate },
      )).toMatchObject({
        ok: true,
        args: {
          description: "trimmed pwd task",
          command: "pwd",
          workdir,
        },
      });

      const created = JSON.parse(await taskCreate.execute({
        description: "trimmed pwd task",
        command: "pwd",
        workdir: `  ${workdir}  `,
      }));
      let done: any = null;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const task = getTaskManager().getHistory().find(item => item.id === created.id);
        if (task?.status === "completed") {
          done = task;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      expect(done).toBeTruthy();
      expect(done.output).toContain(workdir);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("fails cleanly for missing task descriptions and ids", async () => {
    registerTaskTools();
    expect(await getRegistry().lookup("task_create")!.execute({})).toContain("description is required");
    expect(await getRegistry().lookup("task_read")!.execute({})).toContain("id is required");
    expect(await getRegistry().lookup("task_cancel")!.execute({})).toContain("id is required");
    expect(await getRegistry().lookup("task_complete")!.execute({})).toContain("id is required");
    expect(await getRegistry().lookup("task_fail")!.execute({})).toContain("id is required");
  });

  it("returns not found messages for unknown task ids", async () => {
    registerTaskTools();
    expect(await getRegistry().lookup("task_read")!.execute({ id: "missing" })).toContain("task not found");
    expect(await getRegistry().lookup("task_cancel")!.execute({ id: "missing" })).toContain("active task not found");
    expect(await getRegistry().lookup("task_complete")!.execute({ id: "missing" })).toContain("active task not found");
    expect(await getRegistry().lookup("task_fail")!.execute({ id: "missing" })).toContain("active task not found");
  });

  it("normalizes task_id aliases for task tool validation", async () => {
    registerTaskTools();
    const taskComplete = getRegistry().lookup("task_complete")!;
    const validation = await taskComplete.validateInput?.(
      { task_id: "task_123", output: "done" },
      { tool_name: "task_complete", workspace_path: "/tmp/workspace", tool_def: taskComplete },
    );

    expect(validation).toMatchObject({
      ok: true,
      args: {
        id: "task_123",
        output: "done",
      },
    });
  });

  it("rejects non-string task ids during validation instead of stringifying objects", async () => {
    registerTaskTools();
    const taskRead = getRegistry().lookup("task_read")!;

    expect(await taskRead.validateInput?.(
      { id: { nested: true } as any },
      { tool_name: "task_read", workspace_path: "/tmp/workspace", tool_def: taskRead },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("id is required"),
    });
  });

  it("rejects non-string task ids during execution instead of looking up [object Object]", async () => {
    registerTaskTools();

    expect(await getRegistry().lookup("task_read")!.execute({ id: { nested: true } as any })).toContain("id is required");
    expect(await getRegistry().lookup("task_cancel")!.execute({ id: { nested: true } as any })).toContain("id is required");
    expect(await getRegistry().lookup("task_complete")!.execute({ id: { nested: true } as any })).toContain("id is required");
    expect(await getRegistry().lookup("task_fail")!.execute({ id: { nested: true } as any })).toContain("id is required");
  });

  it("rejects non-string task completion payloads instead of persisting coerced output or error text", async () => {
    registerTaskTools();
    const created = JSON.parse(await getRegistry().lookup("task_create")!.execute({ description: "Keep payloads typed" }));

    expect(await getRegistry().lookup("task_complete")!.execute({ id: created.id, output: { nested: true } as any })).toContain("output must be a string");
    expect(await getRegistry().lookup("task_fail")!.execute({ id: created.id, error: { nested: true } as any })).toContain("error must be a string");

    const active = JSON.parse(await getRegistry().lookup("task_read")!.execute({ id: created.id }));
    expect(active.status).toBe("running");
    expect(active.output).toBeUndefined();
  });

  it("rejects malformed task_gate_run options instead of silently falling back to defaults", async () => {
    registerTaskTools();
    const gateTool = getRegistry().lookup("task_gate_run")!;

    expect(await gateTool.validateInput?.(
      { command: "printf gate", workdir: { nested: true } as any },
      { tool_name: "task_gate_run", workspace_path: "/tmp/workspace", tool_def: gateTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await gateTool.validateInput?.(
      { command: "printf gate", cwd: { nested: true } as any },
      { tool_name: "task_gate_run", workspace_path: "/tmp/workspace", tool_def: gateTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("workdir must be a string"),
    });
    expect(await gateTool.validateInput?.(
      { command: "printf gate", timeout: { nested: true } as any },
      { tool_name: "task_gate_run", workspace_path: "/tmp/workspace", tool_def: gateTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("timeout must be a number"),
    });

    expect(await gateTool.execute({
      command: "printf gate",
      workdir: { nested: true } as any,
    })).toContain("workdir must be a string");
    expect(await gateTool.execute({
      command: "printf gate",
      cwd: { nested: true } as any,
    })).toContain("workdir must be a string");
    expect(await gateTool.execute({
      command: "printf gate",
      timeout: { nested: true } as any,
    })).toContain("timeout must be a number");
  });

  it("rejects whitespace-only task_gate_run commands during execution as well as validation", async () => {
    registerTaskTools();
    const gateTool = getRegistry().lookup("task_gate_run")!;

    expect(await gateTool.validateInput?.(
      { command: "   " },
      { tool_name: "task_gate_run", workspace_path: "/tmp/workspace", tool_def: gateTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("command must be a non-empty string"),
    });

    expect(await gateTool.execute({ command: "   " })).toContain("command must be a non-empty string");
  });

  it("rejects unsafe task_gate_run commands and timeout bounds consistently", async () => {
    registerTaskTools();
    const gateTool = getRegistry().lookup("task_gate_run")!;

    expect(await gateTool.validateInput?.(
      { command: { nested: true } as any },
      { tool_name: "task_gate_run", workspace_path: "/tmp/workspace", tool_def: gateTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("command must be a string"),
    });
    expect(await gateTool.execute({ command: { nested: true } as any })).toContain("command must be a string");
    expect(await gateTool.validateInput?.(
      { command: "printf ok\u0007" },
      { tool_name: "task_gate_run", workspace_path: "/tmp/workspace", tool_def: gateTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("command contains control characters"),
    });
    expect(await gateTool.execute({ command: "printf ok\u0007" })).toContain("command contains control characters");

    for (const value of [0, -1, "0", "-5"]) {
      expect(await gateTool.validateInput?.(
        { command: "printf ok", timeout: value },
        { tool_name: "task_gate_run", workspace_path: "/tmp/workspace", tool_def: gateTool },
      )).toMatchObject({
        ok: false,
        message: expect.stringContaining("timeout must be a positive integer"),
      });
      expect(await gateTool.execute({ command: "printf ok", timeout: value })).toContain("timeout must be a positive integer");
    }

    expect(await gateTool.execute({ command: "printf ok", timeout: 86_400_001 })).toContain("timeout must be at most 86400000");
  });

  it("sanitizes task ids and bounds task payload text at the tool layer", async () => {
    registerTaskTools();
    const taskCreate = getRegistry().lookup("task_create")!;

    expect(taskCreate.validateInput?.(
      { description: "bad command", command: "printf ok\u0000bad" },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("command contains control characters"),
    });
    expect(taskCreate.validateInput?.(
      { description: "bad attempts", command: "printf ok", max_attempts: 11 },
      { tool_name: "task_create", workspace_path: "/tmp/workspace", tool_def: taskCreate },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("max_attempts must be at most 10"),
    });

    const created = JSON.parse(await taskCreate.execute({ description: "Bounded output" }));
    expect(await getRegistry().lookup("task_complete")!.execute({
      id: created.id,
      output: `${"x".repeat(210_000)}tail\u0000`,
    })).toContain("Completed");

    const read = JSON.parse(await getRegistry().lookup("task_read")!.execute({ id: created.id }));
    expect(read.output).toHaveLength(200_000);
    expect(read.output).toContain("tail ");
    expect(await getRegistry().lookup("task_read")!.execute({ id: `${created.id}\u0000bad` })).toContain("id is required");
  });
});

describe("cross-tool state", () => {
  it("returns no tasks when task and checklist state are both empty", async () => {
    registerTaskTools();
    expect(await getRegistry().lookup("task_list")!.execute({})).toBe("No tasks.");
  });

  it("preserves todo state until explicitly cleared", async () => {
    registerPlanTools();
    await getRegistry().lookup("checklist_write")!.execute({
      items: [{ content: "keep me", status: "pending" }],
    });

    expect(getTodoState()).toMatchObject([{ id: 1, content: "keep me", status: "pending" }]);
    clearPlanState();
    expect(getTodoState()).toEqual([]);
  });

  it("clears note state alongside plan and checklist test state", async () => {
    registerPlanTools();
    await getRegistry().lookup("note")!.execute({ title: "sticky", content: "remember me" });

    expect(getNoteState()).toHaveLength(1);
    clearPlanState();
    expect(getNoteState()).toEqual([]);
  });
});

describe("think tool", () => {
  it("rejects non-string thought payloads instead of throwing", async () => {
    registerThinkTool();
    const thinkTool = getRegistry().lookup("think")!;

    expect(await thinkTool.validateInput?.(
      { thought: null as any },
      { tool_name: "think", workspace_path: "/tmp/workspace", tool_def: thinkTool },
    )).toMatchObject({
      ok: false,
      message: expect.stringContaining("thought must be a string"),
    });

    await expect(getRegistry().lookup("think")!.execute({ thought: null as any })).resolves.toContain("thought must be a string");
  });
});
