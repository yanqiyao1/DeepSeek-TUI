import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { PACKAGE_NAME, VERSION } from "./version.js";
import { SEEKCODE_DIR, homeDir } from "./paths.js";
import { p } from "./ui/palette.js";
import { omitUndefined } from "./utils/object.js";
import { safeJsonStringify } from "./utils/json-safe.js";
import { safeSliceTextBoundary } from "./utils/text-boundary.js";

type TTYInput = NodeJS.ReadableStream & { isTTY?: boolean };
type TTYOutput = NodeJS.WritableStream & { isTTY?: boolean };

export type UpdateCheckResult = "disabled" | "current" | "available" | "skipped" | "updated" | "failed" | "locked" | "unsupported";
export type InstallationKind = "global" | "local" | "dev" | "unknown";

export interface InstallationInfo {
  kind: InstallationKind;
  packageName: string;
  packageRoot: string | null;
  executablePath: string | null;
  npmPrefix: string | null;
  localProjectRoot: string | null;
  updateCommand: string;
  canAutoUpdate: boolean;
  reason: string;
}

export interface PreparedUpdateCheck {
  result: Exclude<UpdateCheckResult, "skipped" | "updated" | "failed" | "locked">;
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  installation?: InstallationInfo;
}

export type UpdateCheckOptions = {
  packageName?: string;
  currentVersion?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  stdin?: TTYInput;
  stdout?: TTYOutput;
  fetchLatestVersion?: (packageName: string, timeoutMs: number) => Promise<string | null>;
  installLatest?: (packageName: string, installation?: InstallationInfo) => Promise<number>;
  detectInstallation?: () => Promise<InstallationInfo>;
};

export interface RunUpdateOptions extends UpdateCheckOptions {
  yes?: boolean;
  checkOnly?: boolean;
  diagnoseOnly?: boolean;
  targetVersion?: string;
  stderr?: NodeJS.WritableStream;
  installPackage?: (command: string, args: string[], cwd: string, timeoutMs?: number) => Promise<number>;
}

export interface DetectInstallationOptions {
  packageName?: string;
  modulePath?: string;
  executablePath?: string;
  cwd?: string;
  npmPrefix?: string | null;
  getNpmPrefix?: () => Promise<string | null>;
}

const UPDATE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_UPDATE_TIMEOUT_MS = 60_000;
const INSTALL_TERMINATE_SIGKILL_MS = 500;
const MAX_DISPLAY_CHARS = 300;
const MAX_UPDATE_LOCK_BYTES = 64 * 1024;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 4096;
const UPDATE_CONTROL_GLOBAL_RE = /[\u0000-\u001F\u007F]/g;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isTruthyEnv(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function shouldCheckForUpdates(options: Pick<UpdateCheckOptions, "env" | "stdin" | "stdout"> = {}): boolean {
  const env = objectOption(safeOption(options, "env"), process.env);
  const stdin = streamOption<TTYInput>(safeOption(options, "stdin"), process.stdin);
  const stdout = streamOption<TTYOutput>(safeOption(options, "stdout"), process.stdout);
  if (safeOption(stdin, "isTTY") !== true || safeOption(stdout, "isTTY") !== true) return false;
  if (isTruthyEnv(safeOption(env, "CI"))) return false;
  if (isTruthyEnv(safeOption(env, "SEEKCODE_SKIP_UPDATE_CHECK"))) return false;
  if (isTruthyEnv(safeOption(env, "NO_UPDATE_NOTIFIER"))) return false;
  return true;
}

function parseVersionTuple(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function normalizePackageName(value: unknown, fallback = PACKAGE_NAME): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.includes("\0") || name.length > 214 || !PACKAGE_NAME_RE.test(name)) return fallback;
  return name;
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = value.trim();
  if (!version || version.includes("\0") || /\s/.test(version) || version.length > 128 || !SEMVER_RE.test(version)) return null;
  return version;
}

function normalizeTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, MAX_UPDATE_TIMEOUT_MS);
}

function normalizeLockTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : UPDATE_LOCK_TIMEOUT_MS;
}

function displayText(value: unknown): string {
  return safeSliceTextBoundary(String(value ?? "")
    .replace(UPDATE_CONTROL_GLOBAL_RE, " ")
    .trim(), MAX_DISPLAY_CHARS);
}

