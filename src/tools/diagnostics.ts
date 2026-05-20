/** Diagnostics, GitHub context, PR attempt, automation, and MCP manager helpers. */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

type DiagnosticsToolExtras = Partial<Omit<ToolDef, "name" | "description" | "parameters" | "execute" | "permission" | "category" | "parallelOk">>;

function run(command: string, workdir = "."): string {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return `Error: ${result.error.message}`;
  return [result.stdout, result.stderr].filter(Boolean).join("").trim() || `(exit ${result.status ?? "unknown"})`;
}

function runRaw(command: string, workdir = "."): string {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return `Error: ${result.error.message}`;
  return [result.stdout, result.stderr].filter(Boolean).join("").trim();
}

function runWithStatus(command: string, workdir = "."): { output: string; status: number | null; error?: string } {
  const result = spawnSync("bash", ["-c", command], { cwd: workdir, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return { output: `Error: ${result.error.message}`, status: null, error: result.error.message };
  return { output: [result.stdout, result.stderr].filter(Boolean).join("").trim(), status: result.status ?? null };
}

function resolveWorkdir(args: Record<string, unknown>): string {
  const base = typeof args.__workspace_path === "string" && args.__workspace_path.trim()
    ? args.__workspace_path.trim()
    : process.cwd();
  if (typeof args.workdir === "string" && args.workdir.trim()) return resolvePathAlias(args.workdir.trim(), base);
  if (typeof args.cwd === "string" && args.cwd.trim()) return resolvePathAlias(args.cwd.trim(), base);
  return base;
}

function validateDiagnosticsWorkdirArgs(args: Record<string, unknown>) {
  const workdirInput = args.workdir ?? args.cwd;
  if (workdirInput !== undefined && typeof workdirInput !== "string") {
    return { ok: false as const, message: "workdir must be a string." };
  }
  if (typeof workdirInput === "string" && workdirInput.trim()) {
    return { ok: true as const, args: { ...args, workdir: workdirInput.trim() } };
  }
  return { ok: true as const, args };
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
    tools: getRegistry().listAll().map(tool => ({ name: tool.name, category: tool.category, active: getRegistry().listActive().some(active => active.name === tool.name) })),
  };
  return JSON.stringify(info, null, 2);
}

async function githubIssueContext(args: Record<string, unknown>): Promise<string> {
  const issueValue = [args.issue, args.number, args.url].find(value => typeof value === "string" && value.trim()) as string | undefined;
  const issue = issueValue?.trim();
  if (!issue) return "Error: issue, number, or url is required.";
  const output = run(`gh issue view ${JSON.stringify(issue)} --json number,title,state,author,body,url,comments`, resolveWorkdir(args));
  const artifact = createArtifact({ kind: "github_issue", name: `issue-${safeName(issue)}.json`, content: output, extension: ".json", metadata: { issue } });
  return withArtifact(output, artifact.id);
}

async function githubPrContext(args: Record<string, unknown>): Promise<string> {
  const prValue = [args.pr, args.number, args.url].find(value => typeof value === "string" && value.trim()) as string | undefined;
  const pr = prValue?.trim();
  if (!pr) return "Error: pr, number, or url is required.";
  const includeDiff = args.diff === true;
  const workdir = resolveWorkdir(args);
  const base = run(`gh pr view ${JSON.stringify(pr)} --json number,title,state,author,body,url,comments,headRefName,baseRefName`, workdir);
  const output = includeDiff ? `${base}\n\n[diff]\n${run(`gh pr diff ${JSON.stringify(pr)} --patch`, workdir)}` : base;
  const artifact = createArtifact({ kind: "github_pr", name: `pr-${safeName(pr)}.${includeDiff ? "txt" : "json"}`, content: output, metadata: { pr, includeDiff } });
  return withArtifact(output, artifact.id);
}

async function githubComment(args: Record<string, unknown>): Promise<string> {
  const targetValue = [args.target, args.issue, args.pr, args.number, args.url]
    .find(value => typeof value === "string" && value.trim()) as string | undefined;
  const target = targetValue?.trim();
  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (!target || !body) return "Error: target and body are required.";
  const guard = githubMutationGuard(args, { requireClean: args.allow_dirty !== true });
  if (guard) return guard;
  const workdir = resolveWorkdir(args);
  const evidence = verifyGithubTarget(target, workdir);
  if (evidence.startsWith("Error:")) return evidence;
  const artifact = createArtifact({ kind: "github_evidence", name: `comment-${safeName(target)}.json`, content: evidence, extension: ".json", metadata: { target, action: "comment" } });
  return run(`gh issue comment ${JSON.stringify(target)} --body ${JSON.stringify(body)}`, workdir);
}

async function githubCloseIssue(args: Record<string, unknown>): Promise<string> {
  const issueValue = [args.issue, args.number, args.url].find(value => typeof value === "string" && value.trim()) as string | undefined;
  const issue = issueValue?.trim();
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!issue || !reason.trim()) return "Error: issue and reason are required.";
  const guard = githubMutationGuard(args, { requireClean: args.allow_dirty !== true });
  if (guard) return guard;
  const workdir = resolveWorkdir(args);
  const evidence = verifyGithubTarget(issue, workdir);
  if (evidence.startsWith("Error:")) return evidence;
  createArtifact({ kind: "github_evidence", name: `close-${safeName(issue)}.json`, content: evidence, extension: ".json", metadata: { issue, action: "close" } });
  return run(`gh issue close ${JSON.stringify(issue)} --comment ${JSON.stringify(reason)}`, workdir);
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
  return JSON.stringify({ id, artifact_id: artifact.id, file: artifact.path, bytes: patch.length, sha256: artifact.sha256, branch, status }, null, 2);
}

