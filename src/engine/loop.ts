/** Core ReAct conversation loop. */

import type { Config } from "../config.js";
import type { DeepSeekClient } from "../client/deepseek.js";
import type { UsageTelemetry } from "../client/base.js";
import type { BaseMode, UICallbacks } from "../modes/base.js";
import type { ConversationHistory } from "../session/history.js";
import type { Message, Session, ToolCall, ToolResult } from "../session/types.js";
import {
  getToolUseRuntimeMetadata,
  isToolConcurrencySafe,
  PermissionLevel,
  validateToolInput,
  type ApprovalContext,
  type ToolDef,
  type ToolRenderedResult,
  type ToolProgress,
  type ToolUseRuntimeMetadata,
} from "../tools/base.js";
import { ToolRegistry } from "../tools/registry.js";
import { CapacityController } from "./capacity.js";
import { LayeredContextManager, type ContextIntervention } from "./context-manager.js";
import { checkSandboxPolicy } from "../tools/sandbox.js";
import { runAutoDiagnostics } from "../tools/diagnostics.js";
import { fireHooks } from "./hooks.js";
import { applyToolResultBudget } from "./tool-result-budget.js";
import { emitRuntimeEvent, type PrefixInvalidatedEventData } from "./events.js";
import { SideGit } from "../rollback/side-git.js";
import { ImmutablePrefix, PrefixManager, stripPinnedPrefixMessages } from "./prefix.js";
import { estimateRequestTokens, projectMessagesForRequest } from "./compact.js";
import { getMode } from "../modes/base.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";

export type { UICallbacks };

export interface TurnResult {
  duration_s: number;
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  iterations: number;
  usage: UsageTelemetry | null;
  artifact_ids: string[];
}

export interface RunTurnOptions {
  signal?: AbortSignal;
  ephemeralInstructions?: string;
}

interface EngineModelResponse {
  content: string;
  reasoning_content: string | null;
  tool_calls: ToolCall[];
  finish_reason: string;
  usage: UsageTelemetry | null;
}

interface ToolPostHookPayload {
  toolName: string;
  args: Record<string, unknown>;
  resultContent: string;
}

interface ToolExecutionOutcome {
  toolCall: ToolCall;
  result: ToolResult;
  preview: string;
  artifactIds?: string[];
  rendered?: ToolRenderedResult;
  metadata?: ToolUseRuntimeMetadata;
  postHook?: ToolPostHookPayload;
  interrupted?: boolean;
}

