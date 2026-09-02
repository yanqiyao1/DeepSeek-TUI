import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireUpdateLock,
  assertMinimumVersion,
  compareVersions,
  detectInstallation,
  getUpdateLockPath,
  maybePromptForUpdate,
  prepareUpdateCheck,
  promptForPreparedUpdate,
  releaseUpdateLock,
  runUpdateCommand,
  shouldCheckForUpdates,
  type InstallationInfo,
} from "../src/update-check.js";

const repoRoot = resolve(".");

let tmp: string;
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "seek-code-update-"));
  oldHome = process.env.HOME;
  process.env.HOME = join(tmp, "home");
  mkdirSync(process.env.HOME, { recursive: true });
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(tmp, { recursive: true, force: true });
});

function ttyInput(text: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = new PassThrough() as NodeJS.ReadableStream & { isTTY?: boolean };
  stream.isTTY = true;
  stream.end(text);
  return stream;
}

function ttyOutput(): NodeJS.WritableStream & { isTTY?: boolean; chunks: string[] } {
  const stream = new PassThrough() as NodeJS.WritableStream & { isTTY?: boolean; chunks: string[] };
  stream.isTTY = true;
  stream.chunks = [];
  stream.on("data", chunk => stream.chunks.push(String(chunk)));
  return stream;
}