async function prAttemptList(): Promise<string> {
  const artifacts = listArtifacts(100, "pr_attempt");
  const legacy = existsSync(ATTEMPT_DIR) ? readdirSync(ATTEMPT_DIR).filter(name => name.endsWith(".patch")).map(name => ({ legacy: name.replace(/\.patch$/, "") })) : [];
  if (!artifacts.length && !legacy.length) return "No PR attempts.";
  return JSON.stringify({ artifacts, legacy }, null, 2);
}

async function prAttemptRead(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string" ? args.id.replace(/\.patch$/, "").trim() : "";
  if (!id) return "Error: id is required.";
  const artifact = getArtifact(id);
  if (artifact) return readArtifact(id);
  const file = join(ATTEMPT_DIR, `${id}.patch`);
  return existsSync(file) ? readFileSync(file, "utf-8") : `Error: attempt not found: ${id}`;
}

async function prAttemptPreflight(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string" ? args.id.replace(/\.patch$/, "").trim() : "";
  if (!id) return "Error: id is required.";
  const artifact = getArtifact(id);
  const file = artifact?.path || join(ATTEMPT_DIR, `${id}.patch`);
  if (!existsSync(file)) return `Error: attempt not found: ${id}`;
  return run(`git apply --check ${JSON.stringify(file)}`, resolveWorkdir(args));
}

