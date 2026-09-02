/** Diagnostics, GitHub context, PR attempt, automation, and MCP manager helpers. */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { PermissionLevel, type ToolDef } from "./base.js";
import { getRegistry } from "./registry.js";
import { createArtifact, getArtifact, listArtifacts, readArtifact } from "../artifacts/store.js";
import { addMCPServer, getMCPManager, reloadMCPManager, removeMCPServer, setMCPServerEnabled } from "../mcp/manager.js";
import type { MCPConfig } from "../config.js";
import { resolvePathAlias } from "./path-resolution.js";
import { getLspManager } from "../lsp/manager.js";
import { omitUndefined } from "../utils/object.js";
import { safeJsonStringify } from "../utils/json-safe.js";
import { safeSliceTextBoundary } from "../utils/text-boundary.js";
import { readBoundedRegularFileSync } from "../utils/safe-file.js";

const MCP_MANAGER_NAME_MAX_CHARS = 80;
const MCP_MANAGER_COMMAND_MAX_CHARS = 4_096;
const MCP_MANAGER_URL_MAX_CHARS = 8_192;
const MCP_MANAGER_ARGS_MAX = 128;
const MCP_MANAGER_ARG_MAX_CHARS = 4_096;
const MCP_MANAGER_ENV_MAX_ENTRIES = 128;
const MCP_MANAGER_ENV_KEY_MAX_CHARS = 128;
const MCP_MANAGER_ENV_VALUE_MAX_CHARS = 8_192;
const MCP_MANAGER_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const MCP_MANAGER_CONTROL_RE = /[\u0000-\u001F\u007F]/;
const DIAGNOSTIC_OUTPUT_MAX_CHARS = 1_000_000;
const DIAGNOSTIC_RETURN_OUTPUT_MAX_CHARS = 100_000;
const DIAGNOSTIC_MAX_ITEMS = 500;
const DIAGNOSTIC_MAX_PARSE_LINES = 20_000;
const DIAGNOSTIC_MAX_FILE_FILTERS = 128;
const DIAGNOSTIC_FILE_MAX_CHARS = 4096;
const DIAGNOSTIC_MESSAGE_MAX_CHARS = 1000;
const DIAGNOSTIC_CODE_MAX_CHARS = 120;
const DIAGNOSTIC_WORKDIR_MAX_CHARS = 4096;
const DIAGNOSTIC_ID_MAX_CHARS = 160;
const GITHUB_TARGET_MAX_CHARS = 512;
const PR_ATTEMPT_COMMAND_MAX_CHARS = 20_000;
const PR_ATTEMPT_TEXT_MAX_CHARS = 20_000;
const PR_ATTEMPT_REF_MAX_CHARS = 256;
const AUTOMATION_PROMPT_MAX_CHARS = 1_980;
const AUTOMATION_SCHEDULE_MAX_CHARS = 1_000;
const DIAGNOSTIC_CONTROL_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DIAGNOSTIC_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const UNREADABLE_ARG = Symbol("unreadable_arg");

type DiagnosticsToolExtras = Partial<Omit<ToolDef, "name" | "description" | "parameters" | "execute" | "permission" | "category" | "parallelOk">>;

function run(command: string, workdir = "."): string {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return `Error: ${result.error.message}`;
  return safeDiagnosticOutput([result.stdout, result.stderr].filter(Boolean).join("").trim() || `(exit ${result.status ?? "unknown"})`);
}

function runRaw(command: string, workdir = "."): string {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return `Error: ${result.error.message}`;
  return [result.stdout, result.stderr].filter(Boolean).join("").trim();
}