describe("update checker", () => {
  it("compares package versions without a hardcoded current version", () => {
    expect(compareVersions("0.1.4", "0.1.3")).toBe(1);
    expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareVersions("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("does not check in non-interactive or CI contexts", () => {
    const stdin = { isTTY: false } as NodeJS.ReadableStream & { isTTY?: boolean };
    const stdout = { isTTY: true } as NodeJS.WritableStream & { isTTY?: boolean };

    expect(shouldCheckForUpdates({ stdin, stdout })).toBe(false);
    expect(shouldCheckForUpdates({ stdin: { isTTY: true } as any, stdout, env: { CI: "1" } as any })).toBe(false);
    expect(shouldCheckForUpdates({ stdin: { isTTY: true } as any, stdout, env: { SEEKCODE_SKIP_UPDATE_CHECK: "1" } as any })).toBe(false);
  });

  it("handles hostile update option getters without leaking exceptions", async () => {
    const stdout = ttyOutput();
    const stderr = ttyOutput();
    const throwingEnv = { get CI() { throw new Error("env getter should not leak"); } };
    const throwingCheckOptions = {
      get env() { throw new Error("env option getter should not leak"); },
      get stdin() { throw new Error("stdin getter should not leak"); },
      get stdout() { throw new Error("stdout getter should not leak"); },
    };
    const throwingDetectOptions = {
      get packageName() { throw new Error("package getter should not leak"); },
      get modulePath() { throw new Error("module getter should not leak"); },
      get executablePath() { throw new Error("executable getter should not leak"); },
      get npmPrefix() { throw new Error("prefix getter should not leak"); },
      get getNpmPrefix() { throw new Error("get prefix getter should not leak"); },
    };
    const hostileInstallation = {
      get kind() { throw new Error("kind getter should not leak"); },
      get packageName() { throw new Error("packageName getter should not leak"); },
      get packageRoot() { throw new Error("packageRoot getter should not leak"); },
      get executablePath() { throw new Error("executablePath getter should not leak"); },
      get npmPrefix() { throw new Error("npmPrefix getter should not leak"); },
      get localProjectRoot() { throw new Error("localProjectRoot getter should not leak"); },
      get canAutoUpdate() { throw new Error("canAutoUpdate getter should not leak"); },
      get reason() { throw new Error("reason getter should not leak"); },
      get updateCommand() { throw new Error("updateCommand getter should not leak"); },
    };

    expect(shouldCheckForUpdates({ env: throwingEnv as any, stdin: { isTTY: true } as any, stdout: { isTTY: true } as any })).toBe(true);
    expect(shouldCheckForUpdates(throwingCheckOptions as any)).toBe(false);
    await expect(detectInstallation(throwingDetectOptions as any)).resolves.toMatchObject({ packageName: "seekcode" });
    await expect(prepareUpdateCheck({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput(""),
      stdout,
      fetchLatestVersion: async () => "0.1.4",
      detectInstallation: async () => hostileInstallation as any,
    })).resolves.toMatchObject({ result: "unsupported" });
    await expect(runUpdateCommand({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      yes: true,
      stdout,
      stderr,
      detectInstallation: async () => hostileInstallation as any,
    })).resolves.toBe("unsupported");
  });

  it("sanitizes package names, versions, and update timeouts before checking", async () => {
    const output = ttyOutput();
    let seenPackage = "";
    let seenTimeout = 0;
    const prepared = await prepareUpdateCheck({
      currentVersion: " 0.1.3 ",
      packageName: "bad package;rm -rf /",
      timeoutMs: Number.NaN,
      stdin: ttyInput(""),
      stdout: output,
      fetchLatestVersion: async (packageName, timeoutMs) => {
        seenPackage = packageName;
        seenTimeout = timeoutMs;
        return " 0.1.4 ";
      },
      detectInstallation: async () => ({
        kind: "global",
        packageName: "seekcode",
        packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
        executablePath: join(tmp, "prefix", "bin", "seek"),
        npmPrefix: join(tmp, "prefix"),
        localProjectRoot: null,
        updateCommand: "npm install -g seekcode@latest",
        canAutoUpdate: true,
        reason: "test",
      }),
    });

    expect(seenPackage).toBe("seekcode");
    expect(seenTimeout).toBe(2500);
    expect(prepared).toMatchObject({ result: "available", packageName: "seekcode", currentVersion: "0.1.3", latestVersion: "0.1.4" });
  });

  it("treats malformed latest versions as current instead of prompting", async () => {
    const result = await prepareUpdateCheck({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput(""),
      stdout: ttyOutput(),
      fetchLatestVersion: async () => "999.0.0;postinstall",
    });

    expect(result.result).toBe("current");
    expect(result).not.toHaveProperty("latestVersion");
  });

  it("rejects semver versions with empty or leading-zero identifiers", async () => {
    expect(compareVersions("1.0.0-01", "1.0.0")).toBe(0);
    const result = await prepareUpdateCheck({
      currentVersion: "1.0.0",
      packageName: "seekcode",
      stdin: ttyInput(""),
      stdout: ttyOutput(),
      fetchLatestVersion: async () => "1.0.0-",
    });

    expect(result.result).toBe("current");
    expect(result).not.toHaveProperty("latestVersion");
  });

  it("recognizes prerelease versions with build metadata", async () => {
    const result = await prepareUpdateCheck({
      currentVersion: "1.0.0-beta+build.1",
      packageName: "seekcode",
      stdin: ttyInput(""),
      stdout: ttyOutput(),
      fetchLatestVersion: async () => "1.0.0+build.2",
      detectInstallation: async () => ({
        kind: "global",
        packageName: "seekcode",
        packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
        executablePath: join(tmp, "prefix", "bin", "seek"),
        npmPrefix: join(tmp, "prefix"),
        localProjectRoot: null,
        updateCommand: "npm install -g seekcode@latest",
        canAutoUpdate: true,
        reason: "test",
      }),
    });

    expect(result).toMatchObject({ result: "available", currentVersion: "1.0.0-beta+build.1", latestVersion: "1.0.0+build.2" });
  });

  it("prompts and runs npm install only when the user accepts", async () => {
    const output = ttyOutput();
    const installs: string[] = [];
    const result = await maybePromptForUpdate({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput("y\n"),
      stdout: output,
      fetchLatestVersion: async () => "0.1.4",
      installLatest: async packageName => {
        installs.push(packageName);
        return 0;
      },
    });

    expect(result).toBe("updated");
    expect(installs).toEqual(["seekcode"]);
    expect(output.chunks.join("")).toContain("0.1.4");
  });

  it("keeps update prompt display text on grapheme boundaries", async () => {
    const output = ttyOutput();
    const family = "👨‍👩‍👧‍👦";
    const result = await maybePromptForUpdate({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput("\n"),
      stdout: output,
      fetchLatestVersion: async () => "0.1.4",
      detectInstallation: async () => ({
        kind: "global",
        packageName: "seekcode",
        packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
        executablePath: join(tmp, "prefix", "bin", "seek"),
        npmPrefix: join(tmp, "prefix"),
        localProjectRoot: null,
        canAutoUpdate: true,
        reason: `${"r".repeat(299)}${family}`,
        updateCommand: `${"u".repeat(299)}${family}`,
      }),
      installLatest: async () => 0,
    });
    const rendered = output.chunks.join("");

    expect(result).toBe("skipped");
    expect(rendered).not.toContain("\u200d");
    expect(hasUnpairedSurrogate(rendered)).toBe(false);
  });

  it("lets the user skip an available update", async () => {
    const result = await maybePromptForUpdate({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput("\n"),
      stdout: ttyOutput(),
      fetchLatestVersion: async () => "0.1.4",
      installLatest: async () => {
        throw new Error("install should not run");
      },
    });

    expect(result).toBe("skipped");
  });

  it("treats closed update prompt stdin as a skipped update", async () => {
    const output = ttyOutput();
    const stdin = ttyInput("");
    const installs: string[] = [];

    const result = await maybePromptForUpdate({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin,
      stdout: output,
      fetchLatestVersion: async () => "0.1.4",
      installLatest: async packageName => {
        installs.push(packageName);
        return 0;
      },
    });

    expect(result).toBe("skipped");
    expect(installs).toEqual([]);
    expect(output.chunks.join("")).toContain("Skipped update for now");
  });

  it("prepares update checks without prompting until the prepared result is consumed", async () => {
    const output = ttyOutput();
    const installs: string[] = [];
    const installation: InstallationInfo = {
      kind: "global",
      packageName: "seekcode",
      packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
      executablePath: join(tmp, "prefix", "bin", "seek"),
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: null,
      updateCommand: "npm install -g seekcode@latest",
      canAutoUpdate: true,
      reason: "test global install",
    };

    const prepared = await prepareUpdateCheck({
      currentVersion: "0.1.3",
      packageName: "seekcode",
      stdin: ttyInput(""),
      stdout: output,
      fetchLatestVersion: async () => "0.1.4",
      detectInstallation: async () => installation,
    });

    expect(prepared).toMatchObject({ result: "available", latestVersion: "0.1.4" });
    expect(output.chunks.join("")).toBe("");

    const result = await promptForPreparedUpdate(prepared, {
      stdin: ttyInput("y\n"),
      stdout: output,
      installLatest: async packageName => {
        installs.push(packageName);
        return 0;
      },
    });

    expect(result).toBe("updated");
    expect(installs).toEqual(["seekcode"]);
    expect(output.chunks.join("")).toContain("0.1.4");
  });

  it("detects source checkout installs as dev installs", async () => {
    const info = await detectInstallation({
      modulePath: join(repoRoot, "src", "update-check.ts"),
      executablePath: join(repoRoot, "src", "index.ts"),
      npmPrefix: join(tmp, "npm-prefix"),
    });

    expect(info.kind).toBe("dev");
    expect(info.canAutoUpdate).toBe(false);
    expect(info.updateCommand).toContain("npm run build");
  });

  it("runs local npm updates from the owning project root", async () => {
    const projectRoot = join(tmp, "consumer");
    const info: InstallationInfo = {
      kind: "local",
      packageName: "seekcode",
      packageRoot: join(projectRoot, "node_modules", "seekcode"),
      executablePath: join(projectRoot, "node_modules", ".bin", "seek"),
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: projectRoot,
      updateCommand: "npm install seekcode@latest",
      canAutoUpdate: true,
      reason: "test local install",
    };
    const installs: Array<{ command: string; args: string[]; cwd: string }> = [];

    const result = await runUpdateCommand({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      packageName: "seekcode",
      yes: true,
      stdout: ttyOutput(),
      stderr: ttyOutput(),
      detectInstallation: async () => info,
      installPackage: async (command, args, cwd) => {
        installs.push({ command, args, cwd });
        return 0;
      },
    });

    expect(result).toBe("updated");
    expect(installs).toEqual([{ command: "npm", args: ["install", "seekcode@latest"], cwd: projectRoot }]);
  });

  it("treats closed manual update confirmation stdin as skipped without installing", async () => {
    const output = ttyOutput();
    const stderr = ttyOutput();
    const installs: unknown[] = [];
    const info: InstallationInfo = {
      kind: "global",
      packageName: "seekcode",
      packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
      executablePath: join(tmp, "prefix", "bin", "seek"),
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: null,
      updateCommand: "npm install -g seekcode@latest",
      canAutoUpdate: true,
      reason: "test global install",
    };

    const result = await runUpdateCommand({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      packageName: "seekcode",
      stdin: ttyInput(""),
      stdout: output,
      stderr,
      detectInstallation: async () => info,
      installPackage: async (...args) => {
        installs.push(args);
        return 0;
      },
    });

    expect(result).toBe("skipped");
    expect(installs).toEqual([]);
    expect(stderr.chunks.join("")).toBe("");
  });

  it("sanitizes runUpdateCommand target versions and diagnostic output", async () => {
    const stdout = ttyOutput();
    const stderr = ttyOutput();
    const installs: Array<{ command: string; args: string[]; cwd: string }> = [];
    const info: InstallationInfo = {
      kind: "global",
      packageName: "seekcode",
      packageRoot: `pkg\0root\nnext`,
      executablePath: `bin\0seek\rnext`,
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: null,
      updateCommand: "npm install -g seekcode@latest\n\u001b[31mrm -rf /",
      canAutoUpdate: true,
      reason: "global\ninstall",
    };

    const result = await runUpdateCommand({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4\nignored",
      packageName: "bad package",
      yes: true,
      stdout,
      stderr,
      detectInstallation: async () => info,
      installPackage: async (command, args, cwd) => {
        installs.push({ command, args, cwd });
        return 0;
      },
    });

    expect(result).toBe("updated");
    expect(installs).toEqual([{ command: "npm", args: ["install", "-g", "seekcode@latest"], cwd: expect.any(String) }]);
    expect(stdout.chunks.join("")).not.toContain("\0");
    expect(stdout.chunks.join("")).not.toContain("\u001b");
    expect(stdout.chunks.join("")).not.toContain("\nrm -rf /");
  });

  it("bounds update lock and package discovery reads", async () => {
    const lockPath = getUpdateLockPath();
    mkdirSync(join(process.env.HOME!, ".seekcode"), { recursive: true });
    writeFileSync(lockPath, "x".repeat(70_000));

    await releaseUpdateLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    const project = join(tmp, "consumer");
    const packageRoot = join(project, "node_modules", "seekcode");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), " ".repeat(270_000));

    const info = await detectInstallation({
      modulePath: join(packageRoot, "dist", "index.js"),
      executablePath: `${join(packageRoot, "bin", "seek")}\u0000bad`,
      npmPrefix: "\u001b[31m" + join(tmp, "prefix"),
      getNpmPrefix: async () => `${join(tmp, "prefix")}\u0000ignored`,
    });

    expect(info.kind).toBe("unknown");
    expect(info.packageRoot).toBeNull();
    expect(info.executablePath).not.toContain("\u0000");
    expect(info.npmPrefix).not.toContain("\u001b");
  });

  it("does not read or remove symlinked update lock files", async () => {
    const lockPath = getUpdateLockPath();
    const outside = join(tmp, "outside-lock.json");
    mkdirSync(join(process.env.HOME!, ".seekcode"), { recursive: true });
    writeFileSync(outside, JSON.stringify({ pid: process.pid }), "utf-8");
    symlinkSync(outside, lockPath);

    await releaseUpdateLock(lockPath);
    const acquired = await acquireUpdateLock(lockPath, 1);

    expect(acquired).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("does not create update locks through a symlinked lock directory", async () => {
    const lockPath = getUpdateLockPath();
    const outsideDir = join(tmp, "outside-lock-dir");
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(process.env.HOME!, ".seekcode"), "dir");

    const acquired = await acquireUpdateLock(lockPath, 1);

    expect(acquired).toBe(false);
    expect(existsSync(join(outsideDir, ".update.lock"))).toBe(false);
  });

  it("ignores malformed minimum version env values", () => {
    expect(() => assertMinimumVersion({
      currentVersion: "0.1.0",
      env: { SEEKCODE_MIN_VERSION: "999.0.0\nbad" } as any,
    })).not.toThrow();
  });

  it("uses ~/.seekcode/.update.lock to prevent concurrent updates", async () => {
    const lockPath = getUpdateLockPath();
    mkdirSync(join(process.env.HOME!, ".seekcode"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 12345, started_at: new Date().toISOString() }));
    const installs: unknown[] = [];
    const info: InstallationInfo = {
      kind: "global",
      packageName: "seekcode",
      packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
      executablePath: join(tmp, "prefix", "bin", "seek"),
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: null,
      updateCommand: "npm install -g seekcode@latest",
      canAutoUpdate: true,
      reason: "test global install",
    };

    const result = await runUpdateCommand({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      packageName: "seekcode",
      yes: true,
      stdout: ttyOutput(),
      stderr: ttyOutput(),
      detectInstallation: async () => info,
      installPackage: async (...args) => {
        installs.push(args);
        return 0;
      },
    });

    expect(result).toBe("locked");
    expect(installs).toEqual([]);
  });

  it("times out stalled update installs instead of waiting forever", async () => {
    const stdout = ttyOutput();
    const stderr = ttyOutput();
    const info: InstallationInfo = {
      kind: "global",
      packageName: "seekcode",
      packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
      executablePath: join(tmp, "prefix", "bin", "seek"),
      npmPrefix: join(tmp, "prefix"),
      localProjectRoot: null,
      updateCommand: "npm install -g seekcode@latest",
      canAutoUpdate: true,
      reason: "test global install",
    };

    const result = await runUpdateCommand({
      currentVersion: "0.1.3",
      targetVersion: "0.1.4",
      packageName: "seekcode",
      timeoutMs: 1,
      yes: true,
      stdout,
      stderr,
      detectInstallation: async () => info,
      installPackage: async () => new Promise<number>(() => undefined),
    });

    expect(result).toBe("failed");
    expect(stderr.chunks.join("")).toContain("timed out");
  });

  it("force-kills an update installer that ignores SIGTERM", async () => {
    const bin = join(tmp, "bin");
    const pidFile = join(tmp, "installer.pid");
    mkdirSync(bin, { recursive: true });
    const fakeNpm = join(bin, "npm");
    writeFileSync(fakeNpm, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`, { encoding: "utf-8", mode: 0o755 });
    chmodSync(fakeNpm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath || ""}`;
    try {
      const info: InstallationInfo = {
        kind: "global",
        packageName: "seekcode",
        packageRoot: join(tmp, "prefix", "lib", "node_modules", "seekcode"),
        executablePath: join(tmp, "prefix", "bin", "seek"),
        npmPrefix: join(tmp, "prefix"),
        localProjectRoot: null,
        updateCommand: "npm install -g seekcode@latest",
        canAutoUpdate: true,
        reason: "test global install",
      };
      const result = await runUpdateCommand({
        currentVersion: "0.1.3",
        targetVersion: "0.1.4",
        packageName: "seekcode",
        timeoutMs: 100,
        yes: true,
        stdout: ttyOutput(),
        stderr: ttyOutput(),
        detectInstallation: async () => info,
      });

      expect(result).toBe("failed");
      await waitFor(() => {
        if (!existsSync(pidFile)) return false;
        const pid = Number(readFileSync(pidFile, "utf-8"));
        try {
          process.kill(pid, 0);
          const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" }).trim();
          return stat.startsWith("Z");
        } catch {
          return true;
        }
      }, 2_000);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("enforces minimum version gates except for the update command", () => {
    expect(() => assertMinimumVersion({
      currentVersion: "0.1.0",
      env: { SEEKCODE_MIN_VERSION: "0.2.0" } as any,
    })).toThrow(/seek update/i);
    expect(() => assertMinimumVersion({
      currentVersion: "0.1.0",
      commandName: "update",
      env: { SEEKCODE_MIN_VERSION: "0.2.0" } as any,
    })).not.toThrow();
  });
});

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}