async function prAttemptBranch(args: Record<string, unknown>): Promise<string> {
  const workdir = resolveWorkdir(args);
  if (args.branch !== undefined && typeof args.branch !== "string") return "Error: branch must be a string.";
  if (args.base !== undefined && typeof args.base !== "string") return "Error: base must be a string.";
  const requestedBranch = typeof args.branch === "string" ? args.branch.trim() : "";
  const name = (requestedBranch || `seek-code/${Date.now().toString(36)}`).replace(/[^a-zA-Z0-9._/-]/g, "-");
  const base = typeof args.base === "string" ? args.base.trim() : "";
  const guard = ensureGitRepo(workdir);
  if (guard) return guard;
  const output = run(`git checkout ${base ? JSON.stringify(base) : ""} -b ${JSON.stringify(name)} 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_attempt_branch", name: `${safeName(name)}.txt`, content: output, metadata: { workdir: resolve(workdir), branch: name, base } });
  return JSON.stringify({ branch: name, artifact_id: artifact.id, output }, null, 2);
}

async function prAttemptGate(args: Record<string, unknown>): Promise<string> {
  const workdir = resolveWorkdir(args);
  const command = typeof args.command === "string"
    ? args.command.trim()
    : typeof args.gate === "string"
      ? args.gate.trim()
      : "";
  if (!command) return "Error: command is required.";
  const result = runWithStatus(command, workdir);
  const passed = result.status === 0;
  const output = result.output || `(exit ${result.status ?? "unknown"})`;
  const artifact = createArtifact({ kind: "pr_attempt_gate", name: "gate.log", content: output, extension: ".log", metadata: { workdir: resolve(workdir), command, passed, status: result.status } });
  return JSON.stringify({ command, passed, status: result.status, artifact_id: artifact.id, output }, null, 2);
}

async function prAttemptPushDraft(args: Record<string, unknown>): Promise<string> {
  const validated = validateDiagnosticsWorkdirArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  if (normalized.title !== undefined && typeof normalized.title !== "string") return "Error: title must be a string.";
  if (normalized.body !== undefined && typeof normalized.body !== "string") return "Error: body must be a string.";
  if (normalized.branch !== undefined && typeof normalized.branch !== "string") return "Error: branch must be a string.";
  const title = typeof normalized.title === "string" ? normalized.title : "Seek Code draft PR";
  const body = typeof normalized.body === "string" ? normalized.body : "Created by Seek Code.";
  const branch = (typeof normalized.branch === "string" ? normalized.branch : run("git branch --show-current", workdir)).trim();
  if (!branch) return "Error: branch is required or current branch cannot be detected.";
  const guard = githubMutationGuard(normalized, { requireClean: normalized.allow_dirty !== true });
  if (guard) return guard;
  const push = run(`git push -u origin ${JSON.stringify(branch)} 2>&1`, workdir);
  const create = run(`gh pr create --draft --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_attempt_push", name: `${safeName(branch)}.log`, content: `${push}\n\n${create}`, extension: ".log", metadata: { workdir: resolve(workdir), branch, title } });
  return JSON.stringify({ branch, artifact_id: artifact.id, push, create }, null, 2);
}

async function prAttemptReviewSync(args: Record<string, unknown>): Promise<string> {
  const workdir = resolveWorkdir(args);
  const prValue = [args.pr, args.number, args.url].find(value => typeof value === "string" && value.trim()) as string | undefined;
  const pr = prValue?.trim();
  if (!pr) return "Error: pr, number, or url is required.";
  if (!commandExists("gh")) return "Error: GitHub CLI 'gh' is required.";
  const comments = run(`gh pr view ${JSON.stringify(pr)} --json comments,reviews,reviewDecision,url 2>&1`, workdir);
  const artifact = createArtifact({ kind: "pr_review_comments", name: `pr-${safeName(pr)}-review.json`, content: comments, extension: ".json", metadata: { workdir: resolve(workdir), pr } });
  return JSON.stringify({ pr, artifact_id: artifact.id, comments }, null, 2);
}

async function prAttemptRollback(args: Record<string, unknown>): Promise<string> {
  const validated = validateDiagnosticsWorkdirArgs(args);
  if (!validated.ok) return `Error: ${validated.message}`;
  const normalized = validated.args;
  const workdir = resolveWorkdir(normalized);
  if (normalized.branch !== undefined && typeof normalized.branch !== "string") return "Error: branch must be a string.";
  if (normalized.target !== undefined && typeof normalized.target !== "string") return "Error: target must be a string.";
  const branch = typeof normalized.branch === "string" ? normalized.branch : "";
  const target = typeof normalized.target === "string" ? normalized.target : "HEAD";
  const guard = ensureGitRepo(workdir);
  if (guard) return guard;
  const before = run("git status --porcelain=v1 && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD", workdir);
  const output = branch
    ? run(`git checkout ${JSON.stringify(branch)} 2>&1 && git reset --hard ${JSON.stringify(target)} 2>&1`, workdir)
    : run(`git reset --hard ${JSON.stringify(target)} 2>&1`, workdir);
  const after = run("git status --porcelain=v1 && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD", workdir);
  const artifact = createArtifact({ kind: "pr_attempt_rollback", name: "rollback.log", content: `[before]\n${before}\n\n[output]\n${output}\n\n[after]\n${after}`, extension: ".log", metadata: { workdir: resolve(workdir), branch, target } });
  return JSON.stringify({ branch: branch || null, target, artifact_id: artifact.id, output }, null, 2);
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
  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  if (!prompt.trim()) return "Error: prompt is required.";
  if (args.schedule !== undefined && typeof args.schedule !== "string") return "Error: schedule must be a string.";
  const automation: Automation = omitUndefined({
    id: `auto_${Date.now().toString(36)}`,
    prompt,
    schedule: typeof args.schedule === "string" ? args.schedule : undefined,
    paused: false,
    created_at: new Date().toISOString(),
  });
  automations.set(automation.id, automation);
  return JSON.stringify(automation, null, 2);
}

async function automationList(): Promise<string> {
  return JSON.stringify([...automations.values()], null, 2);
}

async function automationRead(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return "Error: id is required.";
  const automation = automations.get(id);
  return automation ? JSON.stringify(automation, null, 2) : `Error: automation not found: ${id}`;
}

async function automationUpdate(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return "Error: id is required.";
  const automation = automations.get(id);
  if (!automation) return `Error: automation not found: ${id}`;
  if (args.prompt !== undefined) {
    if (typeof args.prompt !== "string" || !args.prompt.trim()) return "Error: prompt is required.";
    automation.prompt = args.prompt;
  }
  if (args.schedule !== undefined) {
    if (typeof args.schedule !== "string") return "Error: schedule must be a string.";
    automation.schedule = args.schedule;
  }
  return JSON.stringify(automation, null, 2);
}

async function automationStatus(args: Record<string, unknown>, paused: boolean): Promise<string> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return "Error: id is required.";
  const automation = automations.get(id);
  if (!automation) return `Error: automation not found: ${id}`;
  automation.paused = paused;
  return JSON.stringify(automation, null, 2);
}