type NormalizedClientStreamEvent =
  | { type: "thinking"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_call_begin"; name: string; tool_call_id: string; index: number }
  | { type: "tool_call_args"; name: string; tool_call_id: string; index: number; arguments: string }
  | { type: "done"; finish_reason: string; usage: UsageTelemetry | null; content: string; reasoning_content: string | null; tool_calls: ToolCall[] };

const MAX_ENGINE_STREAM_TEXT_CHARS = 2_000_000;
const MAX_ENGINE_TOOL_ARGUMENT_CHARS = 1_000_000;
const MAX_ENGINE_TOOL_CALLS = 100;
const MAX_ENGINE_USAGE_DEPTH = 8;
const MAX_ENGINE_USAGE_KEYS = 100;
const MAX_ENGINE_ARG_KEYS = 1_000;
const MAX_ENGINE_ARG_DEPTH = 16;
const MAX_ENGINE_ARG_ARRAY_ITEMS = 1_000;
const MAX_ENGINE_ARG_STRING_CHARS = 1_000_000;
const MAX_ENGINE_ARTIFACT_JSON_DEPTH = 20;
const MAX_ENGINE_ARTIFACT_JSON_KEYS = 500;
const MAX_ENGINE_ARTIFACT_JSON_ARRAY_ITEMS = 500;
const MAX_ENGINE_PATCH_CHARS = 1_000_000;
const MAX_ENGINE_PATCH_LINES = 20_000;
const SAFE_ENGINE_FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);
const SAFE_ENGINE_TOOL_CALL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ENGINE_TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const CONTROL_TEXT_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export class Engine {
  config: Config;
  session: Session;
  history: ConversationHistory;
  client: DeepSeekClient;
  tools: ToolRegistry;
  readonly prefixManager: PrefixManager;
  interrupted = false;
  private capacity: CapacityController;
  private contextManager: LayeredContextManager;

  constructor(
    config: Config, session: Session, history: ConversationHistory,
    client: DeepSeekClient, tools: ToolRegistry, prefix?: ImmutablePrefix,
  ) {
    this.config = config;
    this.session = session;
    this.history = history;
    this.client = client;
    this.tools = tools;
    this.prefixManager = new PrefixManager(prefix ?? new ImmutablePrefix({
      systemPrompt: firstPlainSystemMessage(history.getMessages())?.content || "",
      toolSchemas: tools.toOpenAISchemas({ activeOnly: false }),
    }));
    this.capacity = new CapacityController();
    this.contextManager = new LayeredContextManager(config);
  }

  get prefix(): ImmutablePrefix {
    return this.prefixManager.prefix;
  }

  set prefix(prefix: ImmutablePrefix) {
    this.prefixManager.replace(prefix);
  }

  interrupt(): void { this.interrupted = true; }

  async runTurn(
    userInput: string, mode: BaseMode, callbacks?: UICallbacks, options: RunTurnOptions = {},
  ): Promise<TurnResult> {
    this.interrupted = false;
    const signal = normalizeAbortSignal(safeProperty(options, "signal"));
    const ephemeralInstructions = sanitizeOptionalEngineText(safeProperty(options, "ephemeralInstructions"), MAX_ENGINE_STREAM_TEXT_CHARS);
    const onAbort = () => { this.interrupted = true; };
    addAbortListener(signal, onAbort);
    if (isAbortSignalAborted(signal)) this.interrupted = true;
    const start = Date.now();
    const rollback = this.config.rollback_enabled ? new SideGit(this.session.workspace_path) : null;
    const turnSnapshotId = this.session.turns.length + 1;
    const turnToolCalls: ToolCall[] = [];
    const turnToolResults: ToolResult[] = [];
    const turnArtifactIds = new Set<string>();
    let ephemeralMessage: Message | null = null;

    try {
      const activeMode = resolveActiveMode(this.config, this.session, mode);
      if (ephemeralInstructions?.trim()) {
        ephemeralMessage = {
          role: "system",
          content: ephemeralInstructions,
          tool_calls: null,
          tool_call_id: null,
          name: null,
          reasoning_content: null,
        };
        this.session.messages.push(ephemeralMessage);
      }
      this.history.addUser(userInput);
      await emitRuntimeEvent(callbacks, { type: "user_message", data: { text: userInput } });
      await captureRollbackSnapshot(rollback, "pre", turnSnapshotId);
      const autoActivatedTools = this.tools.activateForContext(userInput);
      if (autoActivatedTools.length) {
        await emitRuntimeEvent(callbacks, { type: "tool_catalog_auto_activate", data: { tools: autoActivatedTools, source: "user_input" } });
      }
      await emitRuntimeEvent(callbacks, { type: "prefix_pinned", data: this.prefix.metadata });
      const schemas = this.prefix.toolSchemas();
      const currentAllowedToolNames = () => new Set(activeMode.filterTools(this.tools.listActive()).map(tool => tool.name));

      let iterations = 0;
      let lastUsage: UsageTelemetry | null = null;
      let totalUsage: UsageTelemetry | null = null;
      const respondedToolCallIds = new Set<string>();
      const recordToolResult = (result: ToolResult) => {
        this.history.addToolResult(result);
        respondedToolCallIds.add(result.tool_call_id);
      };
      const interruptedToolResult = (tc: ToolCall, reason: string): ToolResult => ({
        tool_call_id: tc.id,
        name: tc.name || "tool",
        content: `Error: interrupted before tool '${tc.name || "tool"}' completed (${reason}).`,
        is_error: true,
      });
      const addInterruptedToolResults = async (toolCalls: ToolCall[], reason: string) => {
        for (const tc of toolCalls) {
          if (respondedToolCallIds.has(tc.id)) continue;
          const tr = interruptedToolResult(tc, reason);
          recordToolResult(tr);
          turnToolCalls.push(tc);
          turnToolResults.push(tr);
          await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: tr.content });
        }
      };
      const addBudgetExceededToolResults = async (toolCalls: ToolCall[]) => {
        const budget = this.config.tool_call_budget_per_turn;
        for (const tc of toolCalls) {
          if (respondedToolCallIds.has(tc.id)) continue;
          const err = `Error: tool call budget exceeded for this turn (${budget}).`;
          const tr: ToolResult = { tool_call_id: tc.id, name: tc.name, content: err, is_error: true };
          recordToolResult(tr);
          turnToolCalls.push(tc);
          turnToolResults.push(tr);
          await emitRuntimeEvent(callbacks, { type: "tool_budget_exceeded", data: { tool: tc.name, budget } });
          await emitRuntimeEvent(callbacks, { type: "tool_result", data: tr, preview: safeSliceTextBoundary(err, 200) });
        }
      };

      while (iterations < this.config.max_turns) {
        if (this.interrupted) break;
        iterations++;
        const approvalPolicy = effectiveApprovalPolicy(this.config, activeMode);

        const projectedTokens = this.requestTokenCount();
        const capacityDecision = this.capacity.observe(projectedTokens, this.config.context_limit);
        const intervention = this.contextManager.apply(this.history, capacityDecision, this.session.workspace_path);
        if (intervention) {
          await this.emitContextIntervention(callbacks, intervention);
        }

        let response: EngineModelResponse;
        let apiAttempt = 0;
        while (true) {
          await emitRuntimeEvent(callbacks, {
            type: "api_call_start",
            data: omitUndefined({
              prefix_hash: this.prefix.hash,
              tool_schema_count: schemas.length,
              retry: apiAttempt || undefined,
              prompt_recovery: apiAttempt > 0 || undefined,
            }),
          });
          try {
            response = await this.callApi(schemas, callbacks, signal);
            break;
          } catch (error) {
            if (!isPromptTooLongError(error) || apiAttempt >= 2 || isAbortSignalAborted(signal) || this.interrupted) throw error;
            const intervention = this.contextManager.compactNow(
              this.history,
              this.session.workspace_path,
              promptTooLongReason(error),
            );
            await this.emitContextIntervention(callbacks, intervention);
            if (intervention.compaction?.status !== "compacted") throw error;
            apiAttempt++;
          }
        }
        lastUsage = response.usage;
        totalUsage = mergeUsage(totalUsage, response.usage);

        const assistantMessage = this.history.addAssistant(response.content, response.tool_calls, response.reasoning_content);
        await emitRuntimeEvent(callbacks, { type: "assistant_message", data: assistantMessage });

        if (!response.tool_calls.length) break;

        const makeToolErrorOutcome = (
          tc: ToolCall,
          content: string,
          preview = safeSliceTextBoundary(content, 200),
          interrupted = false,
        ): ToolExecutionOutcome => ({
          toolCall: tc,
          result: { tool_call_id: tc.id, name: tc.name, content, is_error: true },
          preview,
          interrupted,
        });

        const executeToolCall = async (tc: ToolCall): Promise<ToolExecutionOutcome> => {
          const toolDef = this.tools.lookup(tc.name);
          await emitRuntimeEvent(callbacks, {
            type: "tool_call",
            data: toolDef
              ? omitUndefined({ ...tc, metadata: getToolUseRuntimeMetadata(toolDef, tc.arguments as Record<string, unknown>) })
              : tc,
          });
          if (!toolDef) {
            return makeToolErrorOutcome(tc, `Error: Unknown tool '${tc.name}'`);
          }
          if (!this.prefix.hasTool(tc.name) || !currentAllowedToolNames().has(tc.name)) {
            return makeToolErrorOutcome(tc, `Tool '${tc.name}' is not active in the current mode or prefix. Enable it explicitly if needed.`);
          }

          try {
            let earlyOutcome: ToolExecutionOutcome | null = null;
            const pushToolError = (content: string): void => {
              earlyOutcome = makeToolErrorOutcome(tc, content);
            };
            const normalizeArgs = async (nextArgs: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
              const validation = await validateToolInput(toolDef, nextArgs, {
                tool_name: tc.name,
                workspace_path: this.session.workspace_path,
              });
              if (!validation.ok) {
                pushToolError(`Error: invalid input for tool '${tc.name}': ${validation.message || "validation failed"}`);
                return null;
              }
              return withWorkspaceDefaults(toolDef, validation.args ?? nextArgs, this.session.workspace_path);
            };
            const authorizeArgs = async (nextArgs: Record<string, unknown>): Promise<boolean> => {
              const nextCtx: ApprovalContext = {
                tool_name: tc.name,
                tool_args: nextArgs,
                tool_def: toolDef,
                workspace_path: this.session.workspace_path,
              };
              const approvalArgs = publicToolArgs(nextArgs);
              const approvalCtx: ApprovalContext = {
                ...nextCtx,
                tool_args: approvalArgs,
              };
              const nextSandbox = checkSandboxPolicy(this.config, nextCtx);
              if (nextSandbox.decision === "deny") {
                await emitRuntimeEvent(callbacks, { type: "approval_audit", data: { tool: tc.name, decision: "deny", reason: nextSandbox.reason } });
                pushToolError(`Tool '${tc.name}' was denied by sandbox: ${nextSandbox.reason}.`);
                return false;
              }

              let approvedAfterMutation: boolean;
              if (nextSandbox.decision === "ask" && approvalPolicy === "never") {
                approvedAfterMutation = true;
              } else if (nextSandbox.decision === "ask") {
                approvedAfterMutation = await callbacks?.requestApproval?.(
                  tc.name,
                  approvalArgs,
                  `Sandbox approval required: ${nextSandbox.reason}\n\nArguments: ${safeJsonStringify(approvalArgs, { sortKeys: true })}`,
                ) ?? false;
              } else {
                approvedAfterMutation = nextSandbox.decision === "allow" && approvalPolicy === "never"
                  ? true
                  : await activeMode.checkPermission(approvalCtx, callbacks);
              }
              await emitRuntimeEvent(callbacks, {
                type: "approval_audit",
                data: { tool: tc.name, decision: approvedAfterMutation ? "allow" : "deny", reason: nextSandbox.reason },
              });
              if (!approvedAfterMutation) {
                pushToolError(`Tool '${tc.name}' was denied.`);
                return false;
              }
              return true;
            };
            let args = withWorkspaceDefaults(toolDef, tc.arguments as Record<string, unknown>, this.session.workspace_path);
            const normalizedArgs = await normalizeArgs(args);
            if (!normalizedArgs) return earlyOutcome ?? makeToolErrorOutcome(tc, `Error: invalid input for tool '${tc.name}': validation failed`);
            args = normalizedArgs;
            const preHook = await fireHooks("PreToolUse", {
              tool_name: tc.name,
              tool_input: args,
              session_id: this.session.id,
              cwd: this.session.workspace_path,
            });
            await emitRuntimeEvent(callbacks, { type: "hook", data: { event: "PreToolUse", tool: tc.name, ...preHook } });
            if (preHook.decision === "deny") {
              return makeToolErrorOutcome(tc, `Tool '${tc.name}' was denied by hook: ${preHook.message || "no reason provided"}.`);
            }
            if (preHook.modified_input) {
              args = withWorkspaceDefaults(toolDef, mergeEngineRecords(args, preHook.modified_input), this.session.workspace_path);
              const revalidatedArgs = await normalizeArgs(args);
              if (!revalidatedArgs) return earlyOutcome ?? makeToolErrorOutcome(tc, `Error: invalid input for tool '${tc.name}': validation failed`);
              args = revalidatedArgs;
            }
            if (!(await authorizeArgs(args))) {
              return earlyOutcome ?? makeToolErrorOutcome(tc, `Tool '${tc.name}' was denied.`);
            }
            const toolStart = Date.now();
            let resultContent = await toolDef.execute(args, omitUndefined({
              signal,
              toolCallId: tc.id,
              sessionId: this.session.id,
              workspacePath: this.session.workspace_path,
              onProgress: async (progress: ToolProgress) => {
                const rendered = toolDef.renderProgress?.(progress, args);
                await emitRuntimeEvent(callbacks, {
                  type: "tool_progress",
                  data: { tool: tc.name, tool_call_id: tc.id, progress },
                  ...(rendered ? { rendered } : {}),
                });
              },
            }));
            let isError = isToolResultError(resultContent);
            if (!isError) {
              const diagnostics = await this.maybeRunPostEditDiagnostics(tc.name, args);
              if (diagnostics) resultContent = `${resultContent}\n\n[post-edit diagnostics]\n${diagnostics}`;
              isError = isToolResultError(resultContent);
            }

            const originalArtifactIds = extractArtifactIds(resultContent);
            const budgeted = applyToolResultBudget(omitUndefined({
              toolName: tc.name,
              toolCallId: tc.id,
              content: resultContent,
              isError,
              sessionId: this.session.id,
              maxChars: toolDef.maxResultSizeChars,
            }));
            const artifactIds = [...new Set([...originalArtifactIds, ...budgeted.artifactIds]
              .map(id => id.trim())
              .filter(isSafeArtifactId))];
            const result: ToolResult = {
              tool_call_id: tc.id, name: tc.name, content: budgeted.content, is_error: isError,
            };
            const rendered = toolDef.renderResult?.(budgeted.replaced ? budgeted.content : resultContent, args);
            const metadata = getToolUseRuntimeMetadata(toolDef, args, budgeted.replaced ? budgeted.content : resultContent);
            const stats = this.tools.recordCall(tc.name, !isError, Date.now() - toolStart);
            const degraded = isError ? this.tools.degradeIfUnhealthy(tc.name, this.config.tool_failure_degrade_threshold) : null;
            await emitRuntimeEvent(callbacks, { type: "tool_stats", data: { stats, degraded } });
            return omitUndefined({
              toolCall: tc,
              result,
              artifactIds,
              preview: rendered?.preview ?? (budgeted.replaced ? budgeted.content : resultContent),
              rendered,
              metadata,
              postHook: { toolName: tc.name, args, resultContent },
            });
          } catch (e: any) {
            if (this.interrupted || isAbortSignalAborted(signal) || isAbortLikeError(e)) {
              this.interrupted = true;
              const reason = isAbortSignalAborted(signal) ? "abort requested" : "interrupt requested";
              const tr = interruptedToolResult(tc, reason);
              return { toolCall: tc, result: tr, preview: tr.content, interrupted: true };
            }
            const err = `Error executing ${tc.name}: ${e.message}`;
            const stats = this.tools.recordCall(tc.name, false, 0);
            const degraded = this.tools.degradeIfUnhealthy(tc.name, this.config.tool_failure_degrade_threshold);
            await emitRuntimeEvent(callbacks, { type: "tool_stats", data: { stats, degraded } });
            return makeToolErrorOutcome(tc, err);
          }
        };

        const commitToolOutcome = async (outcome: ToolExecutionOutcome): Promise<void> => {
          recordToolResult(outcome.result);
          turnToolResults.push(outcome.result);
          turnToolCalls.push(outcome.toolCall);
          await emitRuntimeEvent(callbacks, {
            type: "tool_result",
            data: outcome.result,
            preview: outcome.preview,
            ...(outcome.artifactIds ? { artifact_ids: outcome.artifactIds } : {}),
            ...(outcome.rendered ? { rendered: outcome.rendered } : {}),
            ...(outcome.metadata ? { metadata: outcome.metadata } : {}),
          });
          for (const id of outcome.artifactIds || []) turnArtifactIds.add(id);
          if (outcome.postHook) {
            const postHook = await fireHooks("PostToolUse", {
              tool_name: outcome.postHook.toolName,
              tool_input: outcome.postHook.args,
              tool_result: outcome.postHook.resultContent,
              session_id: this.session.id,
              cwd: this.session.workspace_path,
            });
            await emitRuntimeEvent(callbacks, { type: "hook", data: { event: "PostToolUse", tool: outcome.postHook.toolName, ...postHook } });
          }
          if (outcome.interrupted) this.interrupted = true;
        };

        const runToolBatch = async (batch: ToolCall[]): Promise<void> => {
          if (!batch.length) return;
          const outcomes = batch.length === 1
            ? [await executeToolCall(batch[0]!)]
            : await Promise.all(batch.map(tc => executeToolCall(tc)));
          for (const outcome of outcomes) {
            await commitToolOutcome(outcome);
          }
        };

        const isParallelBatchCandidate = (tc: ToolCall): boolean => {
          const toolDef = this.tools.lookup(tc.name);
          if (!toolDef || !this.prefix.hasTool(tc.name) || !currentAllowedToolNames().has(tc.name)) return false;
          if (toolDef.permission !== PermissionLevel.ALWAYS_ALLOW || toolDef.readOnly !== true) return false;
          const args = withWorkspaceDefaults(toolDef, tc.arguments as Record<string, unknown>, this.session.workspace_path);
          return isToolConcurrencySafe(toolDef, args);
        };

        let toolCallIndex = 0;
        while (toolCallIndex < response.tool_calls.length) {
          if (this.interrupted) break;
          const tc = response.tool_calls[toolCallIndex];
          if (!tc) break;
          if (turnToolCalls.length >= this.config.tool_call_budget_per_turn) {
            await addBudgetExceededToolResults(response.tool_calls.slice(toolCallIndex));
            this.interrupted = true;
            break;
          }

          if (!isParallelBatchCandidate(tc)) {
            await runToolBatch([tc]);
            toolCallIndex++;
            continue;
          }

          const batch: ToolCall[] = [];
          while (
            toolCallIndex < response.tool_calls.length
            && turnToolCalls.length + batch.length < this.config.tool_call_budget_per_turn
            && isParallelBatchCandidate(response.tool_calls[toolCallIndex]!)
          ) {
            batch.push(response.tool_calls[toolCallIndex]!);
            toolCallIndex++;
          }
          await runToolBatch(batch);
        }
        if (this.interrupted) {
          await addInterruptedToolResults(response.tool_calls, isAbortSignalAborted(signal) ? "abort requested" : "interrupt requested");
          break;
        }
      }

      return {
        duration_s: (Date.now() - start) / 1000,
        tool_calls: turnToolCalls,
        tool_results: turnToolResults,
        iterations,
        usage: totalUsage || lastUsage,
        artifact_ids: [...turnArtifactIds],
      };
    } finally {
      if (ephemeralMessage) {
        const index = this.session.messages.indexOf(ephemeralMessage);
        if (index >= 0) this.session.messages.splice(index, 1);
      }
      await captureRollbackSnapshot(rollback, "post", turnSnapshotId);
      removeAbortListener(signal, onAbort);
    }
  }

  private async emitContextIntervention(callbacks: UICallbacks | undefined, intervention: ContextIntervention): Promise<void> {
    await emitRuntimeEvent(callbacks, { type: "context_intervention", data: intervention });
    if (intervention.compaction?.prefix_invalidated) {
      const data: PrefixInvalidatedEventData = {
        reason: intervention.compaction.prefix_invalidation_reason || "context_compaction",
        compaction: omitUndefined({
          actions: intervention.compaction.actions,
          finalTokens: intervention.compaction.finalTokens,
          original_tokens: intervention.compaction.original_tokens,
          removed_messages: intervention.compaction.removed_messages,
          preserved_messages: intervention.compaction.preserved_messages,
          summary_message_name: intervention.compaction.summary_message_name,
        }),
      };
      if (intervention.compaction.boundary_id !== undefined) data.boundary_id = intervention.compaction.boundary_id;
      await emitRuntimeEvent(callbacks, {
        type: "prefix_invalidated",
        data,
      });
    }
  }

  private async callApi(
    schemas: Record<string, unknown>[],
    callbacks?: UICallbacks,
    signal?: AbortSignal,
  ): Promise<EngineModelResponse> {
    let content = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    let finishReason = "stop";
    let usage: UsageTelemetry | null = null;

    for await (const rawEvent of this.client.send(
      this.requestMessages(), schemas.length ? schemas : null,
      omitUndefined({ stream: true, reasoning_effort: this.config.reasoning_effort, max_tokens: this.config.max_tokens, signal }),
    )) {
      if (this.interrupted) break;
      const event = normalizeClientStreamEvent(rawEvent);
      if (!event) continue;

      switch (event.type) {
        case "thinking":
          {
            const text = sanitizeEngineText(event.text, remainingEngineChars(reasoning, MAX_ENGINE_STREAM_TEXT_CHARS));
            if (!text) break;
            reasoning += text;
            await emitRuntimeEvent(callbacks, { type: "thinking_delta", data: { text } });
          }
          break;
        case "content":
          {
            const text = sanitizeEngineText(event.text, remainingEngineChars(content, MAX_ENGINE_STREAM_TEXT_CHARS));
            if (!text) break;
            content += text;
            await emitRuntimeEvent(callbacks, { type: "content_delta", data: { text } });
          }
          break;
        case "tool_call_begin":
          await emitRuntimeEvent(callbacks, {
            type: "tool_call_begin",
            data: {
              name: event.name,
              tool_call_id: event.tool_call_id,
              index: event.index,
            },
          });
          break;
        case "tool_call_args":
          await emitRuntimeEvent(callbacks, {
            type: "tool_call_args",
            data: {
              tool_call_id: event.tool_call_id,
              name: event.name,
              index: event.index,
              arguments: event.arguments,
            },
          });
          break;
        case "done": {
          finishReason = event.finish_reason;
          usage = event.usage;
          if (event.reasoning_content && !reasoning) reasoning = event.reasoning_content;
          if (event.content && !content) content = event.content;
          for (const tc of event.tool_calls) {
            toolCalls.push(tc);
          }
          break;
        }
      }
    }

    return { content, reasoning_content: reasoning || null, tool_calls: toolCalls, finish_reason: finishReason, usage };
  }

  private requestMessages(): Message[] {
    const sessionMessages = projectMessagesForRequest(this.history.getMessages());
    return [
      ...this.prefix.toMessages(),
      ...stripPinnedPrefixMessages(sessionMessages, this.prefix),
    ];
  }

  requestTokenCount(): number {
    return estimateRequestTokens(this.requestMessages(), this.prefix.toolSchemas());
  }

  private async maybeRunPostEditDiagnostics(toolName: string, args: Record<string, unknown>): Promise<string | null> {
    if (!this.config.lsp_auto_diagnostics) return null;
    if (!["write", "edit", "apply_patch"].includes(toolName)) return null;
    const files = changedFilesForTool(toolName, args);
    try {
      return await runAutoDiagnostics({
        workdir: this.session.workspace_path,
        files,
        minSeverity: this.config.lsp_diagnostics_severity,
      });
    } catch (e: any) {
      return `Diagnostics failed: ${e.message}`;
    }
  }
}

