/** Side-git workspace snapshots — separate bare repo in .seekcode/side-git/. */

import { mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { SEEKCODE_DIR } from "../paths.js";

export class SideGit {
  private workspace: string;
  private gitDir: string;
  private initialized = false;

  constructor(workspace = ".") {
    this.workspace = resolve(workspace);
    this.gitDir = join(this.workspace, SEEKCODE_DIR, "side-git");
  }

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    mkdirSync(this.gitDir, { recursive: true });
    if (existsSync(join(this.gitDir, "HEAD"))) { this.initialized = true; return true; }
    try {
      this.run("init");
      this.run("config", "user.email", "seek-code@local");
      this.run("config", "user.name", "Seek Code");
      this.initialized = true;
      return true;
    } catch { return false; }
  }

  async snapshotPre(turnId: number | string): Promise<string | null> {
    if (!this.initialized) await this.init();
    return this.snapshot(`pre-turn-${turnId}`);
  }

  async snapshotPost(turnId: number | string): Promise<string | null> {
    if (!this.initialized) await this.init();
    return this.snapshot(`post-turn-${turnId}`);
  }

  async listSnapshots(n = 20): Promise<Array<{ hash: string; message: string; date: string }>> {
    if (!this.initialized) return [];
    try {
      const out = this.run("log", `-${n}`, "--format=%H%x00%s%x00%ai");
      return out.trim().split("\n").filter(Boolean).map(line => {
        const [hash = "", message = "", date = ""] = line.split("\0");
        return { hash, message, date };
      });
    } catch { return []; }
  }

  async restoreTo(commitHash: string): Promise<boolean> {
    if (!this.initialized) return false;
    try {
      this.run("restore", "--source", commitHash, "--worktree", "--staged", "--", ".", ":(exclude).seekcode/side-git", ":(exclude).deepseek/side-git");
      this.run("clean", "-fd", "-e", ".seekcode/side-git", "-e", ".deepseek/side-git", "--", ".");
      this.removeIgnoredUntrackedFiles();
      return true;
    }
    catch { return false; }
  }

  private async snapshot(message: string): Promise<string | null> {
    try {
      this.run("add", "-A", "--", ".", ":(exclude).seekcode/side-git", ":(exclude).deepseek/side-git");
      const status = this.run("status", "--porcelain", "--", ".", ":(exclude).seekcode/side-git", ":(exclude).deepseek/side-git");
      const commitArgs = ["commit", "-m", message];
      if (!status.trim()) commitArgs.push("--allow-empty");
      return this.run(...commitArgs).trim();
    } catch { return null; }
  }

  private run(...args: string[]): string {
    const result = spawnSync("git", [`--git-dir=${this.gitDir}`, `--work-tree=${this.workspace}`, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git exited with ${result.status}`);
    return result.stdout;
  }

  private removeIgnoredUntrackedFiles(): void {
    const output = this.run("ls-files", "-o", "-i", "--exclude-standard", "-z", "--", ".");
    for (const relPath of output.split("\0").filter(Boolean)) {
      const normalized = relPath.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!normalized || isProtectedMetadataPath(normalized)) continue;
      const target = resolve(this.workspace, relPath);
      const rel = relative(this.workspace, target);
      if (!rel || rel.startsWith("..") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) continue;
      rmSync(target, { recursive: true, force: true });
    }
  }
}

function isProtectedMetadataPath(relPath: string): boolean {
  return relPath === SEEKCODE_DIR
    || relPath.startsWith(`${SEEKCODE_DIR}/`)
    || relPath === ".deepseek"
    || relPath.startsWith(".deepseek/");
}