function runWithStatus(command: string, workdir = "."): { output: string; status: number | null; error?: string } {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return { output: `Error: ${result.error.message}`, status: null, error: result.error.message };
  return { output: safeDiagnosticOutput([result.stdout, result.stderr].filter(Boolean).join("").trim()), status: result.status ?? null };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveWorkdir(args: Record<string, unknown>): string {
  const workspacePath = safeDiagnosticProperty(args, "__workspace_path");
  const workdir = safeDiagnosticProperty(args, "workdir");
  const cwd = safeDiagnosticProperty(args, "cwd");
  const base = typeof workspacePath === "string" && workspacePath.trim()
    ? safeDiagnosticPath(workspacePath)
    : process.cwd();
  if (typeof workdir === "string" && workdir.trim()) return resolvePathAlias(safeDiagnosticPath(workdir), base);
  if (typeof cwd === "string" && cwd.trim()) return resolvePathAlias(safeDiagnosticPath(cwd), base);
  return base;
}

function validateDiagnosticsWorkdirArgs(args: Record<string, unknown>) {
  const workdir = readDiagnosticArg(args, "workdir");
  if (!workdir.ok) return { ok: false as const, message: "workdir must be a string." };
  const cwd = readDiagnosticArg(args, "cwd");
  if (!cwd.ok) return { ok: false as const, message: "workdir must be a string." };
  for (const workdirInput of [workdir.value, cwd.value]) {
    if (workdirInput === undefined || workdirInput === null || workdirInput === "") continue;
    if (typeof workdirInput !== "string") {
      return { ok: false as const, message: "workdir must be a string." };
    }
    if (!workdirInput.trim()) continue;
    const safeWorkdir = safeDiagnosticPath(workdirInput);
    if (!safeWorkdir) return { ok: false as const, message: "workdir contains invalid characters." };
    return { ok: true as const, args: { ...safeDiagnosticCloneArgs(args), workdir: safeWorkdir } };
  }
  return { ok: true as const, args: safeDiagnosticCloneArgs(args) };
}

async function diagnostics(args: Record<string, unknown>): Promise<string> {
  const validated = validateDiagnosticsWorkdirArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  const info = {
    cwd: resolve(workdir),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    git: run("git status --short 2>&1", workdir),
    tools: buildDiagnosticsToolList(),
  };
  return safeJsonStringify(info, { space: 2 });
}

async function githubIssueContext(args: Record<string, unknown>): Promise<string> {
  const validated = validateGithubIssueArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const issueValue = validated.args.issue as string;
  const issue = issueValue?.trim();
  if (!issue) return "Error: issue, number, or url is required.";
  const output = run(`gh issue view ${shellQuote(issue)} --json number,title,state,author,body,url,comments`, resolveWorkdir(validated.args));
  const artifact = createArtifact({ kind: "github_issue", name: `issue-${safeName(issue)}.json`, content: output, extension: ".json", metadata: { issue } });
  return withArtifact(output, artifact.id);
}

async function githubPrContext(args: Record<string, unknown>): Promise<string> {
  const validated = validateGithubPrArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args as Record<string, unknown>;
  const prValue = normalized.pr as string;
  const pr = prValue?.trim();
  if (!pr) return "Error: pr, number, or url is required.";
  const includeDiff = normalized.diff === true;
  const workdir = resolveWorkdir(normalized);
  const base = run(`gh pr view ${shellQuote(pr)} --json number,title,state,author,body,url,comments,headRefName,baseRefName`, workdir);
  const output = includeDiff ? `${base}\n\n[diff]\n${run(`gh pr diff ${shellQuote(pr)} --patch`, workdir)}` : base;
  const artifact = createArtifact({ kind: "github_pr", name: `pr-${safeName(pr)}.${includeDiff ? "txt" : "json"}`, content: output, metadata: { pr, includeDiff } });
  return withArtifact(output, artifact.id);
}

async function githubComment(args: Record<string, unknown>): Promise<string> {
  const validated = validateGithubCommentArgs(args);
  if (!validated.ok) {
    const message = validated.message === "body is required." || validated.message === "issue, pr, number, or url is required."
      ? "target and body are required."
      : validated.message;
    return `Error: ${message}`;
  }
  const normalized = validated.args as Record<string, unknown>;
  const target = normalized.target as string;
  const body = normalized.body as string;
  if (!target || !body) return "Error: target and body are required.";
  const guard = githubMutationGuard(normalized, { requireClean: normalized.allow_dirty !== true });
  if (guard) return guard;
  const workdir = resolveWorkdir(normalized);
  const evidence = verifyGithubTarget(target, workdir);
  if (evidence.startsWith("Error:")) return evidence;
  const artifact = createArtifact({ kind: "github_evidence", name: `comment-${safeName(target)}.json`, content: evidence, extension: ".json", metadata: { target, action: "comment" } });
  return run(`gh issue comment ${shellQuote(target)} --body ${shellQuote(body)}`, workdir);
}

async function githubCloseIssue(args: Record<string, unknown>): Promise<string> {
  const validated = validateGithubCloseArgs(args);
  if (!validated.ok) {
    const message = validated.message === "reason is required." || validated.message === "issue, number, or url is required."
      ? "issue and reason are required."
      : validated.message;
    return `Error: ${message}`;
  }
  const normalized = validated.args as Record<string, unknown>;
  const issue = normalized.issue as string;
  const reason = normalized.reason as string;
  if (!issue || !reason.trim()) return "Error: issue and reason are required.";
  const guard = githubMutationGuard(normalized, { requireClean: normalized.allow_dirty !== true });
  if (guard) return guard;
  const workdir = resolveWorkdir(normalized);
  const evidence = verifyGithubTarget(issue, workdir);
  if (evidence.startsWith("Error:")) return evidence;
  createArtifact({ kind: "github_evidence", name: `close-${safeName(issue)}.json`, content: evidence, extension: ".json", metadata: { issue, action: "close" } });
  return run(`gh issue close ${shellQuote(issue)} --comment ${shellQuote(reason)}`, workdir);
}

const ATTEMPT_DIR = join(tmpdir(), "seek-code-pr-attempts");

async function prAttemptRecord(args: Record<string, unknown>): Promise<string> {
  const validated = validateDiagnosticsWorkdirArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const workdir = resolveWorkdir(validated.args);
  const id = `attempt_${Date.now().toString(36)}`;
  const patch = runRaw("git diff --binary", workdir);
  const status = runRaw("git status --porcelain=v1", workdir);
  const branch = runRaw("git branch --show-current 2>&1", workdir);
  const artifact = createArtifact({ kind: "pr_attempt", name: `${id}.patch`, content: patch, extension: ".patch", metadata: { id, workdir: resolve(workdir), status, branch } });
  return safeJsonStringify({ id, artifact_id: artifact.id, file: artifact.path, bytes: patch.length, sha256: artifact.sha256, branch, status }, { space: 2 });
}

async function prAttemptList(): Promise<string> {
  const artifacts = listArtifacts(100, "pr_attempt");
  const legacyDir = safeLegacyAttemptDir();
  const legacy = legacyDir
    ? readdirSync(legacyDir)
      .filter(name => name.endsWith(".patch"))
      .filter(name => safeLegacyAttemptFile(name.replace(/\.patch$/, "")) !== null)
      .map(name => ({ legacy: name.replace(/\.patch$/, "") }))
    : [];
  if (!artifacts.length && !legacy.length) return "No PR attempts.";
  return safeJsonStringify({ artifacts, legacy }, { space: 2 });
}

async function prAttemptRead(args: Record<string, unknown>): Promise<string> {
  const id = normalizeAttemptId(safeDiagnosticProperty(args, "id"));
  if (!id) return "Error: id is required.";
  const artifact = getArtifact(id);
  if (artifact) return readArtifact(id);
  const file = safeLegacyAttemptFile(id);
  if (!file) return `Error: attempt not found: ${id}`;
  try {
    return safeDiagnosticOutput(readBoundedRegularFileSync(file, DIAGNOSTIC_OUTPUT_MAX_CHARS, "legacy PR attempt"));
  } catch {
    return `Error: attempt not found: ${id}`;
  }
}

async function prAttemptPreflight(args: Record<string, unknown>): Promise<string> {
  const validated = validateIdArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const id = normalizeAttemptId(validated.args.id);
  if (!id) return "Error: id is required.";
  const artifact = getArtifact(id);
  const file = artifact?.path || safeLegacyAttemptFile(id);
  if (!file) return `Error: attempt not found: ${id}`;
  return run(`git apply --check ${shellQuote(file)}`, resolveWorkdir(validated.args));
}

async function prAttemptBranch(args: Record<string, unknown>): Promise<string> {
  const validated = validatePrAttemptBranchArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  const requestedBranch = typeof normalized.branch === "string" ? normalized.branch.trim() : "";
  const name = (requestedBranch || `seek-code/${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9._/-]/g, "-");
  const base = typeof normalized.base === "string" ? normalized.base.trim() : "";
  const guard = ensureGitRepo(workdir);
  if (guard) return guard;
  const output = run(`git checkout ${base ? `${shellQuote(base)} ` : ""}-b ${shellQuote(name)} 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_attempt_branch", name: `${safeName(name)}.txt`, content: output, metadata: { workdir: resolve(workdir), branch: name, base } });
  return safeJsonStringify({ branch: name, artifact_id: artifact.id, output }, { space: 2 });
}

async function prAttemptGate(args: Record<string, unknown>): Promise<string> {
  const validated = validatePrAttemptGateArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  const command = normalized.command as string;
  if (!command) return "Error: command is required.";
  const result = runWithStatus(command, workdir);
  const passed = result.status === 0;
  const output = result.output || `(exit ${result.status ?? "unknown"})`;
  const artifact = createArtifact({ kind: "pr_attempt_gate", name: "gate.log", content: output, extension: ".log", metadata: { workdir: resolve(workdir), command, passed, status: result.status } });
  return safeJsonStringify({ command, passed, status: result.status, artifact_id: artifact.id, output }, { space: 2 });
}

async function prAttemptPushDraft(args: Record<string, unknown>): Promise<string> {
  const validated = validatePrAttemptPushDraftArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  const title = typeof normalized.title === "string" ? normalized.title : "Seek Code draft PR";
  const body = typeof normalized.body === "string" ? normalized.body : "Created by Seek Code.";
  const branch = (typeof normalized.branch === "string" ? normalized.branch : run("git branch --show-current", workdir)).trim();
  if (!branch) return "Error: branch is required or current branch cannot be detected.";
  const guard = githubMutationGuard(normalized, { requireClean: normalized.allow_dirty !== true });
  if (guard) return guard;
  const push = run(`git push -u origin ${shellQuote(branch)} 2>&1`, workdir);
  const create = run(`gh pr create --draft --title ${shellQuote(title)} --body ${shellQuote(body)} 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_attempt_push", name: `${safeName(branch)}.log`, content: `${push}\n\n${create}`, extension: ".log", metadata: { workdir: resolve(workdir), branch, title } });
  return safeJsonStringify({ branch, artifact_id: artifact.id, push, create }, { space: 2 });
}

async function prAttemptReviewSync(args: Record<string, unknown>): Promise<string> {
  const validated = validateGithubPrArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const workdir = resolveWorkdir(validated.args);
  const pr = validated.args.pr as string;
  if (!pr) return "Error: pr, number, or url is required.";
  if (!commandExists("gh")) return "Error: GitHub CLI 'gh' is required.";
  const comments = run(`gh pr view ${shellQuote(pr)} --json comments,reviews,reviewDecision,url 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_review_comments", name: `pr-${safeName(pr)}-review.json`, content: comments, extension: ".json", metadata: { workdir: resolve(workdir), pr } });
  return safeJsonStringify({ pr, artifact_id: artifact.id, comments }, { space: 2 });
}

async function prAttemptRollback(args: Record<string, unknown>): Promise<string> {
  const validated = validatePrAttemptRollbackArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  const branch = typeof normalized.branch === "string" ? normalized.branch : "";
  const target = typeof normalized.target === "string" ? normalized.target : "HEAD";
  const guard = ensureGitRepo(workdir);
  if (guard) return guard;
  const before = run("git status --porcelain=v1 && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD", workdir);
  const output = branch
    ? run(`git checkout ${shellQuote(branch)} 2>&1 && git reset --hard ${shellQuote(target)} 2>&1`, workdir)
    : run(`git reset --hard ${shellQuote(target)} 2>&1`, workdir);
  const after = run("git status --porcelain=v1 && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD", workdir);
  const artifact = createArtifact({ kind: "pr_attempt_rollback", name: "rollback.log", content: `[before]\n${before}\n\n[output]\n${output}\n\n[after]\n${after}`, extension: ".log", metadata: { workdir: resolve(workdir), branch, target } });
  return safeJsonStringify({ branch: branch || null, target, artifact_id: artifact.id, output }, { space: 2 });
}

interface Automation {
  id: string;
  prompt: string;
  schedule?: string;
  paused: boolean;
  created_at: string;
}

const automations = new Map<string, Automation>();

async function automationCreate(args: Record<string, unknown>): Promise<string> {
  const validated = validatePromptArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const automation: Automation = omitUndefined({
    id: `auto_${Date.now().toString(36)}`,
    prompt: normalized.prompt as string,
    schedule: typeof normalized.schedule === "string" ? normalized.schedule : undefined,
    paused: false,
    created_at: new Date().toISOString(),
  });
  automations.set(automation.id, automation);
  return safeJsonStringify(automation, { space: 2 });
}

async function automationList(): Promise<string> {
  return safeJsonStringify([...automations.values()], { space: 2 });
}

async function automationRead(args: Record<string, unknown>): Promise<string> {
  const id = normalizeAttemptId(safeDiagnosticProperty(args, "id"));
  if (!id) return "Error: id is required.";
  const automation = automations.get(id);
  return automation ? safeJsonStringify(automation, { space: 2 }) : `Error: automation not found: ${id}`;
}

async function automationUpdate(args: Record<string, unknown>): Promise<string> {
  const validated = validateAutomationUpdateArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const id = normalized.id as string;
  const automation = automations.get(id);
  if (!automation) return `Error: automation not found: ${id}`;
  if (normalized.prompt !== undefined) {
    automation.prompt = normalized.prompt as string;
  }
  if (normalized.schedule !== undefined) {
    automation.schedule = normalized.schedule as string;
  }
  return safeJsonStringify(automation, { space: 2 });
}

async function automationStatus(args: Record<string, unknown>, paused: boolean): Promise<string> {
  const id = normalizeAttemptId(safeDiagnosticProperty(args, "id"));
  if (!id) return "Error: id is required.";
  const automation = automations.get(id);
  if (!automation) return `Error: automation not found: ${id}`;
  automation.paused = paused;
  return safeJsonStringify(automation, { space: 2 });
}

async function automationDelete(args: Record<string, unknown>): Promise<string> {
  const id = normalizeAttemptId(safeDiagnosticProperty(args, "id"));
  if (!id) return "Error: id is required.";
  return automations.delete(id) ? `Deleted automation ${id}.` : `Error: automation not found: ${id}`;
}

async function automationRun(args: Record<string, unknown>): Promise<string> {
  const id = normalizeAttemptId(safeDiagnosticProperty(args, "id"));
  if (!id) return "Error: id is required.";
  const automation = automations.get(id);
  if (!automation) return `Error: automation not found: ${id}`;
  const { getTaskManager } = await import("../engine/task-lifecycle.js");
  const task = getTaskManager().createTask("background", `Automation: ${automation.prompt}`);
  getTaskManager().startTask(task.id);
  return safeJsonStringify({ task_id: task.id, automation }, { space: 2 });
}

async function mcpManager(args: Record<string, unknown>): Promise<string> {
  const action = normalizeMCPAction(safeDiagnosticProperty(args, "action"));
  try {
    if (action === "list") return safeJsonStringify(getMCPManager().list(), { space: 2 });
    if (action === "reload") {
      const manager = await reloadMCPManager();
      return safeJsonStringify({ reloaded: true, servers: manager.list() }, { space: 2 });
    }
    if (action === "health") {
      const nameInput = readDiagnosticArg(args, "name");
      if (!nameInput.ok) return "Error: name is required.";
      const name = normalizeMCPName(nameInput.value) || undefined;
      if (nameInput.value !== undefined && !name) return "Error: name is required.";
      return safeJsonStringify(await getMCPManager().healthCheck(name), { space: 2 });
    }
    if (action === "reconnect") {
      const name = normalizeMCPName(safeDiagnosticProperty(args, "name"));
      if (!name) return "Error: name is required.";
      const server = getMCPManager().list().find(item => item.name === name);
      if (!server) return `Error: MCP server not found: ${name}`;
      return await getMCPManager().connectOne(server);
    }
    if (action === "add") {
      const server = parseMCPServer(args);
      const servers = addMCPServer(server);
      return safeJsonStringify({ added: server.name, servers }, { space: 2 });
    }
    if (action === "enable" || action === "disable") {
      const name = normalizeMCPName(safeDiagnosticProperty(args, "name"));
      if (!name) return "Error: name is required.";
      const servers = setMCPServerEnabled(name, action === "enable");
      return safeJsonStringify({ name, enabled: action === "enable", servers }, { space: 2 });
    }
    if (action === "remove" || action === "delete") {
      const name = normalizeMCPName(safeDiagnosticProperty(args, "name"));
      if (!name) return "Error: name is required.";
      const servers = removeMCPServer(name);
      return safeJsonStringify({ removed: name, servers }, { space: 2 });
    }
    return `Error: unsupported MCP action '${action}'. Use list, add, enable, disable, remove, reload, health, reconnect.`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function lspDiagnostics(args: Record<string, unknown>): Promise<string> {
  const validated = validateLspDiagnosticsArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  const language = typeof normalized.language === "string" ? normalized.language : detectLanguage(workdir);
  const files = normalizeFiles(normalized.files);
  const minSeverity = typeof normalized.min_severity === "string"
    ? normalized.min_severity
    : typeof normalized.severity === "string"
      ? normalized.severity
      : "all";
  const command = diagnosticCommand(language, workdir);
  if (!command) return `Error: unsupported language '${language}'. Supported: typescript, python, go, rust.`;
  const output = run(command, workdir);
  const diagnostics = filterDiagnostics(parseDiagnostics(output, language), { files, minSeverity, workdir });
  const summary = summarizeDiagnostics(diagnostics);
  const artifact = createArtifact({
    kind: "lsp_diagnostics",
    name: `${language}-diagnostics.txt`,
    content: output,
    metadata: { language, workdir: resolve(workdir), command, files, min_severity: minSeverity, summary },
  });
  return safeJsonStringify({
    language,
    command,
    artifact_id: artifact.id,
    summary,
    diagnostics,
    output: truncateDiagnosticText(output, DIAGNOSTIC_RETURN_OUTPUT_MAX_CHARS),
  }, { space: 2 });
}

async function lspSymbols(args: Record<string, unknown>): Promise<string> {
  const validated = validateLspFileArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  const file = normalized.file as string;
  try {
    const result = await getLspManager().documentSymbolsWithBackend(file, workdir);
    return safeJsonStringify({ file, workdir: resolve(workdir), backend: result.backend, symbols: result.value }, { space: 2 });
  } catch (error: any) {
    return `Error: ${error?.message || String(error)}`;
  }
}

async function lspDefinition(args: Record<string, unknown>): Promise<string> {
  const validated = validateLspDefinitionArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized: Record<string, unknown> = validated.args;
  const workdir = resolveWorkdir(normalized);
  const symbol = normalized.symbol as string;
  const file = typeof normalized.file === "string" && normalized.file.trim()
    ? normalized.file.trim()
    : typeof normalized.path === "string" && normalized.path.trim() ? normalized.path.trim() : undefined;
  const line = typeof normalized.line === "number" ? normalized.line : undefined;
  const character = typeof normalized.character === "number" ? normalized.character : undefined;
  try {
    const result = await getLspManager().definitionWithBackend(symbol, workdir, omitUndefined({ file, line, character }));
    return safeJsonStringify({ symbol, workdir: resolve(workdir), backend: result.backend, matches: result.value }, { space: 2 });
  } catch (error: any) {
    return `Error: ${error?.message || String(error)}`;
  }
}

async function lspHover(args: Record<string, unknown>): Promise<string> {
  const validated = validateLspHoverArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  const file = normalized.file as string;
  const line = normalized.line as number;
  const character = typeof normalized.character === "number" ? normalized.character : undefined;
  try {
    const result = await getLspManager().hoverWithBackend(file, line, workdir, 2, character);
    return result.value;
  } catch (error: any) {
    return `Error: ${error?.message || String(error)}`;
  }
}

export async function runAutoDiagnostics(args: {
  workdir: string;
  files?: string[];
  minSeverity?: string;
}): Promise<string> {
  const result = await lspDiagnostics({
    workdir: args.workdir,
    files: args.files ?? [],
    min_severity: args.minSeverity ?? "warning",
  });
  try {
    const parsed = JSON.parse(result);
    const summary = parsed.summary as { total?: number; by_severity?: Record<string, number> };
    const total = Number(summary?.total ?? 0);
    if (!total) return `Diagnostics: no issues found. Artifact: ${parsed.artifact_id}`;
    const counts = Object.entries(summary.by_severity ?? {})
      .map(([severity, count]) => `${severity}:${count}`)
      .join(" ");
    const first = Array.isArray(parsed.diagnostics) && parsed.diagnostics.length
      ? ` First: ${formatDiagnostic(parsed.diagnostics[0])}`
      : "";
    return `Diagnostics: ${total} issue(s) ${counts}. Artifact: ${parsed.artifact_id}.${first}`;
  } catch {
    return result.startsWith("Error:") ? result : `Diagnostics completed:\n${safeSliceTextBoundary(result, 1000)}`;
  }
}

export function clearAutomationState(): void {
  automations.clear();
  const legacyDir = safeLegacyAttemptDir();
  if (legacyDir) rmSync(legacyDir, { recursive: true, force: true });
}

function safeLegacyAttemptDir(): string | null {
  try {
    const stat = lstatSync(ATTEMPT_DIR);
    return stat.isDirectory() && !stat.isSymbolicLink() ? ATTEMPT_DIR : null;
  } catch {
    return null;
  }
}

function safeLegacyAttemptFile(id: string): string | null {
  const directory = safeLegacyAttemptDir();
  if (!directory) return null;
  const file = join(directory, `${id}.patch`);
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() ? file : null;
  } catch {
    return null;
  }
}

function normalizeGithubTargetArgs(args: Record<string, unknown>, key: "issue" | "pr" | "target"): Record<string, unknown> {
  const normalized = safeDiagnosticCloneArgs(args);
  const candidates = [
    safeDiagnosticProperty(args, key),
    safeDiagnosticProperty(args, "issue"),
    safeDiagnosticProperty(args, "pr"),
    safeDiagnosticProperty(args, "number"),
    safeDiagnosticProperty(args, "url"),
  ];
  const target = candidates.find(value => typeof value === "string" && value.trim()) as string | undefined;
  if (target) {
    normalized[key] = DIAGNOSTIC_CONTROL_RE.test(target)
      ? ""
      : safeDiagnosticText(target, GITHUB_TARGET_MAX_CHARS);
  }
  return normalized;
}

function normalizeAttemptId(value: unknown): string {
  if (typeof value !== "string") return "";
  if (DIAGNOSTIC_CONTROL_RE.test(value)) return "";
  const trimmed = safeDiagnosticText(value.replace(/\.patch$/, ""), DIAGNOSTIC_ID_MAX_CHARS).trim();
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) && !trimmed.includes("..") ? trimmed : "";
}

function buildDiagnosticsToolList(): Array<{ name: string; category: string; active: boolean }> {
  const registry = getRegistry();
  const activeNames = new Set(
    registry.listActive()
      .map(tool => safeDiagnosticProperty(tool, "name"))
      .filter((name): name is string => typeof name === "string"),
  );
  return registry.listAll().map(tool => {
    const name = safeDiagnosticProperty(tool, "name");
    const category = safeDiagnosticProperty(tool, "category");
    const safeNameValue = typeof name === "string" ? name : "";
    return {
      name: safeNameValue,
      category: typeof category === "string" ? category : "",
      active: activeNames.has(safeNameValue),
    };
  });
}

function validateGithubCommentArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const bodyInput = safeDiagnosticProperty(normalizedArgs, "body");
  if (bodyInput === UNREADABLE_ARG || (bodyInput !== undefined && typeof bodyInput !== "string")) {
    return { ok: false as const, message: "body must be a string." };
  }
  const allowDirty = validateOptionalBoolean(safeDiagnosticProperty(normalizedArgs, "allow_dirty"), "allow_dirty");
  if (allowDirty) return { ok: false as const, message: allowDirty };
  const normalized = normalizeGithubTargetArgs(normalizedArgs, "target");
  const targetValue = safeDiagnosticProperty(normalized, "target");
  const bodyValue = safeDiagnosticProperty(normalized, "body");
  const target = typeof targetValue === "string" ? targetValue.trim() : "";
  const body = typeof bodyValue === "string" ? safeDiagnosticText(bodyValue, PR_ATTEMPT_TEXT_MAX_CHARS).trim() : "";
  if (!target) return { ok: false as const, message: "issue, pr, number, or url is required." };
  if (!body) return { ok: false as const, message: "body is required." };
  return { ok: true as const, args: { ...normalized, target, body } };
}

function validateGithubIssueArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalized = normalizeGithubTargetArgs(workdirValidated.args, "issue");
  const issueValue = safeDiagnosticProperty(normalized, "issue");
  const issue = typeof issueValue === "string" ? issueValue.trim() : "";
  return issue
    ? { ok: true as const, args: { ...normalized, issue } }
    : { ok: false as const, message: "issue, number, or url is required." };
}

function validateGithubPrArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalized = normalizeGithubTargetArgs(workdirValidated.args, "pr");
  const diff = safeDiagnosticProperty(normalized, "diff");
  if (diff === UNREADABLE_ARG || (diff !== undefined && typeof diff !== "boolean")) {
    return { ok: false as const, message: "diff must be a boolean." };
  }
  const prValue = safeDiagnosticProperty(normalized, "pr");
  const pr = typeof prValue === "string" ? prValue.trim() : "";
  return pr
    ? { ok: true as const, args: { ...normalized, pr } }
    : { ok: false as const, message: "pr, number, or url is required." };
}

function validateGithubCloseArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalized = normalizeGithubTargetArgs(workdirValidated.args, "issue");
  const reasonInput = safeDiagnosticProperty(normalized, "reason");
  if (reasonInput === UNREADABLE_ARG || (reasonInput !== undefined && typeof reasonInput !== "string")) {
    return { ok: false as const, message: "reason must be a string." };
  }
  const allowDirty = validateOptionalBoolean(safeDiagnosticProperty(normalized, "allow_dirty"), "allow_dirty");
  if (allowDirty) return { ok: false as const, message: allowDirty };
  const issueValue = safeDiagnosticProperty(normalized, "issue");
  const issue = typeof issueValue === "string" ? issueValue.trim() : "";
  const reason = typeof reasonInput === "string" ? safeDiagnosticText(reasonInput, PR_ATTEMPT_TEXT_MAX_CHARS).trim() : "";
  if (!issue) return { ok: false as const, message: "issue, number, or url is required." };
  if (!reason) return { ok: false as const, message: "reason is required." };
  return { ok: true as const, args: { ...normalized, issue, reason } };
}

function validatePrAttemptGateArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const commandInput = safeDiagnosticProperty(normalizedArgs, "command");
  const gateInput = safeDiagnosticProperty(normalizedArgs, "gate");
  const command = typeof commandInput === "string"
    ? commandInput.trim()
    : typeof gateInput === "string"
      ? gateInput.trim()
      : "";
  if ((commandInput !== undefined && typeof commandInput !== "string")
    || (gateInput !== undefined && typeof gateInput !== "string")) {
    return { ok: false as const, message: "command must be a string." };
  }
  const commandError = validateDiagnosticBoundedText(command, "command", PR_ATTEMPT_COMMAND_MAX_CHARS);
  if (commandError) return { ok: false as const, message: commandError };
  return command
    ? { ok: true as const, args: { ...normalizedArgs, command } }
    : { ok: false as const, message: "command is required." };
}

function validatePrAttemptBranchArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const branchInput = safeDiagnosticProperty(normalizedArgs, "branch");
  const baseInput = safeDiagnosticProperty(normalizedArgs, "base");
  if (branchInput !== undefined) {
    if (typeof branchInput !== "string") return { ok: false as const, message: "branch must be a string." };
    const branch = safeDiagnosticText(branchInput, PR_ATTEMPT_REF_MAX_CHARS).trim();
    if (!branch) return { ok: false as const, message: "branch must be a non-empty string." };
    if (baseInput === undefined) return { ok: true as const, args: { ...normalizedArgs, branch } };
  }
  if (baseInput !== undefined) {
    if (typeof baseInput !== "string") return { ok: false as const, message: "base must be a string." };
    const base = safeDiagnosticText(baseInput, PR_ATTEMPT_REF_MAX_CHARS).trim();
    if (!base) return { ok: false as const, message: "base must be a non-empty string." };
    return branchInput === undefined
      ? { ok: true as const, args: { ...normalizedArgs, base } }
      : { ok: true as const, args: { ...normalizedArgs, branch: safeDiagnosticText(branchInput, PR_ATTEMPT_REF_MAX_CHARS).trim(), base } };
  }
  return { ok: true as const, args: normalizedArgs };
}

function validatePrAttemptPushDraftArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const normalized = safeDiagnosticCloneArgs(normalizedArgs);
  for (const key of ["title", "body", "branch"] as const) {
    const value = normalized[key];
    if (value !== undefined && typeof value !== "string") {
      return { ok: false as const, message: `${key} must be a string.` };
    }
    if (typeof value === "string") {
      const error = validateDiagnosticBoundedText(value, key, key === "branch" ? PR_ATTEMPT_REF_MAX_CHARS : PR_ATTEMPT_TEXT_MAX_CHARS);
      if (error) return { ok: false as const, message: error };
      const text = safeDiagnosticText(value, key === "branch" ? PR_ATTEMPT_REF_MAX_CHARS : PR_ATTEMPT_TEXT_MAX_CHARS).trim();
      if (!text) return { ok: false as const, message: `${key} must be a non-empty string.` };
      normalized[key] = text;
    }
  }
  const allowDirty = validateOptionalBoolean(safeDiagnosticProperty(normalized, "allow_dirty"), "allow_dirty");
  if (allowDirty) return { ok: false as const, message: allowDirty };
  return { ok: true as const, args: normalized };
}

function validatePrAttemptRollbackArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const normalized = safeDiagnosticCloneArgs(normalizedArgs);
  for (const key of ["branch", "target"] as const) {
    const value = normalized[key];
    if (value !== undefined && typeof value !== "string") {
      return { ok: false as const, message: `${key} must be a string.` };
    }
    if (typeof value === "string") {
      const error = validateDiagnosticBoundedText(value, key, PR_ATTEMPT_REF_MAX_CHARS);
      if (error) return { ok: false as const, message: error };
      const text = safeDiagnosticText(value, PR_ATTEMPT_REF_MAX_CHARS).trim();
      if (!text) return { ok: false as const, message: `${key} must be a non-empty string.` };
      normalized[key] = text;
    }
  }
  return { ok: true as const, args: normalized };
}

function validateIdArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs: Record<string, unknown> = workdirValidated.args;
  const id = normalizeAttemptId(safeDiagnosticProperty(normalizedArgs, "id"));
  return id
    ? { ok: true as const, args: { ...normalizedArgs, id } }
    : { ok: false as const, message: "id is required." };
}

function validateOptionalBoolean(value: unknown, key: string): string | null {
  if (value === undefined) return null;
  return typeof value === "boolean" ? null : `${key} must be a boolean.`;
}

function validatePromptArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const promptInput = safeDiagnosticProperty(normalizedArgs, "prompt");
  if (typeof promptInput !== "string") return { ok: false as const, message: "prompt is required." };
  const promptError = validateDiagnosticBoundedText(promptInput, "prompt", AUTOMATION_PROMPT_MAX_CHARS);
  if (promptError) return { ok: false as const, message: promptError };
  const prompt = safeDiagnosticText(promptInput, AUTOMATION_PROMPT_MAX_CHARS).trim();
  if (!prompt) return { ok: false as const, message: "prompt is required." };
  const normalized: Record<string, unknown> = { ...normalizedArgs, prompt };
  const scheduleInput = safeDiagnosticProperty(normalizedArgs, "schedule");
  if (scheduleInput !== undefined) {
    if (typeof scheduleInput !== "string") {
      return { ok: false as const, message: "schedule must be a string." };
    }
    const scheduleError = validateDiagnosticBoundedText(scheduleInput, "schedule", AUTOMATION_SCHEDULE_MAX_CHARS);
    if (scheduleError) return { ok: false as const, message: scheduleError };
    const schedule = safeDiagnosticText(scheduleInput, AUTOMATION_SCHEDULE_MAX_CHARS).trim();
    if (!schedule) return { ok: false as const, message: "schedule must be a non-empty string." };
    normalized.schedule = schedule;
  }
  return { ok: true as const, args: normalized };
}