async function questionOrNull(
  rl: ReturnType<typeof createInterface>,
  input: NodeJS.ReadableStream,
  query: string,
): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      input.removeListener("end", onInputClosed);
      input.removeListener("close", onInputClosed);
      input.removeListener("error", onInputClosed);
      resolve(answer);
    };
    const onClose = () => {
      setImmediate(() => finish(null));
    };
    const onInputClosed = () => {
      const readable = input as NodeJS.ReadableStream & { readableLength?: number };
      if ((readable.readableLength ?? 0) > 0) return;
      setImmediate(() => {
        finish(null);
        rl.close();
      });
    };
    rl.once("close", onClose);
    input.once("end", onInputClosed);
    input.once("close", onInputClosed);
    input.once("error", onInputClosed);
    rl.question(query).then(answer => finish(answer)).catch(() => finish(null));
  });
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersionTuple(left);
  const b = parseVersionTuple(right);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

export async function fetchLatestNpmVersion(packageName: string, timeoutMs: number): Promise<string | null> {
  const safePackageName = normalizePackageName(packageName);
  const safeTimeoutMs = normalizeTimeoutMs(timeoutMs, 2500);
  return new Promise(resolve => {
    execFile("npm", ["view", safePackageName, "version", "--silent"], { timeout: safeTimeoutMs, windowsHide: true, cwd: homedir(), maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(normalizeVersion(String(stdout || "")));
    });
  });
}

export function getUpdateLockPath(): string {
  return resolve(homeDir(), SEEKCODE_DIR, ".update.lock");
}

