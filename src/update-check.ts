import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { PACKAGE_NAME, VERSION } from "./version.js";
import { SEEKCODE_DIR, homeDir } from "./paths.js";
import { p } from "./ui/palette.js";
import { omitUndefined } from "./utils/object.js";

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
  installPackage?: (command: string, args: string[], cwd: string) => Promise<number>;
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

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function shouldCheckForUpdates(options: Pick<UpdateCheckOptions, "env" | "stdin" | "stdout"> = {}): boolean {
  const env = options.env || process.env;
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return false;
  if (isTruthyEnv(env.CI)) return false;
  if (isTruthyEnv(env.SEEKCODE_SKIP_UPDATE_CHECK)) return false;
  if (isTruthyEnv(env.NO_UPDATE_NOTIFIER)) return false;
  return true;
}

function parseVersionTuple(version: string): [number, number, number] | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
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
  return new Promise(resolve => {
    execFile("npm", ["view", packageName, "version", "--silent"], { timeout: timeoutMs, windowsHide: true, cwd: homedir() }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const latest = String(stdout || "").trim().split(/\s+/)[0];
      resolve(latest || null);
    });
  });
}

export function getUpdateLockPath(): string {
  return resolve(homeDir(), SEEKCODE_DIR, ".update.lock");
}

