import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const updateScript = join(repoRoot, "update.sh");

describe("release workflow", () => {
  it("does not embed npm credentials in the release script", () => {
    const script = readFileSync(updateScript, "utf-8");

    expect(script).not.toMatch(/npm_[A-Za-z0-9]/);
    expect(script).not.toContain("export NPM_TOKEN=");
    expect(script).toContain("SEEKCODE_RELEASE_PUBLISH=1");
  });

  it("dry-runs a dynamic version, commit, tag, push, and GitHub release without mutating the repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seekcode-release-"));
    try {
      cpSync(updateScript, join(tmp, "update.sh"));
      chmodSync(join(tmp, "update.sh"), 0o755);
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "1.2.3" }));
      writeFileSync(join(tmp, "package-lock.json"), "{}\n");
      mkdirSync(join(tmp, "bin"));
      const calls = join(tmp, "calls.log");
      writeStub(join(tmp, "bin", "npm"), calls, "test");
      writeStub(join(tmp, "bin", "git"), calls, "git");
      writeStub(join(tmp, "bin", "gh"), calls, "gh");

      const output = execFileSync("./update.sh", ["patch", "stability fixes"], {
        cwd: tmp,
        env: {
          ...process.env,
          PATH: `${join(tmp, "bin")}:${process.env.PATH ?? ""}`,
          SEEKCODE_RELEASE_DRY_RUN: "1",
        },
        encoding: "utf-8",
      });
      const callsText = readFileSync(calls, "utf-8");

      expect(output).toContain("Skipping npm publish");
      expect(output).toContain("git+ add+ .");
      expect(output).toContain("git+ commit+ -m+ release:\\ v1.2.4\\ -\\ stability\\ fixes");
      expect(output).toContain("git+ tag+ -a+ v1.2.4");
      expect(output).toContain("gh+ release+ create+ v1.2.4+ --title+ v1.2.4+ --notes+ stability\\ fixes");
      expect(callsText).toContain("npm test");
      expect(callsText).not.toContain("npm publish");
      expect(callsText).not.toContain("gh auth status");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("checks GitHub auth before mutating a real release", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seekcode-release-"));
    try {
      cpSync(updateScript, join(tmp, "update.sh"));
      chmodSync(join(tmp, "update.sh"), 0o755);
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "1.2.3" }));
      writeFileSync(join(tmp, "package-lock.json"), "{}\n");
      mkdirSync(join(tmp, "bin"));
      const calls = join(tmp, "calls.log");
      writeStub(join(tmp, "bin", "npm"), calls, "test");
      writeStub(join(tmp, "bin", "git"), calls, "git");
      writeStub(join(tmp, "bin", "gh"), calls, "gh-auth-fails");
      const env = {
        ...process.env,
        PATH: `${join(tmp, "bin")}:${process.env.PATH ?? ""}`,
      };
      delete env.SEEKCODE_RELEASE_DRY_RUN;

      expect(() => execFileSync("./update.sh", ["patch", "stability fixes"], {
        cwd: tmp,
        env,
        encoding: "utf-8",
        stdio: "pipe",
      })).toThrow();
      const callsText = readFileSync(calls, "utf-8");

      expect(callsText).toContain("npm test");
      expect(callsText).toContain("gh auth status");
      expect(callsText).not.toContain("npm version");
      expect(callsText).not.toContain("git commit");
      expect(callsText).not.toContain("npm publish");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function writeStub(path: string, calls: string, kind: "test" | "git" | "gh" | "gh-auth-fails"): void {
  const body = kind === "test"
    ? [
      "#!/usr/bin/env bash",
      `printf 'npm %s\\n' \"$*\" >> ${JSON.stringify(calls)}`,
      "if [[ \"$1\" == \"version\" ]]; then echo v1.2.4; fi",
      "if [[ \"$1\" == \"whoami\" ]]; then echo tester; fi",
      "exit 0",
    ]
    : kind === "git"
      ? [
        "#!/usr/bin/env bash",
        `printf 'git %s\\n' \"$*\" >> ${JSON.stringify(calls)}`,
        "case \"$*\" in",
        "  'branch --show-current') echo main ;;",
        "  'status --porcelain') echo ' M src/file.ts' ;;",
        "  rev-parse*) exit 1 ;;",
        "  ls-remote*) exit 2 ;;",
        "esac",
        "exit 0",
      ]
      : [
        "#!/usr/bin/env bash",
        `printf 'gh %s\\n' \"$*\" >> ${JSON.stringify(calls)}`,
        "if [[ \"$*\" == \"auth status\" ]]; then",
        kind === "gh-auth-fails" ? "  exit 1" : "  exit 0",
        "fi",
        "exit 0",
      ];
  writeFileSync(path, body.join("\n") + "\n");
  chmodSync(path, 0o755);
}