export async function acquireUpdateLock(lockPath = getUpdateLockPath(), timeoutMs = UPDATE_LOCK_TIMEOUT_MS): Promise<boolean> {
  const staleAfterMs = normalizeLockTimeoutMs(timeoutMs);
  try {
    const existing = await lstat(lockPath);
    if (existing.isSymbolicLink() || !existing.isFile()) return false;
    if (Date.now() - existing.mtimeMs < staleAfterMs) return false;
    try {
      const recheck = await lstat(lockPath);
      if (recheck.isSymbolicLink() || !recheck.isFile()) return false;
      if (Date.now() - recheck.mtimeMs < staleAfterMs) return false;
      await unlink(lockPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") return false;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") return false;
  }

  try {
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, safeJsonStringify({ pid: process.pid, started_at: new Date().toISOString() }), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export async function releaseUpdateLock(lockPath = getUpdateLockPath()): Promise<void> {
  try {
    const lockStats = await lstat(lockPath);
    if (lockStats.isSymbolicLink() || !lockStats.isFile() || lockStats.size > MAX_UPDATE_LOCK_BYTES) return;
    const raw = await readFile(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as { pid?: number };
    if (parsed.pid === process.pid) await unlink(lockPath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") return;
  }
}

async function withUpdateLock<T>(fn: () => Promise<T>): Promise<T | "locked"> {
  if (!(await acquireUpdateLock())) return "locked";
  try {
    return await fn();
  } finally {
    await releaseUpdateLock();
  }
}

async function execFileText(command: string, args: string[], timeoutMs: number, cwd = homedir()): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: normalizeTimeoutMs(timeoutMs, 2500), windowsHide: true, cwd, maxBuffer: 128 * 1024 }, (error: any, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function getNpmGlobalPrefix(): Promise<string | null> {
  const result = await execFileText("npm", ["-g", "config", "get", "prefix"], 2500);
  return result.code === 0 ? safePathString(result.stdout) : null;
}

export async function detectInstallation(options: DetectInstallationOptions = {}): Promise<InstallationInfo> {
  const packageName = normalizePackageName(safeOption(options, "packageName"));
  const modulePath = safePathString(safeOption(options, "modulePath")) || fileURLToPath(import.meta.url);
  const executablePath = safePathString(safeOption(options, "executablePath")) || safePathString(process.argv[1]) || null;
  const packageRoot = findPackageRoot(modulePath, packageName);
  const npmPrefixOption = safeOption(options, "npmPrefix");
  const getNpmPrefixOption = safeOption(options, "getNpmPrefix");
  const getNpmPrefix = typeof getNpmPrefixOption === "function" ? getNpmPrefixOption as () => Promise<string | null> : getNpmGlobalPrefix;
  const npmPrefix = npmPrefixOption !== undefined
    ? safePathString(npmPrefixOption)
    : safePathString(await getNpmPrefix());
  const realPackageRoot = packageRoot ? safeRealpath(packageRoot) : null;
  const realExecutable = executablePath ? safeRealpath(executablePath) : null;
  const realPrefix = npmPrefix ? safeRealpath(npmPrefix) : null;

  if (packageRoot && isDevCheckout(packageRoot)) {
    return installationInfo({
      kind: "dev",
      packageName,
      packageRoot,
      executablePath,
      npmPrefix,
      localProjectRoot: packageRoot,
      canAutoUpdate: false,
      reason: "running from a source checkout",
    });
  }

  if (realPrefix && (
    (realPackageRoot && isInside(realPackageRoot, realPrefix)) ||
    (realExecutable && isInside(realExecutable, realPrefix))
  )) {
    return installationInfo({
      kind: "global",
      packageName,
      packageRoot,
      executablePath,
      npmPrefix,
      localProjectRoot: null,
      canAutoUpdate: true,
      reason: "package path is under npm global prefix",
    });
  }

  const localProjectRoot = packageRoot ? findLocalProjectRoot(packageRoot) : null;
  if (localProjectRoot) {
    return installationInfo({
      kind: "local",
      packageName,
      packageRoot,
      executablePath,
      npmPrefix,
      localProjectRoot,
      canAutoUpdate: true,
      reason: "package path is under a local node_modules directory",
    });
  }

  return installationInfo({
    kind: "unknown",
    packageName,
    packageRoot,
    executablePath,
    npmPrefix,
    localProjectRoot: null,
    canAutoUpdate: false,
    reason: "could not map this executable to a supported npm installation",
  });
}

export function assertMinimumVersion(options: { env?: NodeJS.ProcessEnv; currentVersion?: string; commandName?: string } = {}): void {
  if (safeOption(options, "commandName") === "update") return;
  const env = objectOption(safeOption(options, "env"), process.env);
  const minimum = normalizeVersion(safeOption(env, "SEEKCODE_MIN_VERSION"));
  if (!minimum) return;
  const current = normalizeVersion(safeOption(options, "currentVersion") || VERSION) || VERSION;
  if (compareVersions(current, minimum) >= 0) return;
  throw new Error(`Seek Code ${current} is below the required minimum version ${minimum}. Run: seek update`);
}

function installationInfo(input: Omit<InstallationInfo, "updateCommand">): InstallationInfo {
  return {
    ...input,
    updateCommand: updateCommandFor(input.kind, input.packageName),
  };
}

function updateCommandFor(kind: InstallationKind, packageName: string): string {
  const safePackageName = normalizePackageName(packageName);
  if (kind === "local") return `npm install ${safePackageName}@latest`;
  if (kind === "dev") return "git pull && npm install && npm run build";
  if (kind === "global") return `npm install -g ${safePackageName}@latest`;
  return `npm install -g ${safePackageName}@latest`;
}

function findPackageRoot(start: string, packageName: string): string | null {
  let current = dirname(resolve(start));
  while (true) {
    const pkgPath = join(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkgStats = statSync(pkgPath);
        if (!pkgStats.isFile() || pkgStats.size > MAX_PACKAGE_JSON_BYTES) {
          const parent = dirname(current);
          if (parent === current) return null;
          current = parent;
          continue;
        }
        const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: unknown };
        if (!parsed.name || parsed.name === packageName) return current;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isDevCheckout(packageRoot: string): boolean {
  const safeRoot = safePathString(packageRoot);
  return !!safeRoot && existsSync(join(safeRoot, "src", "index.ts")) && !safeRoot.split(sep).includes("node_modules");
}

function findLocalProjectRoot(packageRoot: string): string | null {
  const safeRoot = safePathString(packageRoot);
  if (!safeRoot) return null;
  const marker = `${sep}node_modules${sep}`;
  const index = safeRoot.lastIndexOf(marker);
  if (index < 0) return null;
  return safeRoot.slice(0, index);
}

function safeRealpath(path: string): string {
  const safePath = safePathString(path);
  if (!safePath) return "";
  try {
    return realpathSync(safePath);
  } catch {
    return resolve(safePath);
  }
}

function isInside(path: string, root: string): boolean {
  if (!path || !root) return false;
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
}

async function installPackage(command: string, args: string[], cwd: string, timeoutMs = MAX_UPDATE_TIMEOUT_MS): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd,
      detached: process.platform !== "win32",
    });
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let sigkillTimer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    };
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    timeoutTimer = setTimeout(() => {
      terminateInstallProcess(child);
      sigkillTimer = setTimeout(() => terminateInstallProcess(child, "SIGKILL"), INSTALL_TERMINATE_SIGKILL_MS);
      sigkillTimer.unref?.();
      done(installTimeoutCode(timeoutMs));
    }, normalizeTimeoutMs(timeoutMs, MAX_UPDATE_TIMEOUT_MS));
    timeoutTimer.unref?.();
    child.on("error", () => done(1));
    child.on("close", code => done(code ?? 1));
  });
}

function installTimeoutCode(timeoutMs: number): number {
  return 124;
}

async function withInstallTimeout(install: () => Promise<number>, timeoutMs: number): Promise<number> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      install(),
      new Promise<number>(resolve => {
        timer = setTimeout(() => resolve(installTimeoutCode(timeoutMs)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function installLatestWithNpm(packageName: string, installation?: InstallationInfo): Promise<number> {
  const safePackageName = normalizePackageName(packageName);
  const info = normalizeInstallationInfo(installation || await detectInstallation({ packageName: safePackageName }), safePackageName);
  const locked = await withUpdateLock(async () => {
    if (info.kind === "local" && info.localProjectRoot) {
      return installPackage("npm", ["install", `${safePackageName}@latest`], info.localProjectRoot);
    }
    if (info.kind === "global") {
      return installPackage("npm", ["install", "-g", `${safePackageName}@latest`], homedir());
    }
    return 2;
  });
  return locked === "locked" ? 3 : locked;
}

function terminateInstallProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid && Number.isSafeInteger(child.pid) && child.pid > 0 && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to direct child termination.
    }
  }
  try { child.kill(signal); } catch { /* ignore */ }
}

export async function prepareUpdateCheck(options: UpdateCheckOptions = {}): Promise<PreparedUpdateCheck> {
  const stdin = streamOption<TTYInput>(safeOption(options, "stdin"), process.stdin);
  const stdout = streamOption<TTYOutput>(safeOption(options, "stdout"), process.stdout);
  const packageName = normalizePackageName(safeOption(options, "packageName"));
  const currentVersion = normalizeVersion(safeOption(options, "currentVersion") || VERSION) || VERSION;
  if (!shouldCheckForUpdates(omitUndefined({ env: safeOption(options, "env") as NodeJS.ProcessEnv | undefined, stdin, stdout }))) {
    return { result: "disabled", packageName, currentVersion };
  }

  const timeoutMs = normalizeTimeoutMs(safeOption(options, "timeoutMs"), 2500);
  const fetchLatestOption = safeOption(options, "fetchLatestVersion");
  const fetchLatest = typeof fetchLatestOption === "function" ? fetchLatestOption as NonNullable<UpdateCheckOptions["fetchLatestVersion"]> : fetchLatestNpmVersion;
  const latestVersion = normalizeVersion(await fetchLatest(packageName, timeoutMs));
  if (!latestVersion) return { result: "current", packageName, currentVersion };
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { result: "current", packageName, currentVersion, latestVersion };
  }
  const detectInstallationOption = safeOption(options, "detectInstallation");
  const installLatestOption = safeOption(options, "installLatest");
  const installation = normalizeInstallationInfo(typeof detectInstallationOption === "function"
    ? await (detectInstallationOption as NonNullable<UpdateCheckOptions["detectInstallation"]>)()
    : await detectInstallation({ packageName }), packageName);
  if (!installation.canAutoUpdate && typeof installLatestOption !== "function") {
    return { result: "unsupported", packageName, currentVersion, latestVersion, installation };
  }
  return { result: "available", packageName, currentVersion, latestVersion, installation };
}

export async function promptForPreparedUpdate(
  prepared: PreparedUpdateCheck,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
  if (prepared.result !== "available") return prepared.result;

  const stdin = streamOption<TTYInput>(safeOption(options, "stdin"), process.stdin);
  const stdout = streamOption<TTYOutput>(safeOption(options, "stdout"), process.stdout);
  const packageName = prepared.packageName;
  const safePackageName = normalizePackageName(packageName);
  const currentVersion = normalizeVersion(prepared.currentVersion) || VERSION;
  const latestVersion = normalizeVersion(prepared.latestVersion) || currentVersion;
  const installation = prepared.installation!;
  stdout.write(`\n${p.warning(`Seek Code ${latestVersion} is available. Current version: ${currentVersion}.`)}\n`);
  stdout.write(`${p.dim(`Installation: ${installation.kind} (${displayText(installation.reason)}).`)}\n`);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const answer = (await questionOrNull(rl, stdin, `Update now with ${displayText(installation.updateCommand)}? [y/N] `) ?? "").trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      stdout.write(`${p.dim("Skipped update for now.")}\n`);
      return "skipped";
    }
  } finally {
    rl.close();
  }

  const installLatestOption = safeOption(options, "installLatest");
  const installLatest = typeof installLatestOption === "function" ? installLatestOption as NonNullable<UpdateCheckOptions["installLatest"]> : installLatestWithNpm;
  const code = await installLatest(safePackageName, installation);
  if (code === 0) {
    stdout.write(`${p.success(`Updated ${safePackageName}. Restart seek to use the new version.`)}\n`);
    return "updated";
  }
  if (code === 3) {
    stdout.write(`${p.warning("Another seek update is already in progress.")}\n`);
    return "locked";
  }
  if (code === 2) {
    stdout.write(`${p.warning(`Automatic update is not supported for this installation. Run manually: ${displayText(installation.updateCommand)}`)}\n`);
    return "unsupported";
  }
  stdout.write(`${p.warning(`Update failed. You can retry with: ${displayText(installation.updateCommand)}`)}\n`);
  return "failed";
}