function validateAutomationUpdateArgs(args: Record<string, unknown>) {
  const validated = validateIdArgs(args);
  if (!validated.ok) return validated;
  const normalizedArgs: Record<string, unknown> = validated.args;
  const normalized: Record<string, unknown> = safeDiagnosticCloneArgs(normalizedArgs);
  const promptInput = safeDiagnosticProperty(normalizedArgs, "prompt");
  if (promptInput !== undefined) {
    if (typeof promptInput !== "string") return { ok: false as const, message: "prompt is required." };
    const promptError = validateDiagnosticBoundedText(promptInput, "prompt", AUTOMATION_PROMPT_MAX_CHARS);
    if (promptError) return { ok: false as const, message: promptError };
    const prompt = safeDiagnosticText(promptInput, AUTOMATION_PROMPT_MAX_CHARS).trim();
    if (!prompt) return { ok: false as const, message: "prompt is required." };
    normalized.prompt = prompt;
  }
  const scheduleInput = safeDiagnosticProperty(normalizedArgs, "schedule");
  if (scheduleInput !== undefined) {
    if (typeof scheduleInput !== "string") {
      return { ok: false as const, message: "schedule must be a string." };
    }
    const scheduleError = validateDiagnosticBoundedText(scheduleInput, "schedule", AUTOMATION_SCHEDULE_MAX_CHARS);
    if (scheduleError) return { ok: false as const, message: scheduleError };
    const schedule = safeDiagnosticText(scheduleInput, AUTOMATION_SCHEDULE_MAX_CHARS).trim();
    if (!schedule) return { ok: false as const, message: "schedule must be a non-empty string." };
    normalized.schedule = schedule;
  }
  return { ok: true as const, args: normalized };
}

function isStringListInput(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!Array.isArray(value)) return false;
  const items = readDiagnosticArrayItems(value, DIAGNOSTIC_MAX_FILE_FILTERS);
  return items.ok && items.length <= DIAGNOSTIC_MAX_FILE_FILTERS && items.values.every(item => typeof item === "string");
}

const LSP_SEVERITIES = new Set(["error", "warning", "information", "info", "hint", "all"]);

function validateLspSeverity(value: unknown): string | null {
  if (typeof value !== "string") return "min_severity must be a string.";
  if (!LSP_SEVERITIES.has(value.trim().toLowerCase())) return "min_severity must be one of error, warning, information, hint, or all.";
  return null;
}

function strictInteger(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[-+]?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isStrictIntegerAtLeast(value: unknown, min: number): boolean {
  const parsed = strictInteger(value);
  return parsed !== undefined && parsed >= min;
}

function normalizeOptionalCharacter(value: unknown): number | undefined {
  const parsed = strictInteger(value);
  return parsed !== undefined ? parsed : undefined;
}

function validateLspDiagnosticsArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const languageInput = safeDiagnosticProperty(normalizedArgs, "language");
  const minSeverityInput = safeDiagnosticProperty(normalizedArgs, "min_severity");
  const severityInput = safeDiagnosticProperty(normalizedArgs, "severity");
  const filesInput = safeDiagnosticProperty(normalizedArgs, "files");
  if (languageInput !== undefined && typeof languageInput !== "string") {
    return { ok: false as const, message: "language must be a string." };
  }
  if (typeof languageInput === "string") {
    const language = languageInput.trim().toLowerCase();
    if (!["typescript", "python", "go", "rust"].includes(language)) {
      return { ok: false as const, message: "language must be one of typescript, python, go, or rust." };
    }
    normalizedArgs.language = language;
  }
  if (minSeverityInput !== undefined) {
    const severityError = validateLspSeverity(minSeverityInput);
    if (severityError) return { ok: false as const, message: severityError };
    normalizedArgs.min_severity = typeof minSeverityInput === "string" ? minSeverityInput.trim().toLowerCase() : "all";
  }
  if (severityInput !== undefined) {
    const severityError = validateLspSeverity(severityInput);
    if (severityError) return { ok: false as const, message: severityError };
    normalizedArgs.severity = typeof severityInput === "string" ? severityInput.trim().toLowerCase() : "all";
  }
  if (filesInput !== undefined && !isStringListInput(filesInput)) {
    return { ok: false as const, message: "files must be a string or array of strings." };
  }
  return { ok: true as const, args: normalizedArgs };
}

function validateLspFileArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const fileInput = safeDiagnosticProperty(normalizedArgs, "file");
  const pathInput = safeDiagnosticProperty(normalizedArgs, "path");
  if (fileInput !== undefined && typeof fileInput !== "string") return { ok: false as const, message: "file must be a string." };
  if (pathInput !== undefined && typeof pathInput !== "string") return { ok: false as const, message: "path must be a string." };
  const file = typeof fileInput === "string" && fileInput.trim()
    ? fileInput.trim()
    : typeof pathInput === "string" && pathInput.trim() ? pathInput.trim() : "";
  if (!file) return { ok: false as const, message: "file is required." };
  return { ok: true as const, args: { ...normalizedArgs, file } };
}

function validateLspDefinitionArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const symbolInput = safeDiagnosticProperty(normalizedArgs, "symbol");
  const fileInput = safeDiagnosticProperty(normalizedArgs, "file");
  const pathInput = safeDiagnosticProperty(normalizedArgs, "path");
  const lineInput = safeDiagnosticProperty(normalizedArgs, "line");
  const characterInput = safeDiagnosticProperty(normalizedArgs, "character");
  const symbol = typeof symbolInput === "string" ? symbolInput.trim() : "";
  if (fileInput !== undefined && typeof fileInput !== "string") return { ok: false as const, message: "file must be a string." };
  if (pathInput !== undefined && typeof pathInput !== "string") return { ok: false as const, message: "path must be a string." };
  if (lineInput !== undefined && !isStrictIntegerAtLeast(lineInput, 1)) {
    return { ok: false as const, message: "line must be a positive number." };
  }
  if (characterInput !== undefined && !isStrictIntegerAtLeast(characterInput, 0)) {
    return { ok: false as const, message: "character must be a non-negative number." };
  }
  return symbol
    ? {
      ok: true as const,
      args: {
        ...normalizedArgs,
        symbol,
        ...(lineInput !== undefined ? { line: strictInteger(lineInput) } : {}),
        ...(characterInput !== undefined ? { character: normalizeOptionalCharacter(characterInput) } : {}),
      },
    }
    : { ok: false as const, message: "symbol is required." };
}

function validateLspHoverArgs(args: Record<string, unknown>) {
  const fileValidated = validateLspFileArgs(args);
  if (!fileValidated.ok) return fileValidated;
  const normalizedArgs = fileValidated.args;
  const lineInput = safeDiagnosticProperty(normalizedArgs, "line");
  const characterInput = safeDiagnosticProperty(normalizedArgs, "character");
  if (lineInput === undefined || !isStrictIntegerAtLeast(lineInput, 1)) {
    return { ok: false as const, message: "line must be a positive number." };
  }
  if (characterInput !== undefined && !isStrictIntegerAtLeast(characterInput, 0)) {
    return { ok: false as const, message: "character must be a non-negative number." };
  }
  return {
    ok: true as const,
    args: {
      ...fileValidated.args,
      line: strictInteger(lineInput),
      ...(characterInput !== undefined ? { character: normalizeOptionalCharacter(characterInput) } : {}),
    },
  };
}