export async function acquireUpdateLock(lockPath = getUpdateLockPath(), timeoutMs = UPDATE_LOCK_TIMEOUT_MS): Promise<boolean> {
  try {
    const existing = await stat(lockPath);
    if (Date.now() - existing.mtimeMs < timeoutMs) return false;
    try {
      const recheck = await stat(lockPath);
      if (Date.now() - recheck.mtimeMs < timeoutMs) return false;
      await unlink(lockPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") return false;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") return false;
  }

  try {
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

export async function releaseUpdateLock(lockPath = getUpdateLockPath()): Promise<void> {
  try {
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
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, cwd }, (error: any, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function getNpmGlobalPrefix(): Promise<string | null> {
  const result = await execFileText("npm", ["-g", "config", "get", "prefix"], 2500);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

export async function detectInstallation(options: DetectInstallationOptions = {}): Promise<InstallationInfo> {
  const packageName = options.packageName || PACKAGE_NAME;
  const modulePath = options.modulePath || fileURLToPath(import.meta.url);
  const executablePath = options.executablePath || process.argv[1] || null;
  const packageRoot = findPackageRoot(modulePath, packageName);
  const npmPrefix = options.npmPrefix !== undefined
    ? options.npmPrefix
    : await (options.getNpmPrefix || getNpmGlobalPrefix)();
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
  if (options.commandName === "update") return;
  const env = options.env || process.env;
  const minimum = env.SEEKCODE_MIN_VERSION?.trim();
  if (!minimum) return;
  const current = options.currentVersion || VERSION;
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
  if (kind === "local") return `npm install ${packageName}@latest`;
  if (kind === "dev") return "git pull && npm install && npm run build";
  if (kind === "global") return `npm install -g ${packageName}@latest`;
  return `npm install -g ${packageName}@latest`;
}

function findPackageRoot(start: string, packageName: string): string | null {
  let current = dirname(resolve(start));
  while (true) {
    const pkgPath = join(current, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
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
  return existsSync(join(packageRoot, "src", "index.ts")) && !packageRoot.split(sep).includes("node_modules");
}

function findLocalProjectRoot(packageRoot: string): string | null {
  const marker = `${sep}node_modules${sep}`;
  const index = packageRoot.lastIndexOf(marker);
  if (index < 0) return null;
  return packageRoot.slice(0, index);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel));
}

async function installPackage(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: "inherit", cwd });
    child.on("error", () => resolve(1));
    child.on("close", code => resolve(code ?? 1));
  });
}

async function installLatestWithNpm(packageName: string, installation?: InstallationInfo): Promise<number> {
  const info = installation || await detectInstallation({ packageName });
  const locked = await withUpdateLock(async () => {
    if (info.kind === "local" && info.localProjectRoot) {
      return installPackage("npm", ["install", `${packageName}@latest`], info.localProjectRoot);
    }
    if (info.kind === "global") {
      return installPackage("npm", ["install", "-g", `${packageName}@latest`], homedir());
    }
    return 2;
  });
  return locked === "locked" ? 3 : locked;
}

export async function prepareUpdateCheck(options: UpdateCheckOptions = {}): Promise<PreparedUpdateCheck> {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const packageName = options.packageName || PACKAGE_NAME;
  const currentVersion = options.currentVersion || VERSION;
  if (!shouldCheckForUpdates(omitUndefined({ env: options.env, stdin, stdout }))) {
    return { result: "disabled", packageName, currentVersion };
  }

  const timeoutMs = options.timeoutMs ?? 2500;
  const fetchLatest = options.fetchLatestVersion || fetchLatestNpmVersion;
  const latestVersion = await fetchLatest(packageName, timeoutMs);
  if (!latestVersion) return { result: "current", packageName, currentVersion };
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return { result: "current", packageName, currentVersion, latestVersion };
  }
  const installation = options.detectInstallation
    ? await options.detectInstallation()
    : await detectInstallation({ packageName });
  if (!installation.canAutoUpdate && !options.installLatest) {
    return { result: "unsupported", packageName, currentVersion, latestVersion, installation };
  }
  return { result: "available", packageName, currentVersion, latestVersion, installation };
}

export async function promptForPreparedUpdate(
  prepared: PreparedUpdateCheck,
  options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
  if (prepared.result !== "available") return prepared.result;

  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const packageName = prepared.packageName;
  const currentVersion = prepared.currentVersion;
  const latestVersion = prepared.latestVersion!;
  const installation = prepared.installation!;
  stdout.write(`\n${p.warning(`Seek Code ${latestVersion} is available. Current version: ${currentVersion}.`)}\n`);
  stdout.write(`${p.dim(`Installation: ${installation.kind} (${installation.reason}).`)}\n`);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const answer = (await rl.question(`Update now with ${installation.updateCommand}? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      stdout.write(`${p.dim("Skipped update for now.")}\n`);
      return "skipped";
    }
  } finally {
    rl.close();
  }

  const installLatest = options.installLatest || installLatestWithNpm;
  const code = await installLatest(packageName, installation);
  if (code === 0) {
    stdout.write(`${p.success(`Updated ${packageName}. Restart seek to use the new version.`)}\n`);
    return "updated";
  }
  if (code === 3) {
    stdout.write(`${p.warning("Another seek update is already in progress.")}\n`);
    return "locked";
  }
  if (code === 2) {
    stdout.write(`${p.warning(`Automatic update is not supported for this installation. Run manually: ${installation.updateCommand}`)}\n`);
    return "unsupported";
  }
  stdout.write(`${p.warning(`Update failed. You can retry with: ${installation.updateCommand}`)}\n`);
  return "failed";
}

export async function maybePromptForUpdate(options: UpdateCheckOptions = {}): Promise<UpdateCheckResult> {
  return promptForPreparedUpdate(await prepareUpdateCheck(options), options);
}

export async function runUpdateCommand(options: RunUpdateOptions = {}): Promise<UpdateCheckResult> {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const packageName = options.packageName || PACKAGE_NAME;
  const currentVersion = options.currentVersion || VERSION;
  const timeoutMs = options.timeoutMs ?? 5000;
  const installation = options.detectInstallation
    ? await options.detectInstallation()
    : await detectInstallation({ packageName });

  stdout.write(`Seek Code ${currentVersion}\n`);
  stdout.write(`Installation: ${installation.kind}\n`);
  stdout.write(`Package root: ${installation.packageRoot || "(unknown)"}\n`);
  stdout.write(`Executable: ${installation.executablePath || "(unknown)"}\n`);
  stdout.write(`npm prefix: ${installation.npmPrefix || "(unknown)"}\n`);
  stdout.write(`Update command: ${installation.updateCommand}\n`);
  stdout.write(`Reason: ${installation.reason}\n`);
  if (options.diagnoseOnly) return "current";

  const fetchLatest = options.fetchLatestVersion || fetchLatestNpmVersion;
  const latestVersion = options.targetVersion || await fetchLatest(packageName, timeoutMs);
  if (!latestVersion) {
    stderr.write("Could not determine latest npm version.\n");
    return "failed";
  }
  stdout.write(`Latest: ${latestVersion}\n`);
  if (compareVersions(latestVersion, currentVersion) <= 0) {
    stdout.write("Seek Code is already up to date.\n");
    return "current";
  }
  if (options.checkOnly) {
    stdout.write(`Update available: ${currentVersion} -> ${latestVersion}\n`);
    return "available";
  }
  if (!installation.canAutoUpdate) {
    stderr.write(`Automatic update is not supported for ${installation.kind} installs. Run: ${installation.updateCommand}\n`);
    return "unsupported";
  }
  if (!options.yes) {
    const stdin = options.stdin || process.stdin;
    const promptStdout = options.stdout || process.stdout;
    if (!stdin.isTTY || !promptStdout.isTTY) {
      stderr.write(`Pass --yes to install non-interactively, or run manually: ${installation.updateCommand}\n`);
      return "skipped";
    }
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    try {
      const answer = (await rl.question(`Install ${packageName}@latest now? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") return "skipped";
    } finally {
      rl.close();
    }
  }

  const locked = await withUpdateLock(async () => {
    const install = options.installPackage || installPackage;
    if (installation.kind === "local" && installation.localProjectRoot) {
      return install("npm", ["install", `${packageName}@latest`], installation.localProjectRoot);
    }
    return install("npm", ["install", "-g", `${packageName}@latest`], homedir());
  });
  if (locked === "locked") {
    stderr.write(`Another update is in progress (${getUpdateLockPath()}).\n`);
    return "locked";
  }
  if (locked === 0) {
    stdout.write(`Updated ${packageName}. Restart seek to use the new version.\n`);
    return "updated";
  }
  stderr.write(`Update failed. Retry manually with: ${installation.updateCommand}\n`);
  return "failed";
}