async function automationDelete(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return "Error: id is required.";
  return automations.delete(id) ? `Deleted automation ${id}.` : `Error: automation not found: ${id}`;
}

async function automationRun(args: Record<string, unknown>): Promise<string> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return "Error: id is required.";
  const automation = automations.get(id);
  if (!automation) return `Error: automation not found: ${id}`;
  const { getTaskManager } = await import("../engine/task-lifecycle.js");
  const task = getTaskManager().createTask("background", `Automation: ${automation.prompt}`);
  getTaskManager().startTask(task.id);
  return JSON.stringify({ task_id: task.id, automation }, null, 2);
}

async function mcpManager(args: Record<string, unknown>): Promise<string> {
  const action = normalizeMCPAction(args.action);
  try {
    if (action === "list") return JSON.stringify(getMCPManager().list(), null, 2);
    if (action === "reload") {
      const manager = await reloadMCPManager();
      return JSON.stringify({ reloaded: true, servers: manager.list() }, null, 2);
    }
    if (action === "health") {
      const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
      if (args.name !== undefined && !name) return "Error: name is required.";
      return JSON.stringify(await getMCPManager().healthCheck(name), null, 2);
    }
    if (action === "reconnect") {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return "Error: name is required.";
      const server = getMCPManager().list().find(item => item.name === name);
      if (!server) return `Error: MCP server not found: ${name}`;
      return await getMCPManager().connectOne(server);
    }
    if (action === "add") {
      const server = parseMCPServer(args);
      const servers = addMCPServer(server);
      return JSON.stringify({ added: server.name, servers }, null, 2);
    }
    if (action === "enable" || action === "disable") {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return "Error: name is required.";
      const servers = setMCPServerEnabled(name, action === "enable");
      return JSON.stringify({ name, enabled: action === "enable", servers }, null, 2);
    }
    if (action === "remove" || action === "delete") {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return "Error: name is required.";
      const servers = removeMCPServer(name);
      return JSON.stringify({ removed: name, servers }, null, 2);
    }
    return `Error: unsupported MCP action '${action}'. Use list, add, enable, disable, remove, reload, health, reconnect.`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function lspDiagnostics(args: Record<string, unknown>): Promise<string> {
  const workdir = resolveWorkdir(args);
  if (args.language !== undefined && typeof args.language !== "string") return "Error: language must be a string.";
  if (args.min_severity !== undefined) {
    const severityError = validateLspSeverity(args.min_severity);
    if (severityError) return `Error: ${severityError}`;
  }
  if (args.severity !== undefined) {
    const severityError = validateLspSeverity(args.severity);
    if (severityError) return `Error: ${severityError}`;
  }
  if (args.files !== undefined && !isStringListInput(args.files)) return "Error: files must be a string or array of strings.";
  const language = typeof args.language === "string" ? args.language : detectLanguage(workdir);
  const files = normalizeFiles(args.files);
  const minSeverity = typeof args.min_severity === "string"
    ? args.min_severity
    : typeof args.severity === "string"
      ? args.severity
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
  return JSON.stringify({ language, command, artifact_id: artifact.id, summary, diagnostics, output }, null, 2);
}

async function lspSymbols(args: Record<string, unknown>): Promise<string> {
  const workdir = resolveWorkdir(args);
  const file = typeof args.file === "string" && args.file.trim()
    ? args.file.trim()
    : typeof args.path === "string" && args.path.trim() ? args.path.trim() : "";
  if (!file) return "Error: file is required.";
  try {
    const result = await getLspManager().documentSymbolsWithBackend(file, workdir);
    return JSON.stringify({ file, workdir: resolve(workdir), backend: result.backend, symbols: result.value }, null, 2);
  } catch (error: any) {
    return `Error: ${error?.message || String(error)}`;
  }
}

async function lspDefinition(args: Record<string, unknown>): Promise<string> {
  const workdir = resolveWorkdir(args);
  const symbol = typeof args.symbol === "string" ? args.symbol.trim() : "";
  if (!symbol) return "Error: symbol is required.";
  if (args.line !== undefined && !isStrictIntegerAtLeast(args.line, 1)) return "Error: line must be a positive number.";
  if (args.character !== undefined && !isStrictIntegerAtLeast(args.character, 0)) return "Error: character must be a non-negative number.";
  const file = typeof args.file === "string" && args.file.trim()
    ? args.file.trim()
    : typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
  const line = args.line !== undefined ? strictInteger(args.line) : undefined;
  const character = args.character !== undefined ? strictInteger(args.character) : undefined;
  try {
    const result = await getLspManager().definitionWithBackend(symbol, workdir, omitUndefined({ file, line, character }));
    return JSON.stringify({ symbol, workdir: resolve(workdir), backend: result.backend, matches: result.value }, null, 2);
  } catch (error: any) {
    return `Error: ${error?.message || String(error)}`;
  }
}

async function lspHover(args: Record<string, unknown>): Promise<string> {
  const workdir = resolveWorkdir(args);
  const file = typeof args.file === "string" && args.file.trim()
    ? args.file.trim()
    : typeof args.path === "string" && args.path.trim() ? args.path.trim() : "";
  if (!file) return "Error: file is required.";
  if (!isStrictIntegerAtLeast(args.line, 1)) return "Error: line must be a positive number.";
  if (args.character !== undefined && !isStrictIntegerAtLeast(args.character, 0)) return "Error: character must be a non-negative number.";
  const line = strictInteger(args.line)!;
  const character = args.character !== undefined ? strictInteger(args.character) : undefined;
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
    files: args.files || [],
    min_severity: args.minSeverity || "warning",
  });
  try {
    const parsed = JSON.parse(result);
    const summary = parsed.summary as { total?: number; by_severity?: Record<string, number> };
    const total = Number(summary?.total || 0);
    if (!total) return `Diagnostics: no issues found. Artifact: ${parsed.artifact_id}`;
    const counts = Object.entries(summary.by_severity || {})
      .map(([severity, count]) => `${severity}:${count}`)
      .join(" ");
    const first = Array.isArray(parsed.diagnostics) && parsed.diagnostics.length
      ? ` First: ${formatDiagnostic(parsed.diagnostics[0])}`
      : "";
    return `Diagnostics: ${total} issue(s) ${counts}. Artifact: ${parsed.artifact_id}.${first}`;
  } catch {
    return result.startsWith("Error:") ? result : `Diagnostics completed:\n${result.slice(0, 1000)}`;
  }
}