export function registerDiagnosticsTools(): void {
  const registry = getRegistry();
  const add = (
    name: string,
    description: string,
    execute: (args: Record<string, unknown>) => Promise<string>,
    permission = PermissionLevel.ALWAYS_ALLOW,
    deferLoading = true,
    parameters: Record<string, unknown> = { type: "object", properties: {} },
    extra: DiagnosticsToolExtras = {},
  ) => registry.register({
    name,
    description,
    parameters,
    execute,
    permission,
    category: name.startsWith("github") ? "github" : name.startsWith("automation") ? "automation" : "diagnostics",
    parallelOk: true,
    deferLoading,
    ...extra,
  });

  registry.register({
    name: "diagnostics",
    description: "Collect workspace, git, runtime, and tool diagnostics.",
    parameters: { type: "object", properties: { workdir: { type: "string", default: "." } } },
    execute: diagnostics,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "diagnostics",
    parallelOk: true,
    validateInput: validateDiagnosticsWorkdirArgs,
  });
  add("github_issue_context", "Read GitHub issue context via gh.", githubIssueContext, PermissionLevel.ALWAYS_ALLOW, true, {
    type: "object",
    properties: {
      issue: { type: "string" },
      number: { type: "string" },
      url: { type: "string" },
      workdir: { type: "string", default: "." },
    },
  }, { validateInput: validateGithubIssueArgs });
  add("github_pr_context", "Read GitHub PR context via gh.", githubPrContext, PermissionLevel.ALWAYS_ALLOW, true, {
    type: "object",
    properties: {
      pr: { type: "string" },
      number: { type: "string" },
      url: { type: "string" },
      diff: { type: "boolean", default: false },
      workdir: { type: "string", default: "." },
    },
  }, { validateInput: validateGithubPrArgs });
  add(
    "github_comment",
    "Comment on a GitHub issue or PR via gh.",
    githubComment,
    PermissionLevel.ASK,
    true,
    {
      type: "object",
      properties: {
        target: { type: "string" },
        issue: { type: "string" },
        pr: { type: "string" },
        number: { type: "string" },
        url: { type: "string" },
        body: { type: "string" },
        workdir: { type: "string", default: "." },
        allow_dirty: { type: "boolean", default: false },
      },
    },
    { validateInput: validateGithubCommentArgs },
  );
  add("github_close_issue", "Close a GitHub issue via gh with a required reason.", githubCloseIssue, PermissionLevel.ASK, true, {
    type: "object",
    properties: {
      issue: { type: "string" },
      number: { type: "string" },
      url: { type: "string" },
      reason: { type: "string" },
      workdir: { type: "string", default: "." },
      allow_dirty: { type: "boolean", default: false },
    },
  }, { validateInput: validateGithubCloseArgs });
  add("pr_attempt_record", "Record current git diff as a PR attempt patch.", prAttemptRecord, PermissionLevel.ALWAYS_ALLOW, true, {
    type: "object",
    properties: {
      workdir: { type: "string", default: "." },
    },
  }, { validateInput: validateDiagnosticsWorkdirArgs });
  add("pr_attempt_list", "List recorded PR attempt patches.", prAttemptList);
  add("pr_attempt_read", "Read a PR attempt patch.", prAttemptRead, PermissionLevel.ALWAYS_ALLOW, true, {
    type: "object",
    properties: { id: { type: "string" } },
  }, { validateInput: validateIdArgs });
  add("pr_attempt_preflight", "Run git apply --check for a PR attempt patch.", prAttemptPreflight, PermissionLevel.ALWAYS_ALLOW, true, {
    type: "object",
    properties: {
      id: { type: "string" },
      workdir: { type: "string", default: "." },
    },
  }, { validateInput: validateIdArgs });
  add("pr_attempt_branch", "Create a branch for a PR attempt.", prAttemptBranch, PermissionLevel.ASK, true, {
    type: "object",
    properties: {
      branch: { type: "string" },
      base: { type: "string" },
      workdir: { type: "string", default: "." },
    },
  }, { validateInput: validatePrAttemptBranchArgs });
  add(
    "pr_attempt_gate",
    "Run a PR attempt verification gate and archive evidence.",
    prAttemptGate,
    PermissionLevel.ASK,
    true,
    {
      type: "object",
      properties: {
        command: { type: "string" },
        gate: { type: "string", description: "Alias for command." },
        workdir: { type: "string", default: "." },
      },
    },
    { validateInput: validatePrAttemptGateArgs },
  );
  add("pr_attempt_push_draft", "Push current branch and create a draft GitHub PR.", prAttemptPushDraft, PermissionLevel.ASK, true, {
    type: "object",
    properties: {
      branch: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      workdir: { type: "string", default: "." },
      allow_dirty: { type: "boolean", default: false },
    },
  }, { validateInput: validatePrAttemptPushDraftArgs });
  add("pr_attempt_review_sync", "Sync GitHub PR review comments into an artifact.", prAttemptReviewSync, PermissionLevel.ALWAYS_ALLOW, true, {
    type: "object",
    properties: {
      pr: { type: "string" },
      number: { type: "string" },
      url: { type: "string" },
      workdir: { type: "string", default: "." },
    },
  }, { validateInput: validateGithubPrArgs });
  add("pr_attempt_rollback", "Rollback a PR attempt branch or current branch to a target revision.", prAttemptRollback, PermissionLevel.ASK, true, {
    type: "object",
    properties: {
      branch: { type: "string" },
      target: { type: "string", default: "HEAD" },
      workdir: { type: "string", default: "." },
    },
  }, { validateInput: validatePrAttemptRollbackArgs });
  add("automation_create", "Create an automation record.", automationCreate, PermissionLevel.ASK, true, {
    type: "object",
    properties: {
      prompt: { type: "string" },
      schedule: { type: "string" },
    },
  }, { validateInput: validatePromptArgs });
  add("automation_list", "List automation records.", automationList);
  add("automation_read", "Read an automation record.", automationRead, PermissionLevel.ALWAYS_ALLOW, true, {
    type: "object",
    properties: { id: { type: "string" } },
  }, { validateInput: validateIdArgs });
  add("automation_update", "Update an automation record.", automationUpdate, PermissionLevel.ASK, true, {
    type: "object",
    properties: {
      id: { type: "string" },
      prompt: { type: "string" },
      schedule: { type: "string" },
    },
  }, { validateInput: validateAutomationUpdateArgs });
  add("automation_pause", "Pause an automation.", args => automationStatus(args, true), PermissionLevel.ASK, true, {
    type: "object",
    properties: { id: { type: "string" } },
  }, { validateInput: validateIdArgs });
  add("automation_resume", "Resume an automation.", args => automationStatus(args, false), PermissionLevel.ASK, true, {
    type: "object",
    properties: { id: { type: "string" } },
  }, { validateInput: validateIdArgs });
  add("automation_delete", "Delete an automation.", automationDelete, PermissionLevel.ASK, true, {
    type: "object",
    properties: { id: { type: "string" } },
  }, { validateInput: validateIdArgs });
  add("automation_run", "Run an automation by creating a durable task.", automationRun, PermissionLevel.ASK, true, {
    type: "object",
    properties: { id: { type: "string" } },
  }, { validateInput: validateIdArgs });
  registry.register({
    name: "mcp_manager",
    description: "Manage MCP servers: list, add, enable, disable, remove, reload. Writes user config for persistent changes.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "enable", "disable", "remove", "reload", "health", "reconnect"], default: "list" },
        name: { type: "string" },
        transport: { type: "string", enum: ["stdio", "sse"], default: "stdio" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        url: { type: "string" },
        env: { type: "object" },
        enabled: { type: "boolean", default: true },
      },
    },
    execute: mcpManager,
    permission: PermissionLevel.ASK,
    category: "mcp",
    parallelOk: false,
    validateInput: validateMCPManagerArgs,
  });
  registry.register({
    name: "lsp_diagnostics",
    description: "Run language diagnostics using available project tools or language servers for TypeScript, Python, Go, or Rust.",
    parameters: {
      type: "object",
      properties: {
        workdir: { type: "string", default: "." },
        language: { type: "string", enum: ["typescript", "python", "go", "rust"] },
        files: { type: "array", items: { type: "string" }, description: "Optional file paths to keep in the returned diagnostics." },
        min_severity: { type: "string", enum: ["error", "warning", "information", "hint", "all"], default: "all" },
      },
    },
    execute: lspDiagnostics,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "diagnostics",
    parallelOk: true,
    validateInput: validateLspDiagnosticsArgs,
  });
  registry.register({
    name: "lsp_symbols",
    description: "List document symbols for a source file using the LSP facade with local fallback parsing.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string" },
        path: { type: "string", description: "Alias for file." },
        workdir: { type: "string", default: "." },
      },
      required: ["file"],
    },
    execute: lspSymbols,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "diagnostics",
    parallelOk: true,
    deferLoading: true,
    readOnly: true,
    validateInput: validateLspFileArgs,
  });
  registry.register({
    name: "lsp_definition",
    description: "Find definitions using a JSON-RPC language server when file position is provided, with ripgrep/grep fallback.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        file: { type: "string", description: "Optional source file for precise LSP definition lookup." },
        path: { type: "string", description: "Alias for file." },
        line: { type: "integer", description: "Optional 1-based source line for precise LSP definition lookup." },
        character: { type: "integer", description: "Optional 1-based source character; defaults to first non-whitespace character on the line." },
        workdir: { type: "string", default: "." },
      },
      required: ["symbol"],
    },
    execute: lspDefinition,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "diagnostics",
    parallelOk: true,
    deferLoading: true,
    readOnly: true,
    validateInput: validateLspDefinitionArgs,
  });
  registry.register({
    name: "lsp_hover",
    description: "Return hover information using a JSON-RPC language server with local source-context fallback.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string" },
        path: { type: "string", description: "Alias for file." },
        line: { type: "integer" },
        character: { type: "integer", description: "Optional 1-based source character; defaults to first non-whitespace character on the line." },
        workdir: { type: "string", default: "." },
      },
      required: ["file", "line"],
    },
    execute: lspHover,
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "diagnostics",
    parallelOk: true,
    deferLoading: true,
    readOnly: true,
    validateInput: validateLspHoverArgs,
  });
}

function githubMutationGuard(args: Record<string, unknown>, options: { requireClean: boolean }): string | null {
  const workdir = resolveWorkdir(args);
  const status = runRaw("git status --porcelain=v1 2>&1", workdir);
  if (/fatal: not a git repository/i.test(status)) return "Error: GitHub mutations require a git repository workdir.";
  if (options.requireClean && status.trim()) {
    const artifact = createArtifact({ kind: "github_guard", name: "dirty-worktree.txt", content: status, metadata: { workdir: resolve(workdir) } });
    return `Error: dirty worktree guard blocked GitHub mutation. Commit/stash changes or pass allow_dirty=true. Evidence artifact: ${artifact.id}`;
  }
  if (!commandExists("gh")) return "Error: GitHub CLI 'gh' is required.";
  return null;
}

function ensureGitRepo(workdir: string): string | null {
  const status = run("git rev-parse --is-inside-work-tree 2>&1", workdir);
  return status.trim() === "true" ? null : "Error: operation requires a git repository workdir.";
}

function verifyGithubTarget(target: string, workdir: string): string {
  const result = runWithStatus(`gh issue view ${shellQuote(target)} --json number,title,state,url 2>&1`, workdir);
  if (result.status !== 0) return `Error: GitHub target verification failed: ${result.output}`;
  try {
    const evidence = JSON.parse(result.output) as { number?: unknown; url?: unknown };
    if (!evidence || evidence.number === undefined || !evidence.url) {
      return `Error: GitHub target verification returned incomplete evidence: ${result.output}`;
    }
  } catch {
    return `Error: GitHub target verification returned invalid JSON: ${result.output}`;
  }
  return result.output;
}