function firstPlainSystemMessage(messages: Message[]): Message | null {
  return messages.find(message => message.role === "system" && message.name == null) ?? null;
}

function normalizeClientStreamEvent(value: unknown): NormalizedClientStreamEvent | null {
  const type = safeProperty(value, "type");
  switch (type) {
    case "thinking": {
      const text = sanitizeOptionalEngineText(safeProperty(value, "text"), MAX_ENGINE_STREAM_TEXT_CHARS);
      return text ? { type, text } : null;
    }
    case "content": {
      const text = sanitizeOptionalEngineText(safeProperty(value, "text"), MAX_ENGINE_STREAM_TEXT_CHARS);
      return text ? { type, text } : null;
    }
    case "tool_call_begin": {
      const toolCallId = normalizeEngineToolCallId(safeProperty(value, "tool_call_id"));
      const name = normalizeEngineToolName(safeProperty(value, "name"));
      const index = normalizeEngineIndex(safeProperty(value, "index"));
      return toolCallId && name && index !== null ? { type, tool_call_id: toolCallId, name, index } : null;
    }
    case "tool_call_args": {
      const toolCallId = normalizeEngineToolCallId(safeProperty(value, "tool_call_id"));
      const name = normalizeEngineToolName(safeProperty(value, "name"));
      const index = normalizeEngineIndex(safeProperty(value, "index"));
      const args = sanitizeOptionalEngineText(safeProperty(value, "arguments"), MAX_ENGINE_TOOL_ARGUMENT_CHARS);
      return toolCallId && name && index !== null && args
        ? { type, tool_call_id: toolCallId, name, index, arguments: args }
        : null;
    }
    case "done": {
      return {
        type,
        finish_reason: normalizeEngineFinishReason(safeProperty(value, "finish_reason")),
        usage: normalizeEngineUsage(safeProperty(value, "usage")),
        content: sanitizeOptionalEngineText(safeProperty(value, "content"), MAX_ENGINE_STREAM_TEXT_CHARS) ?? "",
        reasoning_content: sanitizeOptionalEngineText(safeProperty(value, "reasoning_content"), MAX_ENGINE_STREAM_TEXT_CHARS),
        tool_calls: normalizeEngineToolCalls(safeProperty(value, "tool_calls")),
      };
    }
    default:
      return null;
  }
}