export function clearAutomationState(): void {
  automations.clear();
  if (existsSync(ATTEMPT_DIR)) rmSync(ATTEMPT_DIR, { recursive: true, force: true });
}

function normalizeGithubTargetArgs(args: Record<string, unknown>, key: "issue" | "pr" | "target"): Record<string, unknown> {
  const normalized = { ...args };
  const candidates = [args[key], args.issue, args.pr, args.number, args.url];
  const target = candidates.find(value => typeof value === "string" && value.trim()) as string | undefined;
  if (target) normalized[key] = target;
  return normalized;
}

function validateGithubCommentArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const normalized = normalizeGithubTargetArgs(normalizedArgs, "target");
  const target = typeof normalized.target === "string" ? normalized.target.trim() : "";
  const body = typeof normalized.body === "string" ? normalized.body.trim() : "";
  if (!target) return { ok: false as const, message: "issue, pr, number, or url is required." };
  if (!body) return { ok: false as const, message: "body is required." };
  return { ok: true as const, args: { ...normalized, target, body } };
}

function validateGithubIssueArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalized = normalizeGithubTargetArgs(workdirValidated.args, "issue");
  const issue = typeof normalized.issue === "string" ? normalized.issue.trim() : "";
  return issue
    ? { ok: true as const, args: { ...normalized, issue } }
    : { ok: false as const, message: "issue, number, or url is required." };
}

function validateGithubPrArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalized = normalizeGithubTargetArgs(workdirValidated.args, "pr");
  const pr = typeof normalized.pr === "string" ? normalized.pr.trim() : "";
  return pr
    ? { ok: true as const, args: { ...normalized, pr } }
    : { ok: false as const, message: "pr, number, or url is required." };
}

function validateGithubCloseArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalized = normalizeGithubTargetArgs(workdirValidated.args, "issue");
  const issue = typeof normalized.issue === "string" ? normalized.issue.trim() : "";
  const reason = typeof normalized.reason === "string" ? normalized.reason.trim() : "";
  if (!issue) return { ok: false as const, message: "issue, number, or url is required." };
  if (!reason) return { ok: false as const, message: "reason is required." };
  return { ok: true as const, args: { ...normalized, issue, reason } };
}

function validatePrAttemptGateArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const command = typeof normalizedArgs.command === "string"
    ? normalizedArgs.command.trim()
    : typeof normalizedArgs.gate === "string"
      ? normalizedArgs.gate.trim()
      : "";
  return command
    ? { ok: true as const, args: { ...normalizedArgs, command } }
    : { ok: false as const, message: "command is required." };
}

function validatePrAttemptBranchArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  if (normalizedArgs.branch !== undefined) {
    if (typeof normalizedArgs.branch !== "string") return { ok: false as const, message: "branch must be a string." };
    const branch = normalizedArgs.branch.trim();
    if (!branch) return { ok: false as const, message: "branch must be a non-empty string." };
    if (normalizedArgs.base === undefined) return { ok: true as const, args: { ...normalizedArgs, branch } };
  }
  if (normalizedArgs.base !== undefined) {
    if (typeof normalizedArgs.base !== "string") return { ok: false as const, message: "base must be a string." };
    const base = normalizedArgs.base.trim();
    if (!base) return { ok: false as const, message: "base must be a non-empty string." };
    return normalizedArgs.branch === undefined
      ? { ok: true as const, args: { ...normalizedArgs, base } }
      : { ok: true as const, args: { ...normalizedArgs, branch: (normalizedArgs.branch as string).trim(), base } };
  }
  return { ok: true as const, args: normalizedArgs };
}

function validatePrAttemptPushDraftArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const normalized = { ...normalizedArgs };
  for (const key of ["title", "body", "branch"] as const) {
    const value = normalized[key];
    if (value !== undefined && typeof value !== "string") {
      return { ok: false as const, message: `${key} must be a string.` };
    }
    if (typeof value === "string") normalized[key] = value.trim();
  }
  return { ok: true as const, args: normalized };
}

function validatePrAttemptRollbackArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const normalized = { ...normalizedArgs };
  for (const key of ["branch", "target"] as const) {
    const value = normalized[key];
    if (value !== undefined && typeof value !== "string") {
      return { ok: false as const, message: `${key} must be a string.` };
    }
    if (typeof value === "string") normalized[key] = value.trim();
  }
  return { ok: true as const, args: normalized };
}

function validateIdArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs: Record<string, unknown> = workdirValidated.args;
  const id = typeof normalizedArgs.id === "string" ? normalizedArgs.id.trim() : "";
  return id
    ? { ok: true as const, args: { ...normalizedArgs, id } }
    : { ok: false as const, message: "id is required." };
}

function validatePromptArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const prompt = typeof normalizedArgs.prompt === "string" ? normalizedArgs.prompt.trim() : "";
  if (!prompt) return { ok: false as const, message: "prompt is required." };
  if (normalizedArgs.schedule !== undefined && typeof normalizedArgs.schedule !== "string") {
    return { ok: false as const, message: "schedule must be a string." };
  }
  return { ok: true as const, args: { ...normalizedArgs, prompt } };
}

function validateAutomationUpdateArgs(args: Record<string, unknown>) {
  const validated = validateIdArgs(args);
  if (!validated.ok) return validated;
  const normalizedArgs: Record<string, unknown> = validated.args;
  if (normalizedArgs.prompt !== undefined) {
    if (typeof normalizedArgs.prompt !== "string" || !normalizedArgs.prompt.trim()) return { ok: false as const, message: "prompt is required." };
  }
  if (normalizedArgs.schedule !== undefined && typeof normalizedArgs.schedule !== "string") {
    return { ok: false as const, message: "schedule must be a string." };
  }
  return validated;
}

function isStringListInput(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string"));
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
  return value === undefined ? undefined : strictInteger(value);
}

function validateLspDiagnosticsArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  if (normalizedArgs.language !== undefined && typeof normalizedArgs.language !== "string") {
    return { ok: false as const, message: "language must be a string." };
  }
  if (normalizedArgs.min_severity !== undefined) {
    const severityError = validateLspSeverity(normalizedArgs.min_severity);
    if (severityError) return { ok: false as const, message: severityError };
  }
  if (normalizedArgs.severity !== undefined) {
    const severityError = validateLspSeverity(normalizedArgs.severity);
    if (severityError) return { ok: false as const, message: severityError };
  }
  if (normalizedArgs.files !== undefined && !isStringListInput(normalizedArgs.files)) {
    return { ok: false as const, message: "files must be a string or array of strings." };
  }
  return { ok: true as const, args: normalizedArgs };
}

function validateLspFileArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const file = typeof normalizedArgs.file === "string" && normalizedArgs.file.trim()
    ? normalizedArgs.file.trim()
    : typeof normalizedArgs.path === "string" && normalizedArgs.path.trim() ? normalizedArgs.path.trim() : "";
  if (!file) return { ok: false as const, message: "file is required." };
  return { ok: true as const, args: { ...normalizedArgs, file } };
}