export async function maybePromptForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  return promptForPreparedUpdate(await prepareUpdateCheck(options), options);
}

export async function runUpdateCommand(options: RunUpdateOptions = {}): Promise<UpdateCheckResult> {
  const stdout = streamOption<NodeJS.WritableStream>(safeOption(options, "stdout"), process.stdout);
  const stderr = streamOption<NodeJS.WritableStream>(safeOption(options, "stderr"), process.stderr);
  const packageName = normalizePackageName(safeOption(options, "packageName"));
  const currentVersion = normalizeVersion(safeOption(options, "currentVersion") || VERSION) || VERSION;
  const timeoutMs = normalizeTimeoutMs(safeOption(options, "timeoutMs"), 5000);
  const detectInstallationOption = safeOption(options, "detectInstallation");
  const installation = normalizeInstallationInfo(typeof detectInstallationOption === "function"
    ? await (detectInstallationOption as NonNullable<RunUpdateOptions["detectInstallation"]>)()
    : await detectInstallation({ packageName }), packageName);

  stdout.write(`Seek Code ${currentVersion}\n`);
  stdout.write(`Installation: ${displayText(installation.kind)}\n`);
  stdout.write(`Package root: ${displayText(installation.packageRoot || "(unknown)")}\n`);
  stdout.write(`Executable: ${displayText(installation.executablePath || "(unknown)")}\n`);
  stdout.write(`npm prefix: ${displayText(installation.npmPrefix || "(unknown)")}\n`);
  stdout.write(`Update command: ${displayText(installation.updateCommand)}\n`);
  stdout.write(`Reason: ${displayText(installation.reason)}\n`);
  if (safeOption(options, "diagnoseOnly")) return "current";

  const fetchLatestOption = safeOption(options, "fetchLatestVersion");
  const fetchLatest = typeof fetchLatestOption === "function" ? fetchLatestOption as NonNullable<RunUpdateOptions["fetchLatestVersion"]> : fetchLatestNpmVersion;
  const latestVersion = normalizeVersion(safeOption(options, "targetVersion")) || normalizeVersion(await fetchLatest(packageName, timeoutMs));
  if (!latestVersion) {
    stderr.write("Could not determine latest npm version.\n");
    return "failed";
  }
  stdout.write(`Latest: ${latestVersion}\n`);
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    stdout.write("Seek Code is already up to date.\n");
    return "current";
  }
  if (safeOption(options, "checkOnly")) {
    stdout.write(`Update available: ${currentVersion} -> ${latestVersion}\n`);
    return "available";
  }
  if (!installation.canAutoUpdate) {
    stderr.write(`Automatic update is not supported for ${displayText(installation.kind)} installs. Run: ${displayText(installation.updateCommand)}\n`);
    return "unsupported";
  }
  if (!safeOption(options, "yes")) {
    const stdin = streamOption<TTYInput>(safeOption(options, "stdin"), process.stdin);
    const promptStdout = streamOption<TTYOutput>(safeOption(options, "stdout"), process.stdout);
    if (safeOption(stdin, "isTTY") !== true || safeOption(promptStdout, "isTTY") !== true) {
      stderr.write(`Pass --yes to install non-interactively, or run manually: ${displayText(installation.updateCommand)}\n`);
      return "skipped";
    }
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    try {
      const answer = (await questionOrNull(rl, stdin, `Install ${packageName}@latest now? [y/N] `) ?? "").trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") return "skipped";
    } finally {
      rl.close();
    }
  }

  const locked = await withUpdateLock(async () => {
    const installPackageOption = safeOption(options, "installPackage");
    const install = typeof installPackageOption === "function"
      ? (command: string, args: string[], cwd: string) => (installPackageOption as NonNullable<RunUpdateOptions["installPackage"]>)(command, args, cwd, timeoutMs)
      : (command: string, args: string[], cwd: string) => installPackage(command, args, cwd, timeoutMs);
    const localProjectRoot = installation.localProjectRoot;
    if (installation.kind === "local" && localProjectRoot) {
      return withInstallTimeout(() => install("npm", ["install", `${packageName}@latest`], localProjectRoot), timeoutMs);
    }
    return withInstallTimeout(() => install("npm", ["install", "-g", `${packageName}@latest`], homedir()), timeoutMs);
  });
  if (locked === "locked") {
    stderr.write(`Another update is in progress (${getUpdateLockPath()}).\n`);
    return "locked";
  }
	  if (locked === 0) {
	    stdout.write(`Updated ${packageName}. Restart seek to use the new version.\n`);
	    return "updated";
	  }
	  if (locked === installTimeoutCode(timeoutMs)) {
	    stderr.write(`Update timed out after ${timeoutMs}ms. Retry manually with: ${displayText(installation.updateCommand)}\n`);
	    return "failed";
	  }
	  stderr.write(`Update failed. Retry manually with: ${displayText(installation.updateCommand)}\n`);
  return "failed";
}