function parseMCPServer(args: Record<string, unknown>): MCPConfig {
  const name = normalizeMCPName(safeDiagnosticProperty(args, "name"));
  if (!name) throw new Error("name is required.");
  const env = parseMCPEnv(safeDiagnosticProperty(args, "env"));
  const transportInput = safeDiagnosticProperty(args, "transport");
  const urlInput = safeDiagnosticProperty(args, "url");
  const enabledInput = safeDiagnosticProperty(args, "enabled");
  const rawTransport = typeof transportInput === "string" ? transportInput.trim().toLowerCase() : undefined;
  if (transportInput !== undefined) {
    if (typeof transportInput !== "string") throw new Error("transport must be a string.");
    if (rawTransport !== "stdio" && rawTransport !== "sse") throw new Error("transport must be stdio or sse.");
  }
  const transport = normalizeMCPTransport(transportInput, urlInput);
  if (enabledInput !== undefined && typeof enabledInput !== "boolean") {
    throw new Error("enabled must be a boolean.");
  }
  const command = normalizeMCPCommand(safeDiagnosticProperty(args, "command"));
  const url = normalizeMCPUrl(urlInput);
  const server: MCPConfig = {
    name,
    transport,
    command: command || undefined,
    args: parseMCPArgs(safeDiagnosticProperty(args, "args")),
    url: url || undefined,
    env,
    enabled: enabledInput !== false,
  };
  if (server.transport === "stdio" && !server.command) throw new Error("command is required for stdio MCP servers.");
  if (server.transport === "sse" && !server.url) throw new Error("url is required for SSE MCP servers.");
  return server;
}

function parseMCPEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("env must be an object with string values.");
  }
  const env: Record<string, string> = {};
  const entries = safeDiagnosticObjectEntries(value, MCP_MANAGER_ENV_MAX_ENTRIES + 1);
  for (const [key, entry] of entries) {
    if (typeof entry !== "string") throw new Error("env must be an object with string values.");
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || key.length > MCP_MANAGER_ENV_KEY_MAX_CHARS
      || entry.length > MCP_MANAGER_ENV_VALUE_MAX_CHARS
      || MCP_MANAGER_CONTROL_RE.test(entry)
    ) {
      throw new Error("env contains invalid keys or values.");
    }
    env[key] = entry;
    if (Object.keys(env).length > MCP_MANAGER_ENV_MAX_ENTRIES) throw new Error(`env must contain ${MCP_MANAGER_ENV_MAX_ENTRIES} entries or fewer.`);
  }
  return env;
}

function parseMCPArgs(value: unknown): string[] {
  let raw: unknown[] = [];
  if (Array.isArray(value)) {
    const items = readDiagnosticArrayItems(value, MCP_MANAGER_ARGS_MAX + 1);
    if (!items.ok) throw new Error("args must contain only strings.");
    raw = items.values;
  } else if (typeof value === "string") {
    raw = value.split(/\s+/);
  }
  if (value !== undefined && value !== null && !Array.isArray(value) && typeof value !== "string") {
    throw new Error("args must be a string or array of strings.");
  }
  const args: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new Error("args must contain only strings.");
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > MCP_MANAGER_ARG_MAX_CHARS || MCP_MANAGER_CONTROL_RE.test(trimmed)) throw new Error("args contain invalid values.");
    args.push(trimmed);
    if (args.length > MCP_MANAGER_ARGS_MAX) throw new Error(`args must contain ${MCP_MANAGER_ARGS_MAX} entries or fewer.`);
  }
  return args;
}

function normalizeMCPName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MCP_MANAGER_NAME_MAX_CHARS && MCP_MANAGER_NAME_RE.test(trimmed) && !MCP_MANAGER_CONTROL_RE.test(trimmed) ? trimmed : "";
}

function normalizeMCPCommand(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("command must be a string.");
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > MCP_MANAGER_COMMAND_MAX_CHARS || MCP_MANAGER_CONTROL_RE.test(trimmed)) throw new Error("command contains invalid characters.");
  return trimmed;
}

function normalizeMCPUrl(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("url must be a string.");
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > MCP_MANAGER_URL_MAX_CHARS || MCP_MANAGER_CONTROL_RE.test(trimmed)) throw new Error("url contains invalid characters.");
  return trimmed;
}

function normalizeMCPAction(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "list";
}

function normalizeMCPTransport(value: unknown, url: unknown): MCPConfig["transport"] {
  if (value !== undefined && typeof value !== "string") throw new Error("transport must be a string.");
  const transport = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : (typeof url === "string" && url.trim() ? "sse" : "stdio");
  if (transport === "stdio" || transport === "sse") return transport;
  return "stdio";
}

function validateMCPManagerArgs(args: Record<string, unknown>) {
  const action = normalizeMCPAction(safeDiagnosticProperty(args, "action"));
  if (action === "list" || action === "reload") return { ok: true as const, args: { ...safeDiagnosticCloneArgs(args), action } };
  if (action === "health") {
    const nameInput = safeDiagnosticProperty(args, "name");
    if (nameInput === undefined) return { ok: true as const, args: { ...safeDiagnosticCloneArgs(args), action } };
    const name = normalizeMCPName(nameInput);
    return name
      ? { ok: true as const, args: { ...safeDiagnosticCloneArgs(args), action, name } }
      : { ok: false as const, message: "name is required." };
  }
  if (["enable", "disable", "remove", "delete", "reconnect"].includes(action)) {
    const name = normalizeMCPName(safeDiagnosticProperty(args, "name"));
    return name
      ? { ok: true as const, args: { ...safeDiagnosticCloneArgs(args), action, name } }
      : { ok: false as const, message: "name is required." };
  }
  if (action === "add") {
    try {
      const server = parseMCPServer(args);
      return { ok: true as const, args: { ...safeDiagnosticCloneArgs(args), action, ...server } };
    } catch (error: any) {
      return { ok: false as const, message: error.message || "invalid MCP server configuration" };
    }
  }
  return { ok: false as const, message: "unsupported MCP action" };
}

function diagnosticCommand(language: string, workdir: string): string | null {
  if (language === "typescript") {
    if (existsSync(join(workdir, "package.json"))) {
      const localTsc = join(workdir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
      if (existsSync(localTsc)) return `${shellQuote(localTsc)} --noEmit --pretty false 2>&1`;
      if (commandExists("tsc")) return "tsc --noEmit --pretty false 2>&1";
      const bundledTsc = resolve("node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
      if (existsSync(bundledTsc)) return `${shellQuote(bundledTsc)} --noEmit --pretty false 2>&1`;
      return "npx --no-install tsc --noEmit --pretty false 2>&1";
    }
    return "tsserver --help >/dev/null 2>&1 && echo 'tsserver available; project has no package.json for batch diagnostics' || echo 'tsserver not found'";
  }
  if (language === "python") {
    if (commandExists("pyright")) return "pyright --outputjson 2>&1";
    return "python -m py_compile $(find . -name '*.py' -not -path './.venv/*' -not -path './venv/*') 2>&1";
  }
  if (language === "go") return "gopls check ./... 2>&1 || go test ./... 2>&1";
  if (language === "rust") return "cargo check --message-format short 2>&1 || rust-analyzer diagnostics . 2>&1";
  return null;
}

function detectLanguage(workdir: string): string {
  if (existsSync(join(workdir, "package.json")) || existsSync(join(workdir, "tsconfig.json"))) return "typescript";
  if (existsSync(join(workdir, "pyproject.toml")) || existsSync(join(workdir, "requirements.txt"))) return "python";
  if (existsSync(join(workdir, "go.mod"))) return "go";
  if (existsSync(join(workdir, "Cargo.toml"))) return "rust";
  return "typescript";
}

interface ParsedDiagnostic {
  file: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "information" | "hint";
  code?: string;
  message: string;
}

function normalizeFiles(value: unknown): string[] {
  if (Array.isArray(value)) {
    const items = readDiagnosticArrayItems(value, DIAGNOSTIC_MAX_FILE_FILTERS);
    return items.ok && items.length <= DIAGNOSTIC_MAX_FILE_FILTERS
      ? items.values.map(item => safeDiagnosticPath(item)).filter(Boolean).slice(0, DIAGNOSTIC_MAX_FILE_FILTERS)
      : [];
  }
  if (typeof value === "string" && value.trim()) return value.split(",").map(item => safeDiagnosticPath(item)).filter(Boolean).slice(0, DIAGNOSTIC_MAX_FILE_FILTERS);
  return [];
}

function parseDiagnostics(output: string, language: string): ParsedDiagnostic[] {
  const safeOutput = safeDiagnosticOutput(output);
  if (language === "python") {
    try {
      const parsed = JSON.parse(safeOutput) as { generalDiagnostics?: Array<any> };
      return parsePythonDiagnostics(parsed.generalDiagnostics);
    } catch {
      // fall through to regex parser
    }
  }

  const diagnostics: ParsedDiagnostic[] = [];
  const tsPattern = /(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:]+):\s+(.+)/i;
  const colonPattern = /(.+?):(\d+):(\d+):\s+(error|warning|info|information|hint)(?:\[[^\]]+\])?:\s+(.+)/i;
  for (const line of safeOutput.split("\n").slice(0, DIAGNOSTIC_MAX_PARSE_LINES)) {
    const ts = line.match(tsPattern);
    if (ts) {
      const [file, lineNumber, column, severity, code, message] = ts.slice(1);
      if (!file || !lineNumber || !column || !severity || !code || !message) continue;
      const diagnostic = normalizeDiagnostic({
        file: safeDiagnosticPath(file),
        line: Number(lineNumber),
        column: Number(column),
        severity: normalizeSeverity(severity),
        code: safeDiagnosticText(code, DIAGNOSTIC_CODE_MAX_CHARS),
        message: safeDiagnosticText(message, DIAGNOSTIC_MESSAGE_MAX_CHARS),
      });
      if (diagnostic) diagnostics.push(diagnostic);
      if (diagnostics.length >= DIAGNOSTIC_MAX_ITEMS) break;
      continue;
    }
    const colon = line.match(colonPattern);
    if (colon) {
      const [file, lineNumber, column, severity, message] = colon.slice(1);
      if (!file || !lineNumber || !column || !severity || !message) continue;
      const diagnostic = normalizeDiagnostic({
        file: safeDiagnosticPath(file),
        line: Number(lineNumber),
        column: Number(column),
        severity: normalizeSeverity(severity),
        message: safeDiagnosticText(message, DIAGNOSTIC_MESSAGE_MAX_CHARS),
      });
      if (diagnostic) diagnostics.push(diagnostic);
      if (diagnostics.length >= DIAGNOSTIC_MAX_ITEMS) break;
    }
  }
  return diagnostics;
}