function normalizeEngineFinishReason(value: unknown): string {
  if (typeof value !== "string") return "stop";
  const normalized = value.trim();
  return SAFE_ENGINE_FINISH_REASONS.has(normalized) ? normalized : "stop";
}

function normalizeEngineToolCallId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SAFE_ENGINE_TOOL_CALL_ID_RE.test(trimmed) ? trimmed : "";
}

function normalizeEngineToolName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return SAFE_ENGINE_TOOL_NAME_RE.test(trimmed) ? trimmed : "";
}

function normalizeEngineIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : null;
}

function normalizeEngineUsage(value: unknown): UsageTelemetry | null {
  const normalized = normalizeEngineUsageValue(value, new WeakSet<object>(), 0);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized as UsageTelemetry
    : null;
}

function normalizeEngineUsageValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === "bigint") return value >= 0n ? value.toString() : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (depth >= MAX_ENGINE_USAGE_DEPTH) return undefined;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const out: Record<string, unknown> = {};
  try {
    for (const [key, child] of safeObjectEntries(value, MAX_ENGINE_USAGE_KEYS)) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
      const normalized = normalizeEngineUsageValue(child, seen, depth + 1);
      if (normalized !== undefined) out[key] = normalized;
    }
  } finally {
    seen.delete(value);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeEngineToolCalls(value: unknown): ToolCall[] {
  const calls: ToolCall[] = [];
  const seen = new Set<string>();
  for (const item of safeArrayItems(value, MAX_ENGINE_TOOL_CALLS)) {
    const record = asRecord(item);
    if (!record) continue;
    const id = normalizeEngineToolCallId(safeProperty(record, "id"));
    const name = normalizeEngineToolName(safeProperty(record, "name"));
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    calls.push({
      id,
      name,
      arguments: cloneEngineRecord(safeProperty(record, "arguments")),
    });
  }
  return calls;
}

function normalizeEngineJsonValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeEngineText(value, MAX_ENGINE_ARG_STRING_CHARS);
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_ENGINE_ARG_DEPTH) return undefined;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return safeArrayItems(value, MAX_ENGINE_ARG_ARRAY_ITEMS).map(item => {
        const normalized = normalizeEngineJsonValue(item, seen, depth + 1);
        return normalized === undefined ? null : normalized;
      });
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of safeObjectEntries(value, MAX_ENGINE_ARG_KEYS)) {
      if (!isSafeEngineObjectKey(key)) continue;
      const normalized = normalizeEngineJsonValue(child, seen, depth + 1);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function sanitizeOptionalEngineText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  return sanitizeEngineText(value, maxChars);
}

