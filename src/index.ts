#!/usr/bin/env node
/** Seek Code — a terminal-native coding agent powered by DeepSeek. */

import { Command } from "commander";
import {
  commandCompletionProvider,
  InputController,
  readInput,
  restoreTTYInput,
  type ScrollDirection,
} from "./ui/input.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import * as r from "./ui/renderer.js";
import { p } from "./ui/palette.js";
import * as screen from "./tui/screen.js";
import { TuiLayout } from "./tui/layout.js";
import { shouldUseAlternateScreen } from "./tui/alternate-screen.js";
import { Transcript } from "./tui/transcript.js";
import { omitUndefined } from "./utils/object.js";
import { TuiRuntimeViewModel } from "./tui/runtime-view-model.js";
import { approvalModalLines, pickerModalLines, type TuiModalState } from "./tui/modal.js";
import { denyModeSwitchWhileRunning } from "./tui/live-mode-guard.js";
import { handleSlashCommand, isLiveReadonlyCommand, type SlashCommandRuntime } from "./commands/registry.js";

import { explainConfig, loadConfig, migrateProjectConfig, migrateUserConfig, userConfigPath, validateConfig, type ConfigValidationReport, writeUserApiKey, type Config } from "./config.js";
import { DeepSeekClient } from "./client/deepseek.js";
import { getRegistry } from "./tools/registry.js";
import { getMode, nextModeName, type UICallbacks } from "./modes/base.js";
import { prepareToolPermissionMatcher } from "./tools/base.js";
import { Engine, type TurnResult } from "./engine/loop.js";
import { ConversationHistory } from "./session/history.js";
import { createSession, type Session } from "./session/types.js";
import { CapacityController } from "./engine/capacity.js";
import { buildPinnedPrefix, loadPinnedPrefixContext, type PinnedPrefixContext } from "./engine/prefix-builder.js";
import { systemMessage } from "./engine/prefix.js";
import { CostTracker } from "./cost/tracker.js";
import { saveSession } from "./session/store.js";
import { refreshSessionTitle } from "./session/title.js";
import { getApprovalCache, clearApprovalCache } from "./tools/approval-cache.js";
import { applyApprovalChoice } from "./tools/approval-session.js";
import { checkPermission, clearAll as clearPermissions, permissionPatternsFromArgs } from "./tools/permission-ruleset.js";
import { registerBuiltInTools } from "./tools/setup.js";
import { extractCachedInputTokens } from "./client/capabilities.js";
import { reloadMCPManager } from "./mcp/manager.js";
import { linkArtifact } from "./artifacts/store.js";
import { PACKAGE_NAME, VERSION } from "./version.js";
import { assertMinimumVersion, prepareUpdateCheck, promptForPreparedUpdate, runUpdateCommand, type PreparedUpdateCheck } from "./update-check.js";
import { createStartupProfiler, type StartupProfiler } from "./startup-profiler.js";

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

function setupTools(cfg?: ReturnType<typeof loadConfig>, workspacePath = process.cwd()) {
  return registerBuiltInTools(cfg, { clear: true, workspacePath });
}

interface RuntimeStartup {
  workspacePath: string;
  tools: ReturnType<typeof getRegistry>;
  mcpReady: Promise<void>;
  prefixContext: Promise<PinnedPrefixContext>;
}

function startRuntimeStartup(cfg: Config, workspacePath: string, profiler: StartupProfiler): RuntimeStartup {
  const tools = profiler.profileSync("tools.register", () => setupTools(cfg, workspacePath), registry => `${registry.size} registered`);
  const mcpReady = profiler.profileAsync("mcp.reload", async () => {
    await reloadMCPManager(cfg).catch(() => undefined);
  });
  const prefixContext = profiler.profileAsync(
    "prefix.context",
    async () => loadPinnedPrefixContext(cfg, workspacePath),
    context => `${context.agentsMd.sourceFiles.length} instruction files, ${context.skills.length} skills`,
  );
  return { workspacePath, tools, mcpReady, prefixContext };
}

async function finishRuntimeStartup(cfg: Config, startup: RuntimeStartup, profiler: StartupProfiler) {
  const [, prefixContext] = await Promise.all([startup.mcpReady, startup.prefixContext]);
  const prefix = profiler.profileSync(
    "prefix.build",
    () => buildPinnedPrefix(cfg, startup.workspacePath, startup.tools, prefixContext),
    value => `${value.metadata.tool_count} tools`,
  );
  return { tools: startup.tools, prefix };
}