function validateLspDefinitionArgs(args: Record<string, unknown>) {
  const workdirValidated = validateDiagnosticsWorkdirArgs(args);
  if (!workdirValidated.ok) return workdirValidated;
  const normalizedArgs = workdirValidated.args;
  const symbol = typeof normalizedArgs.symbol === "string" ? normalizedArgs.symbol.trim() : "";
  if (normalizedArgs.file !== undefined && typeof normalizedArgs.file !== "string") return { ok: false as const, message: "file must be a string." };
  if (normalizedArgs.path !== undefined && typeof normalizedArgs.path !== "string") return { ok: false as const, message: "path must be a string." };
  if (normalizedArgs.line !== undefined && !isStrictIntegerAtLeast(normalizedArgs.line, 1)) {
    return { ok: false as const, message: "line must be a positive number." };
  }
  if (normalizedArgs.character !== undefined && !isStrictIntegerAtLeast(normalizedArgs.character, 0)) {
    return { ok: false as const, message: "character must be a non-negative number." };
  }
  return symbol
    ? {
      ok: true as const,
      args: {
        ...normalizedArgs,
        symbol,
        ...(normalizedArgs.line !== undefined ? { line: strictInteger(normalizedArgs.line) } : {}),
        ...(normalizedArgs.character !== undefined ? { character: normalizeOptionalCharacter(normalizedArgs.character) } : {}),
      },
    }
    : { ok: false as const, message: "symbol is required." };
}