function sanitizeEngineText(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  return safeSliceTextBoundary(value.replace(CONTROL_TEXT_GLOBAL_RE, " "), maxChars);
}

function remainingEngineChars(value: string, maxChars: number): number {
  return Math.max(0, maxChars - value.length);
}

function normalizeAbortSignal(value: unknown): AbortSignal | undefined {
  if (!value || typeof value !== "object") return undefined;
  return typeof safeProperty(value, "aborted") === "boolean" ? value as AbortSignal : undefined;
}

function isAbortSignalAborted(signal?: AbortSignal): boolean {
  return safeProperty(signal, "aborted") === true;
}

function addAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  const addEventListener = safeProperty(signal, "addEventListener");
  if (typeof addEventListener !== "function") return;
  try {
    addEventListener.call(signal, "abort", listener, { once: true });
  } catch {
    // ignore invalid signal objects
  }
}

function removeAbortListener(signal: AbortSignal | undefined, listener: () => void): void {
  const removeEventListener = safeProperty(signal, "removeEventListener");
  if (typeof removeEventListener !== "function") return;
  try {
    removeEventListener.call(signal, "abort", listener);
  } catch {
    // ignore invalid signal objects
  }
}

function safeProperty(source: unknown, key: string | symbol): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string | symbol, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeObjectEntries(value: unknown, maxEntries: number): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys.slice(0, Math.max(0, Math.floor(maxEntries)))) {
    entries.push([key, safeProperty(value, key)]);
  }
  return entries;
}