function startConfigValidation(
  cliOverrides: Record<string, unknown>,
  profiler: StartupProfiler,
): Promise<ConfigValidationReport> {
  return profiler.profileAsync(
    "config.validate",
    async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return validateConfig(cliOverrides);
    },
    report => `${report.ok ? "ok" : "invalid"}, ${report.issues.length} issues`,
  ).catch((error: any) => ({
    ok: false,
    issues: [{ level: "error", source: "startup", message: error?.message || String(error) }],
  }));
}

function startUpdatePrefetch(profiler: StartupProfiler): Promise<PreparedUpdateCheck> {
  return profiler.profileAsync(
    "update.prefetch",
    () => prepareUpdateCheck(),
    prepared => prepared.result,
  ).catch(() => ({ result: "current", packageName: PACKAGE_NAME, currentVersion: VERSION }));
}

async function ensureRuntimeApiKey(cfg: Config, cliOverrides: Record<string, unknown>): Promise<Config> {
  if (cfg.api_key) return cfg;
  const path = userConfigPath();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`DEEPSEEK_API_KEY is required. Paste an API key from https://platform.deepseek.com into api_key in ${path}, or pass --api-key.`);
  }

  console.log(p.warning("DeepSeek API key is not configured."));
  console.log(`Get an API key from: ${p.blue("https://platform.deepseek.com")}`);
  console.log(`Config file: ${p.blue(path)}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Paste API key to save it now, or press Enter to configure the file yourself: ")).trim();
    if (!answer) {
      throw new Error(`DEEPSEEK_API_KEY is required. Add api_key to ${path}, then run seek again.`);
    }
    writeUserApiKey(answer);
    console.log(p.success(`Saved API key to ${path}`));
    return loadConfig(cliOverrides);
  } finally {
    rl.close();
  }
}

function recordCompletedTurn(
  session: Session,
  costTracker: CostTracker,
  result: TurnResult,
  userInput: string,
): { tokensIn: number; tokensOut: number; cachedTokensIn: number; cost: number; turnIndex: number } {
  const tokensIn = (result.usage?.prompt_tokens as number) || 0;
  const tokensOut = (result.usage?.completion_tokens as number) || 0;
  session.cumulative_tokens_in += tokensIn;
  session.cumulative_tokens_out += tokensOut;
  const cachedTokensIn = extractCachedInputTokens(result.usage);
  const cost = costTracker.recordTurn(tokensIn, tokensOut, cachedTokensIn, result.duration_s).cost;
  session.cumulative_cost += cost;
  const turnIndex = session.turns.length + 1;
  session.turns.push({
    index: turnIndex,
    user_message: userInput,
    assistant_messages: session.messages.filter(message => message.role === "assistant").slice(-1),
    tool_calls: result.tool_calls,
    tool_results: result.tool_results,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost,
    duration_s: result.duration_s,
    artifact_ids: result.artifact_ids,
  });
  if (result.artifact_ids.length) {
    const turnKey = `turn:${turnIndex}`;
    session.artifact_index[turnKey] = [...new Set([...(session.artifact_index[turnKey] || []), ...result.artifact_ids])];
    session.artifact_index.session = [...new Set([...(session.artifact_index.session || []), ...result.artifact_ids])];
    for (const artifactId of result.artifact_ids) {
      linkArtifact(artifactId, "session", session.id, { turn_index: turnIndex });
      linkArtifact(artifactId, "turn", `${session.id}:${turnIndex}`, { session_id: session.id, turn_index: turnIndex });
    }
  }
  refreshSessionTitle(session);
  return { tokensIn, tokensOut, cachedTokensIn, cost, turnIndex };
}

async function runOneShot(cfg: ReturnType<typeof loadConfig>, prompt: string, profiler = createStartupProfiler()) {
  if (!cfg.api_key) throw new Error("DEEPSEEK_API_KEY is required. Set it in the environment, config file, or --api-key.");
  const workspacePath = resolve(".");
  const startup = startRuntimeStartup(cfg, workspacePath, profiler);
  const modeObj = getMode(cfg.mode);
  const costTracker = new CostTracker(cfg.model);

  const session = createSession({ mode: cfg.mode, model: cfg.model, workspace_path: workspacePath });
  const history = new ConversationHistory(session);
  const client = new DeepSeekClient({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: cfg.model, provider: cfg.provider });

  const { tools, prefix } = await finishRuntimeStartup(cfg, startup, profiler);
  session.prefix_hash = prefix.hash;
  history.addSystem(prefix.systemPrompt);

  const engine = new Engine(cfg, session, history, client, tools, prefix);
  profiler.report();

  process.stdout.write("\n");
  let wasThinking = false;
  const ui: UICallbacks = {
    async onThinking(text) {
      if (cfg.reasoning_effort === "off" || !cfg.thinking_visible) return;
      wasThinking = true;
      process.stdout.write(`\x1b[90m${text}\x1b[0m`);
    },
    async onContent(text) {
      if (wasThinking) {
        process.stdout.write("\n\n");
        wasThinking = false;
      }
      process.stdout.write(text);
    },
    async requestApproval(toolName, _args, description) {
      process.stderr.write(`\nTool '${toolName}' requires approval in one-shot mode.\n${description}\n`);
      return false;
    },
  };

  const result = await engine.runTurn(prompt, modeObj, ui);
  process.stdout.write("\n");
  const recorded = recordCompletedTurn(session, costTracker, result, prompt);
  if (result.usage) console.log(`\n--- Tokens: ${recorded.tokensIn} in / ${recorded.tokensOut} out ---`);
}

async function runInteractive(cfg: ReturnType<typeof loadConfig>, profiler = createStartupProfiler()) {
  if (!cfg.api_key) throw new Error("DEEPSEEK_API_KEY is required. Set it in the environment, config file, or --api-key.");
  const workspacePath = resolve(".");
  const startup = startRuntimeStartup(cfg, workspacePath, profiler);
  let modeObj = getMode(cfg.mode);
  const costTracker = new CostTracker(cfg.model);
  const capacity = new CapacityController();

  const session = createSession({ mode: cfg.mode, model: cfg.model, workspace_path: workspacePath });
  const history = new ConversationHistory(session);
  let client = new DeepSeekClient({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: cfg.model, provider: cfg.provider });

  const runtime = await finishRuntimeStartup(cfg, startup, profiler);
  const tools = runtime.tools;
  let prefix = runtime.prefix;
  session.prefix_hash = prefix.hash;
  history.addSystem(prefix.systemPrompt);

  let engine = new Engine(cfg, session, history, client, tools, prefix);
  profiler.report();

  const initialRawMode = process.stdin.isRaw;
  const useAlternateScreen = shouldUseAlternateScreen(cfg.tui_alternate_screen);
  screen.setup({ alternateScreen: useAlternateScreen });
  const transcript = new Transcript();
  const layout = new TuiLayout(transcript, useAlternateScreen ? "fullscreen" : "inline");

  let turnCount = 0;
  let engineRunning = false;
  let activeAbortController: AbortController | null = null;
  let activeTurnToken = 0;
  let activeTurnStartedAt = 0;
  let lastTurnDurationMs = 0;
  let lastCacheTokens = 0;
  let exitSummary: string | null = null;
  let activeSkillInstruction: string | null = null;
  let promptState = { value: "", cursor: 0, completions: [] as string[] };
  const queuedInputs: string[] = [];
  let runtimeView: TuiRuntimeViewModel | null = null;
  let liveInputController: InputController | null = null;
  let liveInputStop: (() => void) | null = null;
  let pendingRenderTimer: NodeJS.Timeout | null = null;
  let pendingRenderArgs: typeof promptState | null = null;
  let resizeRenderTimer: NodeJS.Timeout | null = null;
  let activeModal: TuiModalState | null = null;

  const setModal = (modal: typeof activeModal) => {
    activeModal = modal;
    requestImmediateRender();
  };

  const clearModal = () => {
    if (!activeModal) return;
    activeModal = null;
    requestImmediateRender();
  };

  const appendUiOutput = (message: unknown, isError = false) => {
    const text = typeof message === "string" ? message : JSON.stringify(message, null, 2);
    transcript.append(isError ? p.error(text) : text);
    transcript.scrollToBottom();
    requestImmediateRender();
  };

  const renderScreen = (input = promptState.value, cursor = promptState.cursor, completions = promptState.completions) => {
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
      pendingRenderArgs = null;
    }
    promptState = { value: input, cursor, completions };
    const modalLines = activeModal?.lines;
    layout.render(omitUndefined({
      footer: footerPrompt(),
      prompt: r.promptSymbol(cfg.mode),
      statusLine: runtimeView?.activeStatusLine || undefined,
      input: modalLines ? "" : input,
      cursor: modalLines ? 0 : cursor,
      completions: modalLines ?? completions,
      completionLimit: modalLines?.length,
      freezeHistory: false,
      mutableTranscriptStartLine: runtimeView?.mutableTranscriptStartLine ?? null,
    }));
  };
  const requestRender = (input = promptState.value, cursor = promptState.cursor, completions = promptState.completions) => {
    pendingRenderArgs = { value: input, cursor, completions };
    if (pendingRenderTimer) return;
    pendingRenderTimer = setTimeout(() => {
      pendingRenderTimer = null;
      const args = pendingRenderArgs || promptState;
      pendingRenderArgs = null;
      renderScreen(args.value, args.cursor, args.completions);
    }, 33);
  };
  const requestImmediateRender = () => {
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
      pendingRenderArgs = null;
    }
    renderScreen();
  };

  const scrollTranscript = (direction: ScrollDirection, amount: number) => {
    const size = screen.termSize();
    const visibleRows = layout.visibleTranscriptRows(omitUndefined({
      footer: footerPrompt(),
      prompt: r.promptSymbol(cfg.mode),
      statusLine: runtimeView?.activeStatusLine || undefined,
      input: promptState.value,
      completions: promptState.completions,
    }), size.rows, size.cols);
    const page = Math.max(1, visibleRows - 1);
    if (direction === "up") transcript.scrollUp(Number.isFinite(amount) ? amount : page);
    else if (direction === "down") transcript.scrollDown(Number.isFinite(amount) ? amount : page);
    else if (direction === "top") transcript.scrollToTop();
    else transcript.scrollToBottom();
    renderScreen();
  };

  runtimeView = new TuiRuntimeViewModel(transcript, {
    thinkingVisible: () => cfg.thinking_visible,
    turnStartedAt: () => activeTurnStartedAt,
    renderNow: requestImmediateRender,
    requestRender,
  });

  const runLiveCommand = async (input: string) => {
    const changed = await handleSlashCommand(input, cfg, session, history, costTracker, {
      renderPicker,
      clearModal,
      write: appendUiOutput,
      getRequestTokenCount: () => engine.requestTokenCount(),
      applyLoadedSession,
      rebuildRuntime,
      rebuildSystemPrompt,
      renderLoadedSession: () => renderSessionTranscript(true),
      setExitSummary: (message) => { exitSummary = message; },
      setActiveSkill: (instruction) => { activeSkillInstruction = instruction; },
      clearActiveSkill: () => { activeSkillInstruction = null; },
      liveReadonly: true,
    });
    if (changed === true) modeObj = getMode(cfg.mode);
  };

  const abortActiveTurn = () => {
    if (!engineRunning) return;
    activeAbortController?.abort();
    engine.interrupt();
    transcript.append(r.interruptedMsg());
    requestImmediateRender();
  };

  const submitLiveInput = (rawInput: string) => {
    const input = rawInput.trim();
    if (!input) return;
    transcript.append(`\n${p.blue("›")} ${p.text(input)}`);
    transcript.scrollToBottom();
    if (isLiveReadonlyCommand(input)) {
      void runLiveCommand(input).catch((e: any) => {
        transcript.append(p.error(`\nError: ${e.message}\n`));
        requestImmediateRender();
      });
      return;
    }
    if (input.startsWith("/")) {
      const cmd = input.split(/\s+/)[0];
      transcript.append(p.warning(`  Command ${cmd} is not available while the agent is running. Use Esc to interrupt, or wait for the turn to finish.`));
      return;
    }
    queuedInputs.push(input);
    transcript.append(p.dim("  Queued for the next turn."));
  };

  liveInputController = new InputController({
    mode: "running",
    completionProvider: value => commandCompletionProvider(value, session.workspace_path),
    completionLimit: 8,
    clearOnSubmit: true,
    onRender: (state, meta) => {
      promptState = { value: state.value, cursor: state.cursor, completions: state.completions };
      if (meta.immediate) requestImmediateRender();
      else requestRender(state.value, state.cursor, state.completions);
    },
    onSubmit: (value) => {
      submitLiveInput(value);
      return true;
    },
    onInterrupt: () => {
      abortActiveTurn();
      return false;
    },
    onCtrlC: () => {
      liveInputController?.reset({ render: true });
      return false;
    },
    onModeCycle: () => {
      return denyModeSwitchWhileRunning(appendUiOutput, r.promptSymbol(cfg.mode));
    },
    onScroll: scrollTranscript,
  });

  const onResize = () => {
    if (resizeRenderTimer) return;
    resizeRenderTimer = setTimeout(() => {
      resizeRenderTimer = null;
      requestImmediateRender();
    }, 16);
  };

  const startGlobalInput = () => {
    if (liveInputStop) return;
    liveInputController?.reset({ render: false });
    liveInputController?.setMode("running", false);
    liveInputStop = liveInputController?.attach({
      stdin: process.stdin,
      stdout: process.stdout,
      resizeTarget: process.stdout,
      onResize,
    }) ?? null;
  };

  const stopGlobalInput = () => {
    liveInputStop?.();
    liveInputStop = null;
    liveInputController?.reset({ render: false });
    if (resizeRenderTimer) {
      clearTimeout(resizeRenderTimer);
      resizeRenderTimer = null;
    }
  };

  const clearPrompt = () => renderScreen("", 0, []);

  const renderPicker: NonNullable<SlashCommandRuntime["renderPicker"]> = (idx, items, title, maxVisibleItems = 12, kind = "picker") => {
    setModal({ kind, lines: pickerModalLines(idx, items, title, maxVisibleItems) });
  };

  const footerItems = () => cfg.status_items.filter(item => !["cache", "cost", "tools", "hints"].includes(item));

  const footerPrompt = () =>
    r.footerConfigured(session.id, footerItems(), {
      mode: cfg.mode,
      model: cfg.model,
      workspace: session.workspace_path || resolve("."),
      tokens: session.cumulative_tokens_in + session.cumulative_tokens_out,
      contextLimit: cfg.context_limit,
      cacheTokens: lastCacheTokens,
      activeTools: runtimeView?.activeToolCount ?? 0,
      elapsedMs: engineRunning && activeTurnStartedAt ? Date.now() - activeTurnStartedAt : lastTurnDurationMs,
      cost: costTracker.totalCost,
    });

  const rebuildSystemPrompt = () => {
    prefix = buildPinnedPrefix(cfg, session.workspace_path, tools);
    session.prefix_hash = prefix.hash;
    session.messages = [
      systemMessage(prefix.systemPrompt),
      ...session.messages.filter(message => !(message.role === "system" && message.name == null)),
    ];
    if (engine) engine.prefix = prefix;
  };

  const rebuildRuntime = () => {
    modeObj = getMode(cfg.mode);
    costTracker.model = cfg.model;
    client = new DeepSeekClient({ apiKey: cfg.api_key, baseUrl: cfg.base_url, model: cfg.model, provider: cfg.provider });
    engine = new Engine(cfg, session, history, client, tools, prefix);
  };

  const applyLoadedSession = (loaded: typeof session) => {
    Object.assign(session, loaded);
    activeSkillInstruction = null;
    clearApprovalCache();
    clearPermissions();
    if (session.workspace_path && existsSync(session.workspace_path)) {
      process.chdir(session.workspace_path);
    } else {
      session.workspace_path = resolve(".");
    }
    cfg.mode = loaded.mode as any;
    cfg.model = loaded.model;
    history.session = session;
    costTracker.hydrateFromSession(session);
    turnCount = session.turns.length || session.messages.filter(message => message.role === "user").length;
    rebuildSystemPrompt();
    rebuildRuntime();
  };

  const renderSessionTranscript = (loaded = false) => {
    layout.reset();
    runtimeView?.renderSessionTranscript({
      session,
      loaded,
      version: VERSION,
      model: cfg.model,
      mode: cfg.mode,
      toolCount: tools.size,
    });
  };
  renderSessionTranscript();

  const createUiCallbacks = (turnToken: number): UICallbacks => ({
    onRuntimeEvent(event) {
      if (turnToken !== activeTurnToken) return;
      if (activeAbortController?.signal.aborted) return;
      runtimeView?.handleRuntimeEvent(event);
    },
    async requestApproval(toolName, args, _description) {
      if (turnToken !== activeTurnToken || activeAbortController?.signal.aborted) return false;
      // Check permission ruleset first
      const toolDef = tools.lookup(toolName);
      const permResult = checkPermission(omitUndefined({
        toolName,
        toolArgs: args as Record<string, unknown>,
        patterns: permissionPatternsFromArgs(args as Record<string, unknown>, toolDef),
        matchesPattern: await prepareToolPermissionMatcher(toolDef, args as Record<string, unknown>),
      }));
      if (permResult.action === "allow") return true;
      if (permResult.action === "deny") {
        transcript.append(p.dim(`  (auto-denied by policy: ${permResult.reason})`));
        renderScreen();
        return false;
      }

      // Check cache
      const cache = getApprovalCache();
      if (cache.isApproved(toolName, args as Record<string, unknown>)) return true;
      const denial = cache.isDenied(toolName, args as Record<string, unknown>);
      if (denial) {
        transcript.append(p.dim(`  (auto-denied: previously denied at ${new Date(denial.deniedAt).toLocaleTimeString()})`));
        renderScreen();
        return false;
      }

      const resumeLiveInput = !!liveInputStop;
      if (resumeLiveInput) stopGlobalInput();
      setModal({ kind: "approval", lines: approvalModalLines(toolName, (args || {}) as Record<string, unknown>) });
      return new Promise((resolve) => {
        let detachInput: (() => void) | null = null;
        let approvalInput: InputController | null = null;
        let settled = false;
        const abortSignal = activeAbortController?.signal;

        const finish = (decision: boolean, choice: "always" | "once" | "deny" | "abort"): true => {
          if (settled) return true;
          settled = true;
          detachInput?.();
          approvalInput?.dispose();
          abortSignal?.removeEventListener("abort", abortApproval);
          activeModal = null;

          if (turnToken !== activeTurnToken || activeAbortController?.signal.aborted) {
            renderScreen();
            resolve(false);
            return true;
          }

          if (choice === "always") {
            const outcome = applyApprovalChoice(toolName, args as Record<string, unknown>, "always");
            transcript.append(p.success(`  ${outcome.message}`));
          } else if (choice === "once") {
            const outcome = applyApprovalChoice(toolName, args as Record<string, unknown>, "once");
            transcript.append(p.success(`  ${outcome.message}`));
          } else if (choice === "deny") {
            const outcome = applyApprovalChoice(toolName, args as Record<string, unknown>, "deny");
            transcript.append(p.warning(`  ${outcome.message}`));
          }

          renderScreen();
          if (resumeLiveInput && engineRunning) startGlobalInput();
          resolve(decision);
          return true;
        };
        const abortApproval = () => finish(false, "abort");
        if (abortSignal?.aborted) {
          abortApproval();
          return;
        }
        abortSignal?.addEventListener("abort", abortApproval, { once: true });

        approvalInput = new InputController({
          mode: "approval",
          editable: false,
          onUnhandledSequence: (sequence) => {
            const a = sequence.trim().toLowerCase();
            if (!a || a === "\r" || a === "\n") return false;
            if (a === "a" || a === "always") {
              return finish(true, "always");
            }
            if (a.startsWith("y")) return finish(true, "once");
            return finish(false, "deny");
          },
          onCtrlC: () => finish(false, "deny"),
          onInterrupt: () => finish(false, "deny"),
        });
        detachInput = approvalInput.attach({
          stdin: process.stdin,
          stdout: process.stdout,
          bracketedPaste: false,
        });
      });
    },
  });

  try {
    screen.enableBracketedPaste();
    renderScreen();

    while (true) {
      promptState = { value: "", cursor: 0, completions: [] };
      let input: string;
      if (queuedInputs.length) {
        input = queuedInputs.shift()!.trim();
        clearPrompt();
      } else {
        const result = await readInput(r.promptSymbol(cfg.mode), {
          completionProvider: value => commandCompletionProvider(value, session.workspace_path),
          onInterrupt: () => {
            if (engineRunning) {
              activeAbortController?.abort();
              engine.interrupt();
              transcript.append(r.interruptedMsg());
              renderScreen();
            }
          },
          onModeCycle: () => {
            cfg.mode = nextModeName(cfg.mode);
            session.mode = cfg.mode;
            modeObj = getMode(cfg.mode);
            rebuildSystemPrompt();
            rebuildRuntime();
            return r.promptSymbol(cfg.mode);
          },
          onScroll: scrollTranscript,
          onRender: ({ value, cursor, completions }) => renderScreen(value, cursor, completions),
        });

        if (result.type === "eof") break;
        if (result.type !== "line") continue;

        input = result.value.trim();
        clearPrompt();
        if (!input) continue;
        transcript.append(`\n${p.blue("›")} ${p.text(input)}`);
        transcript.scrollToBottom();
        clearPrompt();
      }

      // Slash commands
      if (input.startsWith("/")) {
        const changed = await handleSlashCommand(input, cfg, session, history, costTracker, {
          renderPicker,
          clearModal,
          write: appendUiOutput,
          getRequestTokenCount: () => engine.requestTokenCount(),
          applyLoadedSession,
          rebuildRuntime,
          rebuildSystemPrompt,
          renderLoadedSession: () => renderSessionTranscript(true),
          setExitSummary: (message) => { exitSummary = message; },
          setActiveSkill: (instruction) => { activeSkillInstruction = instruction; },
          clearActiveSkill: () => { activeSkillInstruction = null; },
        });
        if (changed === "exit") break;
        if (typeof changed === "object" && changed.type === "prompt") {
          input = changed.input;
          transcript.append(p.dim(`  Expanded ${changed.label || "compatible slash command"}.`));
          renderScreen();
        } else {
          if (changed) modeObj = getMode(cfg.mode);
          renderScreen();
          continue;
        }
      }

      turnCount++;

      // Capacity preview. Engine owns the actual refresh/verify/replan intervention.
      const capacityDecision = capacity.observe(engine.requestTokenCount(), cfg.context_limit);
      if (capacityDecision.action !== "no_intervention") {
        transcript.append(p.dim(`\nContext pressure: ${capacityDecision.risk} (${capacityDecision.action}).\n`));
        renderScreen();
      }

      // Run turn
      try {
        engineRunning = true;
        activeTurnStartedAt = Date.now();
        activeAbortController = new AbortController();
        const turnToken = ++activeTurnToken;
        const ui = createUiCallbacks(turnToken);
        runtimeView?.beginTurn();
        startGlobalInput();
        const skillInstruction = activeSkillInstruction;
        activeSkillInstruction = null;
        const result = await engine.runTurn(input, modeObj, ui, omitUndefined({
          signal: activeAbortController.signal,
          ephemeralInstructions: skillInstruction || undefined,
        }));
        renderScreen();
        engineRunning = false;
        runtimeView?.finishTurn();
        const recorded = recordCompletedTurn(session, costTracker, result, input);
        lastCacheTokens = recorded.cachedTokensIn;
        lastTurnDurationMs = Math.round(result.duration_s * 1000);
        if (turnCount % 5 === 0) {
          try { saveSession(session); }
          catch (e: any) { transcript.append(p.warning(`\nCould not save session: ${e.message}`)); }
        }
        transcript.append("");
        renderScreen();
      } catch (e: any) {
        runtimeView?.finishTurn();
        engineRunning = false;
        if (isAbortError(e) || activeAbortController?.signal.aborted) {
          transcript.append("");
        } else {
          transcript.append(p.error(`\nError: ${e.message}\n`));
        }
        renderScreen();
      } finally {
        stopGlobalInput();
        engineRunning = false;
        activeTurnStartedAt = 0;
        activeAbortController = null;
        activeTurnToken++;
      }
    }
  } finally {
    screen.disableBracketedPaste();
    runtimeView?.dispose();
    if (pendingRenderTimer) {
      clearTimeout(pendingRenderTimer);
      pendingRenderTimer = null;
      pendingRenderArgs = null;
    }
    stopGlobalInput();
    layout.finish();
    screen.teardown({ finalNewline: false });
    restoreTTYInput(process.stdin, initialRawMode);
  }
  if (exitSummary) {
    console.log(exitSummary);
  } else {
    console.log(p.dim("Goodbye!"));
  }
}

// CLI setup
const program = new Command();

function optionFromCli<T>(name: string, value: T): T | undefined {
  return program.getOptionValueSource(name) === "cli" ? value : undefined;
}

function configOverridesFromCliOptions(options: Record<string, any>): Record<string, unknown> {
  const tuiAlternateScreen = program.getOptionValueSource("altScreen") === "cli"
    ? options.altScreen === false ? "never" : "always"
    : undefined;
  return {
    model: optionFromCli("model", options.model),
    mode: optionFromCli("mode", options.mode),
    api_key: optionFromCli("apiKey", options.apiKey),
    provider: optionFromCli("provider", options.provider),
    base_url: optionFromCli("baseUrl", options.baseUrl),
    max_tokens: optionFromCli("maxTokens", parseOptionalInt(options.maxTokens)),
    reasoning_effort: optionFromCli("reasoningEffort", options.reasoningEffort),
    tui_alternate_screen: tuiAlternateScreen,
  };
}

program
  .name("seek")
  .description("Seek Code — a terminal-native coding agent powered by DeepSeek")
  .version(VERSION)
  .argument("[prompt...]", "One-shot prompt (omit for interactive REPL)")
  .option("-m, --model <model>", "Model to use", "deepseek-v4-pro")
  .option("--mode <mode>", "Interaction mode: plan, agent, yolo", "agent")
  .option("--api-key <key>", "DeepSeek API key")
  .option("--provider <provider>", "Provider: deepseek, deepseek-cn, nvidia-nim, openrouter, novita, fireworks, sglang")
  .option("--base-url <url>", "API base URL")
  .option("--max-tokens <n>", "Max tokens per response", "8192")
  .option("-r, --reasoning-effort <effort>", "Reasoning effort: off, low, medium, high, max, xhigh", "high")
  .option("--alt-screen", "Use fullscreen alternate screen")
  .option("--no-alt-screen", "Use inline mode with terminal-native scrollback")
  .action(async (promptParts: string[] | undefined, options) => {
    const startupProfiler = createStartupProfiler();
    startupProfiler.mark("cli.action");
    const prompt = (promptParts || []).join(" ").trim();
    const cliOverrides = configOverridesFromCliOptions(options);
    const validationPromise = startConfigValidation(cliOverrides, startupProfiler);
    const updateCheckPromise = prompt ? null : startUpdatePrefetch(startupProfiler);
    const loadedConfig = startupProfiler.profileSync("config.load", () => loadConfig(cliOverrides));
    const cfg = await startupProfiler.profileAsync("api_key.ensure", () => ensureRuntimeApiKey(loadedConfig, cliOverrides));

    if (prompt) {
      await validationPromise;
      await runOneShot(cfg, prompt, startupProfiler);
    } else {
      const preparedUpdate = await updateCheckPromise!;
      const updateResult = await startupProfiler.profileAsync("update.prompt", () => promptForPreparedUpdate(preparedUpdate));
      await validationPromise;
      if (updateResult === "updated") {
        startupProfiler.report();
        return;
      }
      await runInteractive(cfg, startupProfiler);
    }
  });

program.hook("preAction", async (_thisCommand, actionCommand) => {
  assertMinimumVersion({ commandName: actionCommand.name() });
});

program
  .command("update")
  .description("Check for and install the latest Seek Code version")
  .option("--check", "Only check whether an update is available")
  .option("--diagnose", "Print installation diagnostics without checking npm")
  .option("-y, --yes", "Install without prompting")
  .action(async (options) => {
    const result = await runUpdateCommand({
      yes: options.yes,
      checkOnly: options.check,
      diagnoseOnly: options.diagnose,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (["failed", "locked", "unsupported"].includes(result)) process.exitCode = 1;
  });

program
  .command("serve")
  .description("Start the HTTP/SSE server")
  .option("-p, --port <port>", "Port to listen on", "8080")
  .option("-h, --host <host>", "Host to bind to", "127.0.0.1")
  .action(async (options) => {
    const cliOverrides = configOverridesFromCliOptions(program.opts());
    setupTools(await ensureRuntimeApiKey(loadConfig(cliOverrides), cliOverrides), resolve("."));
    const { runServer } = await import("./server/app.js");
    runServer(options.host, parseOptionalInt(options.port) ?? 8080);
  });

program
  .command("config")
  .description("Validate, migrate, or explain Seek Code configuration")
  .argument("[action]", "validate, migrate, or explain", "validate")
  .option("--target <target>", "Migration target: user or project", "user")
  .option("--dry-run", "Show migration actions without writing")
  .option("--json", "Emit JSON output", true)
  .action(async (action, options) => {
    const cliOverrides = configOverridesFromCliOptions(program.opts());
    if (action === "validate") {
      const report = validateConfig(cliOverrides);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    if (action === "migrate") {
      const report = options.target === "project"
        ? migrateProjectConfig({ dryRun: options.dryRun })
        : migrateUserConfig({ dryRun: options.dryRun });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (action === "explain") {
      console.log(JSON.stringify(explainConfig(cliOverrides), null, 2));
      return;
    }
    throw new Error(`Unknown config action: ${action}`);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(p.error(`Error: ${message}`));
  process.exitCode = 1;
});