function validateLspHoverArgs(args: Record<string, unknown>) {
  const fileValidated = validateLspFileArgs(args);
  if (!fileValidated.ok) return fileValidated;
  if (args.line === undefined || !isStrictIntegerAtLeast(args.line, 1)) {
    return { ok: false as const, message: "line must be a positive number." };
  }
  if (args.character !== undefined && !isStrictIntegerAtLeast(args.character, 0)) {
    return { ok: false as const, message: "character must be a non-negative number." };
  }
  return {
    ok: true as const,
    args: {
      ...fileValidated.args,
      line: strictInteger(args.line),
      ...(args.character !== undefined ? { character: normalizeOptionalCharacter(args.character) } : {}),
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
  const result = runWithStatus(`gh issue view ${JSON.stringify(target)} --json number,title,state,url 2>&1`, workdir);
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
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) throw new Error("name is required.");
  const env = parseMCPEnv(args.env);
  const rawTransport = typeof args.transport === "string" ? args.transport.trim().toLowerCase() : undefined;
  if (args.transport !== undefined) {
    if (typeof args.transport !== "string") throw new Error("transport must be a string.");
    if (rawTransport !== "stdio" && rawTransport !== "sse") throw new Error("transport must be stdio or sse.");
  }
  const transport = normalizeMCPTransport(args.transport, args.url);
  if (args.enabled !== undefined && typeof args.enabled !== "boolean") {
    throw new Error("enabled must be a boolean.");
  }
  const server: MCPConfig = {
    name,
    transport,
    command: typeof args.command === "string" && args.command.trim() ? args.command : undefined,
    args: Array.isArray(args.args)
      ? args.args.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : typeof args.args === "string"
      ? args.args.split(/\s+/).filter(Boolean)
      : [],
    url: typeof args.url === "string" && args.url.trim() ? args.url : undefined,
    env,
    enabled: args.enabled !== false,
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
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error("env must be an object with string values.");
    env[key] = entry;
  }
  return env;
}

function normalizeMCPAction(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "list";
}

function normalizeMCPTransport(value: unknown, url: unknown): MCPConfig["transport"] {
  const transport = typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : (typeof url === "string" && url.trim() ? "sse" : "stdio");
  if (transport === "stdio" || transport === "sse") return transport;
  return "stdio";
}

function validateMCPManagerArgs(args: Record<string, unknown>) {
  const action = normalizeMCPAction(args.action);
  if (action === "list" || action === "reload") return { ok: true as const, args: { ...args, action } };
  if (action === "health") {
    if (args.name === undefined) return { ok: true as const, args: { ...args, action } };
    const name = typeof args.name === "string" ? args.name.trim() : "";
    return name
      ? { ok: true as const, args: { ...args, action, name } }
      : { ok: false as const, message: "name is required." };
  }
  if (["enable", "disable", "remove", "delete", "reconnect"].includes(action)) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    return name
      ? { ok: true as const, args: { ...args, action, name } }
      : { ok: false as const, message: "name is required." };
  }
  if (action === "add") {
    try {
      const server = parseMCPServer(args);
      return { ok: true as const, args: { ...args, action, ...server } };
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
      if (existsSync(localTsc)) return `${JSON.stringify(localTsc)} --noEmit --pretty false 2>&1`;
      if (commandExists("tsc")) return "tsc --noEmit --pretty false 2>&1";
      const bundledTsc = resolve("node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
      if (existsSync(bundledTsc)) return `${JSON.stringify(bundledTsc)} --noEmit --pretty false 2>&1`;
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
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map(item => item.trim()).filter(Boolean);
  return [];
}

function parseDiagnostics(output: string, language: string): ParsedDiagnostic[] {
  if (language === "python") {
    try {
      const parsed = JSON.parse(output) as { generalDiagnostics?: Array<any> };
      return parsePythonDiagnostics(parsed.generalDiagnostics);
    } catch {
      // fall through to regex parser
    }
  }

  const diagnostics: ParsedDiagnostic[] = [];
  const tsPattern = /(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:]+):\s+(.+)/i;
  const colonPattern = /(.+?):(\d+):(\d+):\s+(error|warning|info|information|hint)(?:\[[^\]]+\])?:\s+(.+)/i;
  for (const line of output.split("\n")) {
    const ts = line.match(tsPattern);
    if (ts) {
      const [file, lineNumber, column, severity, code, message] = ts.slice(1);
      if (!file || !lineNumber || !column || !severity || !code || !message) continue;
      diagnostics.push({
        file,
        line: Number(lineNumber),
        column: Number(column),
        severity: normalizeSeverity(severity),
        code,
        message,
      });
      continue;
    }
    const colon = line.match(colonPattern);
    if (colon) {
      const [file, lineNumber, column, severity, message] = colon.slice(1);
      if (!file || !lineNumber || !column || !severity || !message) continue;
      diagnostics.push({
        file,
        line: Number(lineNumber),
        column: Number(column),
        severity: normalizeSeverity(severity),
        message,
      });
    }
  }
  return diagnostics;
}

function parsePythonDiagnostics(value: unknown): ParsedDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: ParsedDiagnostic[] = [];
  for (const item of value) {
    const diagnostic = parsePythonDiagnostic(item);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function parsePythonDiagnostic(value: unknown): ParsedDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const file = typeof record.file === "string" && record.file.trim() ? record.file : null;
  const message = typeof record.message === "string" && record.message.trim() ? record.message : null;
  const code = optionalDiagnosticString(record.rule);
  if (!file || !message || code === undefined) return null;

  const line = typeof record.range === "object" && record.range && !Array.isArray(record.range)
    && typeof (record.range as { start?: unknown }).start === "object"
    && (record.range as { start?: unknown }).start
    && !Array.isArray((record.range as { start?: unknown }).start)
    && typeof ((record.range as { start?: { line?: unknown } }).start?.line) === "number"
    ? ((record.range as { start?: { line?: number } }).start!.line! + 1)
    : undefined;
  const column = typeof record.range === "object" && record.range && !Array.isArray(record.range)
    && typeof (record.range as { start?: unknown }).start === "object"
    && (record.range as { start?: unknown }).start
    && !Array.isArray((record.range as { start?: unknown }).start)
    && typeof ((record.range as { start?: { character?: unknown } }).start?.character) === "number"
    ? ((record.range as { start?: { character?: number } }).start!.character! + 1)
    : undefined;

  return {
    file,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    severity: normalizeSeverity(record.severity),
    message,
    ...(code !== null ? { code } : {}),
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
    if (severityRank(diagnostic.severity) > minRank) return false;
    if (!filters.length) return true;
    const diagPath = resolve(root, diagnostic.file);
    return filters.some(file => diagPath === file || diagnostic.file.endsWith(file) || diagPath.endsWith(file));
  });
}

function summarizeDiagnostics(diagnostics: ParsedDiagnostic[]): { total: number; by_severity: Record<string, number> } {
  const bySeverity: Record<string, number> = {};
  for (const diagnostic of diagnostics) bySeverity[diagnostic.severity] = (bySeverity[diagnostic.severity] || 0) + 1;
  return { total: diagnostics.length, by_severity: bySeverity };
}

function normalizeSeverity(value: unknown): ParsedDiagnostic["severity"] {
  const text = String(value || "").toLowerCase();
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
  const location = [diagnostic.file, diagnostic.line, diagnostic.column].filter(Boolean).join(":");
  return `${location} ${diagnostic.severity}${diagnostic.code ? ` ${diagnostic.code}` : ""}: ${diagnostic.message}`;
}

function commandExists(command: string): boolean {
  return spawnSync("bash", ["-c", `command -v ${JSON.stringify(command)}`], { encoding: "utf-8" }).status === 0;
}

function withArtifact(output: string, artifactId: string): string {
  return `${output}\n\n[artifact] ${artifactId}`;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "target";
}