function safeArrayItems(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value)) return [];
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return [];
  }
  const items: unknown[] = [];
  for (let index = 0; index < Math.min(length, Math.max(0, Math.floor(maxItems))); index++) {
    try {
      items.push(value[index]);
    } catch {
      continue;
    }
  }
  return items;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cloneEngineRecord(value: unknown): Record<string, unknown> {
  const cloned = normalizeEngineJsonValue(value, new WeakSet<object>(), 0);
  return asRecord(cloned) ?? {};
}

function mergeEngineRecords(base: unknown, patch: unknown): Record<string, unknown> {
  return { ...cloneEngineRecord(base), ...cloneEngineRecord(patch) };
}

function isSafeEngineObjectKey(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && !value.includes("\0")
    && !value.startsWith("__")
    && value !== "prototype"
    && value !== "constructor";
}

function hasUsableString(...values: unknown[]): boolean {
  return values.some(value => typeof value === "string" && value.trim().length > 0);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeString(value: unknown, maxChars: number): string {
  try {
    return sanitizeEngineText(String(value), maxChars);
  } catch {
    return "";
  }
}

function extractArtifactIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9._-]*_[a-z0-9]{6,}_[a-f0-9]{8,}\b/g)) {
    addArtifactId(ids, match[0]);
  }
  try {
    const parsed = JSON.parse(text);
    collectArtifactIds(parsed, ids);
  } catch {
    // non-JSON tool output
  }
  return [...ids];
}