function safePathString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(UPDATE_CONTROL_GLOBAL_RE, "").trim();
  return trimmed && trimmed.length <= MAX_PATH_CHARS ? trimmed : null;
}

function normalizeInstallationKind(value: unknown): InstallationKind {
  return value === "global" || value === "local" || value === "dev" || value === "unknown"
    ? value
    : "unknown";
}

function normalizeInstallationInfo(value: InstallationInfo, fallbackPackageName: string): InstallationInfo {
  const record = value && typeof value === "object" ? value : {} as InstallationInfo;
  const kind = normalizeInstallationKind(safeOption(record, "kind"));
  const packageName = normalizePackageName(safeOption(record, "packageName"), fallbackPackageName);
  const packageRoot = safePathString(safeOption(record, "packageRoot"));
  const executablePath = safePathString(safeOption(record, "executablePath"));
  const npmPrefix = safePathString(safeOption(record, "npmPrefix"));
  const localProjectRoot = kind === "local" ? safePathString(safeOption(record, "localProjectRoot")) : null;
  return {
    kind,
    packageName,
    packageRoot,
    executablePath,
    npmPrefix,
    localProjectRoot,
    canAutoUpdate: Boolean(safeOption(record, "canAutoUpdate")) && (kind === "global" || (kind === "local" && !!localProjectRoot)),
    reason: displayText(safeOption(record, "reason")),
    updateCommand: displayText(safeOption(record, "updateCommand") || updateCommandFor(kind, packageName)),
  };
}

function safeOption(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function objectOption<T extends object>(value: unknown, fallback: T): T | Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fallback;
}

function streamOption<T>(value: unknown, fallback: T): T {
  return value && typeof value === "object" ? value as T : fallback;
}