function parsePythonDiagnostics(value: unknown): ParsedDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const items = readDiagnosticArrayItems(value, DIAGNOSTIC_MAX_ITEMS);
  if (!items.ok) return [];
  const diagnostics: ParsedDiagnostic[] = [];
  for (const item of items.values) {
    const diagnostic = parsePythonDiagnostic(item);
    if (diagnostic) diagnostics.push(diagnostic);
    if (diagnostics.length >= DIAGNOSTIC_MAX_ITEMS) break;
  }
  return diagnostics;
}

function parsePythonDiagnostic(value: unknown): ParsedDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const file = safeDiagnosticPath(safeDiagnosticProperty(record, "file"));
  const message = safeDiagnosticText(safeDiagnosticProperty(record, "message"), DIAGNOSTIC_MESSAGE_MAX_CHARS);
  const code = optionalDiagnosticString(safeDiagnosticProperty(record, "rule"));
  if (!file || !message || code === undefined) return null;

  const range = safeDiagnosticProperty(record, "range");
  const start = range && typeof range === "object" && !Array.isArray(range)
    ? safeDiagnosticProperty(range as Record<string, unknown>, "start")
    : undefined;
  const lineValue = start && typeof start === "object" && !Array.isArray(start)
    ? safeDiagnosticProperty(start as Record<string, unknown>, "line")
    : undefined;
  const characterValue = start && typeof start === "object" && !Array.isArray(start)
    ? safeDiagnosticProperty(start as Record<string, unknown>, "character")
    : undefined;
  const line = typeof lineValue === "number"
    ? lineValue + 1
    : undefined;
  const column = typeof characterValue === "number"
    ? characterValue + 1
    : undefined;

  return {
    file,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    severity: normalizeSeverity(safeDiagnosticProperty(record, "severity")),
    message,
    ...(code !== null ? { code: safeDiagnosticText(code, DIAGNOSTIC_CODE_MAX_CHARS) } : {}),
  };
}

function optionalDiagnosticString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function filterDiagnostics(
  diagnostics: ParsedDiagnostic[],
  options: { files: string[]; minSeverity: string; workdir: string },
): ParsedDiagnostic[] {
  const minRank = options.minSeverity === "all" ? Infinity : severityRank(normalizeSeverity(options.minSeverity));
  const root = resolve(options.workdir);
  const filters = options.files.map(file => resolve(root, file));
  return diagnostics.filter(diagnostic => {
    const severity = normalizeSeverity(safeDiagnosticProperty(diagnostic, "severity"));
    if (severityRank(severity) > minRank) return false;
    if (!filters.length) return true;
    const diagnosticFile = safeDiagnosticPath(safeDiagnosticProperty(diagnostic, "file"));
    const diagPath = resolve(root, diagnosticFile);
    return filters.some(file => diagPath === file || diagnosticFile.endsWith(file) || diagPath.endsWith(file));
  }).slice(0, DIAGNOSTIC_MAX_ITEMS);
}

function summarizeDiagnostics(diagnostics: ParsedDiagnostic[]): { total: number; by_severity: Record<string, number> } {
  const bySeverity: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const severity = normalizeSeverity(safeDiagnosticProperty(diagnostic, "severity"));
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
  }
  return { total: diagnostics.length, by_severity: bySeverity };
}

function normalizeDiagnostic(value: ParsedDiagnostic): ParsedDiagnostic | null {
  const file = safeDiagnosticPath(safeDiagnosticProperty(value, "file"));
  const message = safeDiagnosticText(safeDiagnosticProperty(value, "message"), DIAGNOSTIC_MESSAGE_MAX_CHARS);
  if (!file || !message) return null;
  const diagnostic: ParsedDiagnostic = {
    file,
    severity: normalizeSeverity(safeDiagnosticProperty(value, "severity")),
    message,
  };
  const line = safeDiagnosticNumber(safeDiagnosticProperty(value, "line"));
  const column = safeDiagnosticNumber(safeDiagnosticProperty(value, "column"));
  const codeValue = safeDiagnosticProperty(value, "code");
  const code = codeValue ? safeDiagnosticText(codeValue, DIAGNOSTIC_CODE_MAX_CHARS) : "";
  if (line !== undefined) diagnostic.line = line;
  if (column !== undefined) diagnostic.column = column;
  if (code) diagnostic.code = code;
  return diagnostic;
}

function safeDiagnosticNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000
    ? value
    : undefined;
}

function normalizeSeverity(value: unknown): ParsedDiagnostic["severity"] {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text === "error") return "error";
  if (text === "warning" || text === "warn") return "warning";
  if (text === "hint") return "hint";
  return "information";
}

function severityRank(severity: ParsedDiagnostic["severity"]): number {
  switch (severity) {
    case "error": return 0;
    case "warning": return 1;
    case "information": return 2;
    case "hint": return 3;
  }
}

function formatDiagnostic(diagnostic: ParsedDiagnostic): string {
  const file = safeDiagnosticProperty(diagnostic, "file");
  const line = safeDiagnosticProperty(diagnostic, "line");
  const column = safeDiagnosticProperty(diagnostic, "column");
  const severity = normalizeSeverity(safeDiagnosticProperty(diagnostic, "severity"));
  const code = safeDiagnosticProperty(diagnostic, "code");
  const message = safeDiagnosticText(safeDiagnosticProperty(diagnostic, "message"), DIAGNOSTIC_MESSAGE_MAX_CHARS);
  const location = [file, line, column].filter(Boolean).join(":");
  return `${location} ${severity}${code ? ` ${safeDiagnosticText(code, DIAGNOSTIC_CODE_MAX_CHARS)}` : ""}: ${message}`;
}

function commandExists(command: string): boolean {
  if (!/^[A-Za-z0-9._+-]+$/.test(command)) return false;
  return spawnSync("bash", ["-c", "command -v -- \"$1\" >/dev/null 2>&1", "bash", command], { encoding: "utf-8" }).status === 0;
}

function withArtifact(output: string, artifactId: string): string {
  return `${output}\n\n[artifact] ${artifactId}`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "target";
}

function readDiagnosticArg(args: Record<string, unknown>, key: string): { ok: true; value: unknown } | { ok: false; value?: undefined } {
  try {
    return { ok: true, value: args[key] };
  } catch {
    return { ok: false };
  }
}

function safeDiagnosticProperty(source: unknown, key: string | number | symbol): unknown {
  if (!source || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string | number | symbol, unknown>)[key];
  } catch {
    return UNREADABLE_ARG;
  }
}

function safeDiagnosticCloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(args);
  } catch {
    return clone;
  }
  for (const key of keys) {
    const value = safeDiagnosticProperty(args, key);
    if (value !== UNREADABLE_ARG) clone[key] = value;
  }
  return clone;
}

function readDiagnosticArrayItems(value: unknown[], maxItems: number): { ok: true; values: unknown[]; length: number } | { ok: false; values?: undefined; length?: undefined } {
  let length = 0;
  try {
    length = Math.max(0, Math.floor(value.length));
  } catch {
    return { ok: false };
  }
  const limit = Math.min(length, Math.max(0, Math.floor(maxItems)));
  const values: unknown[] = [];
  for (let index = 0; index < limit; index++) {
    const item = safeDiagnosticProperty(value, index);
    if (item === UNREADABLE_ARG) return { ok: false };
    values.push(item);
  }
  return { ok: true, values, length };
}

function safeDiagnosticObjectEntries(value: unknown, maxEntries: number): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys.slice(0, Math.max(0, Math.floor(maxEntries)))) {
    const entry = safeDiagnosticProperty(value, key);
    if (entry !== UNREADABLE_ARG) entries.push([key, entry]);
  }
  return entries;
}

function safeDiagnosticOutput(value: unknown): string {
  return truncateDiagnosticText(safeDiagnosticText(value, DIAGNOSTIC_OUTPUT_MAX_CHARS), DIAGNOSTIC_OUTPUT_MAX_CHARS);
}

function safeDiagnosticText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(DIAGNOSTIC_CONTROL_GLOBAL_RE, " ").trim();
  return truncateDiagnosticText(normalized, maxChars);
}

function safeDiagnosticPath(value: unknown): string {
  const text = safeDiagnosticText(value, DIAGNOSTIC_FILE_MAX_CHARS);
  return text.length <= DIAGNOSTIC_WORKDIR_MAX_CHARS ? text : "";
}

function validateDiagnosticBoundedText(value: string, key: string, maxChars: number): string | null {
  if (value.length > maxChars) return `${key} must be ${maxChars} characters or fewer.`;
  if (DIAGNOSTIC_CONTROL_RE.test(value)) return `${key} contains unsupported control characters.`;
  return null;
}

function truncateDiagnosticText(value: string, maxChars: number): string {
  return safeSliceTextBoundary(value, maxChars);
}