async function captureRollbackSnapshot(
  sideGit: SideGit | null,
  phase: "pre" | "post",
  turnId: number,
): Promise<void> {
  if (!sideGit) return;
  try {
    if (phase === "pre") await sideGit.snapshotPre(turnId);
    else await sideGit.snapshotPost(turnId);
  } catch {
    // Rollback snapshots are best-effort only.
  }
}

function isToolResultError(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("Error:") || trimmed.startsWith("<deepseek:subagent.error>");
}

function mergeUsage(
  total: UsageTelemetry | null,
  next: UsageTelemetry | null,
): UsageTelemetry | null {
  const safeNext = normalizeEngineUsage(next);
  if (!safeNext) return total;
  const merged: Record<string, unknown> = { ...(normalizeEngineUsage(total) || {}) };
  for (const [key, value] of safeObjectEntries(safeNext, MAX_ENGINE_USAGE_KEYS)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      merged[key] = (typeof merged[key] === "number" ? merged[key] : 0) + value;
      continue;
    }
    const child = normalizeEngineUsage(value);
    if (child) {
      merged[key] = mergeUsage(
        isUsageRecord(merged[key]) ? merged[key] : null,
        child,
      );
    }
  }
  return merged;
}

function isUsageRecord(value: unknown): value is UsageTelemetry {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function effectiveApprovalPolicy(config: Config, mode: BaseMode): Config["approval_policy"] {
  return mode.name === "yolo" ? "never" : config.approval_policy;
}

function resolveActiveMode(config: Config, session: Session, requestedMode: BaseMode): BaseMode {
  if (requestedMode.name === "yolo" && config.mode !== "plan" && session.mode !== "plan") {
    return requestedMode;
  }
  return session.mode && session.mode !== requestedMode.name
    ? getMode(session.mode)
    : requestedMode;
}

function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = safeProperty(error, "name");
  const message = safeProperty(error, "message");
  return name === "AbortError" || (typeof message === "string" && /aborted|abort/i.test(message));
}

function isPromptTooLongError(error: unknown): boolean {
  const nested = safeProperty(error, "error");
  const code = stringOrEmpty(safeProperty(error, "code")) || stringOrEmpty(safeProperty(nested, "code"));
  const type = stringOrEmpty(safeProperty(error, "type")) || stringOrEmpty(safeProperty(nested, "type"));
  const rawStatus = safeProperty(error, "status");
  const rawStatusCode = safeProperty(error, "statusCode");
  const status = typeof rawStatus === "number" ? rawStatus : typeof rawStatusCode === "number" ? rawStatusCode : undefined;
  const message = stringOrEmpty(safeProperty(error, "message")) || safeString(error, 500);
  const nestedMessage = stringOrEmpty(safeProperty(nested, "message"));
  const combined = `${code} ${type} ${message} ${nestedMessage}`.toLowerCase();
  return combined.includes("context_length_exceeded")
    || combined.includes("maximum context length")
    || combined.includes("context length")
    || combined.includes("prompt is too long")
    || combined.includes("prompt too long")
    || combined.includes("too many tokens")
    || combined.includes("token limit")
    || combined.includes("max context")
    || (status === 400 && combined.includes("tokens"));
}

function promptTooLongReason(error: unknown): string {
  const message = stringOrEmpty(safeProperty(error, "message")) || safeString(error, 500);
  return `provider rejected prompt as too long: ${message}`;
}

function withWorkspaceDefaults(toolDef: ToolDef, args: Record<string, unknown>, workspacePath: string): Record<string, unknown> {
  const next = cloneEngineRecord(args);
  next.__workspace_path = workspacePath;
  if (safeProperty(toolDef, "name") === "apply_patch") {
    const hasPatchRootAlias = hasUsableString(next.workdir, next.cwd, next.root);
    if (!hasPatchRootAlias) next.workdir = workspacePath;
    return next;
  }
  const properties = toolSchemaProperties(toolDef);
  if ("root" in properties) {
    const hasFileRootAlias = hasUsableString(next.root, next.workspace, next.cwd);
    if (!hasFileRootAlias) next.root = workspacePath;
    return next;
  }
  if ("workdir" in properties) {
    if ((typeof next.workdir !== "string" || !next.workdir.trim()) && typeof next.cwd === "string" && next.cwd.trim()) {
      next.workdir = next.cwd;
    }
    if (typeof next.workdir !== "string" || !next.workdir.trim()) {
      next.workdir = workspacePath;
    }
  }
  return next;
}

function publicToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of safeObjectEntries(args, MAX_ENGINE_ARG_KEYS)) {
    if (key.startsWith("__") || !isSafeEngineObjectKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function toolSchemaProperties(toolDef: ToolDef): Record<string, unknown> {
  return asRecord(safeProperty(safeProperty(toolDef, "parameters"), "properties")) ?? {};
}

function collectArtifactIds(value: unknown, ids: Set<string>, depth = 0): void {
  if (!value || typeof value !== "object" || depth >= MAX_ENGINE_ARTIFACT_JSON_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of safeArrayItems(value, MAX_ENGINE_ARTIFACT_JSON_ARRAY_ITEMS)) collectArtifactIds(item, ids, depth + 1);
    return;
  }
  for (const [key, child] of safeObjectEntries(value, MAX_ENGINE_ARTIFACT_JSON_KEYS)) {
    if ((key === "artifact_id" || key === "artifactId") && typeof child === "string") addArtifactId(ids, child);
    else collectArtifactIds(child, ids, depth + 1);
  }
}

function addArtifactId(ids: Set<string>, value: string): void {
  const id = value.trim();
  if (isSafeArtifactId(id)) ids.add(id);
}

function isSafeArtifactId(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]*_[a-z0-9]{6,}_[a-f0-9]{8,}$/.test(value);
}

function changedFilesForTool(toolName: string, args: Record<string, unknown>): string[] {
  const path = safeProperty(args, "path");
  if ((toolName === "write" || toolName === "edit") && typeof path === "string") return [path];
  if (toolName === "apply_patch") {
    const targetFile = safeProperty(args, "target_file");
    const patch = safeProperty(args, "patch");
    if (typeof targetFile === "string" && targetFile) return [targetFile];
    if (typeof patch === "string") return extractPatchFiles(patch);
  }
  return [];
}

function extractPatchFiles(patch: string): string[] {
  const files = new Set<string>();
  let count = 0;
  for (const line of safeSliceTextBoundary(patch, MAX_ENGINE_PATCH_CHARS).split("\n")) {
    if (count++ >= MAX_ENGINE_PATCH_LINES) break;
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim();
    if (!raw || raw === "/dev/null") continue;
    files.add(raw.replace(/^b\//, ""));
  }
  return [...files];
}
