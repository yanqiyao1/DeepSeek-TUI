import { describe, expect, it } from "vitest";

import { checkCommand } from "../src/tools/exec-policy.js";
import { getRegistry } from "../src/tools/registry.js";
import { PermissionLevel, type ToolDef } from "../src/tools/base.js";

function makeDeferredTool(name: string, searchHint = "schema helper"): ToolDef {
  return {
    name,
    description: `${name} helper`,
    searchHint,
    parameters: { type: "object", properties: {} },
    permission: PermissionLevel.ALWAYS_ALLOW,
    category: "test",
    parallelOk: true,
    deferLoading: true,
    execute: async () => "ok",
  };
}

describe("exec policy matrix", () => {
  it.each([
    "pwd -L",
    "echo -n hello",
    "printf %s hello",
    "ls -lah src",
    "ls --sort=time src",
    "cat --number README.md",
    "head --lines 10 README.md",
    "head -n10 README.md",
    "tail --bytes=64 README.md",
    "wc --lines README.md",
    "grep -n --context 2 needle README.md",
    "grep -C2 needle README.md",
    "egrep --ignore-case needle README.md",
    "fgrep --fixed-strings needle README.md",
    "rg --glob src/*.ts needle src",
    "rg -gsrc/*.ts needle src",
    "rg --threads 4 needle src",
    "find src -name *.ts -print",
    "find src -maxdepth -1 -print",
    "which --all node",
    "command -V node",
    "type -ap node",
    "git status --short",
    "git diff --name-only README.md",
    "git diff -U5 README.md",
    "git log --max-count 3 --stat",
    "git show --format=oneline HEAD",
    "git branch --list main",
    "git branch --contains HEAD",
    "git branch --contains HEAD --sort=-committerdate",
    "git branch --merged origin/main",
    "git branch --no-contains HEAD --all",
    "file --mime README.md",
    "stat --printf %s README.md",
    "realpath --relative-to src src/index.ts",
    "du --max-depth 2 src",
    "FOO=bar BAR=baz cat README.md",
    "cat README.md | grep needle",
    "cat README.md && wc README.md",
    "git -C . status --short",
    "git --git-dir=.git status --short",
    "git --work-tree=. status --short",
    "git branch --contains=HEAD",
    "git branch --merged=origin/main",
    "git branch --no-contains=HEAD",
  ])("allows read-only command %j", (command) => {
    expect(checkCommand(command)).toMatchObject({ decision: "allow" });
  });

  it.each([
    "node -e console.log(1)",
    "python -c print(1)",
    "ruby -e puts(1)",
    "php -r echo(1);",
    "bash script.sh",
    "sh -c ls",
    "npm test",
    "cat README.md > out.txt",
    "cat README.md >> out.txt",
    "cat README.md < in.txt",
    "cat README.md <<< here",
    "echo hi &",
    "cat $(pwd)",
    "cat ${HOME}/README.md",
    "cat `pwd`",
    "cat <(pwd)",
    "eval ls",
    "source ~/.bashrc",
    "find src -exec echo {} \\;",
    "find src -name",
    "find src -name -literal -print",
    "find src -name -- -print",
    "find src -unknown",
    "tail -f app.log",
    "tail --follow app.log",
    "tail --lines nope README.md",
    "git diff --output=out.patch",
    "git diff --ext-diff",
    "git branch feature",
    "git branch --merged main feature",
    "git branch --format",
    "command node",
    "type -z node",
    "which --bogus node",
    "rg --max-depth nope src",
    "grep --context nope needle README.md",
    "ls --color=always src",
    "du -d nope src",
    "head -n nope README.md",
    "printf hello\\",
    "cat 'README.md",
    "cat README.md |",
    "cat README.md ;",
    "cat README.md\nnpm test",
    "cat README.md\nmake build",
    "cat README.md\nnode -e console.log(1)",
  ])("asks for non-allowlisted or risky command %j", (command) => {
    expect(checkCommand(command)).toMatchObject({ decision: "ask" });
  });

  it.each([
    "rm -rf /",
    "rm -rf /*",
    "rm -fr /",
    "rm -r -f /",
    "rm --recursive --force /",
    "rm -rf -- /",
    "dd if=/dev/zero of=/dev/sda",
    "dd of=/dev/sda if=/dev/zero",
    "dd if=/dev/zero of=/dev/nvme0n1",
    "cat zero > /dev/sda",
    "cat zero > /dev/nvme0n1",
    "mkfs.ext4 /dev/sda1",
    "mkfs /dev/sda1",
    "chmod 777 script.sh",
    "chmod 0777 script.sh",
    "chmod 7777 script.sh",
    "chmod a+rwx script.sh",
    "chmod -R 777 build",
    "find . -delete",
    "find src -delete -print",
    "find . -fprint out.txt",
    "find . -fprintf out.txt %p",
    ":(){ :|:& };:",
  ])("denies destructive command %j", (command) => {
    expect(checkCommand(command)).toMatchObject({ decision: "deny" });
  });

  it("allows query-only git branch forms without mistaking them for branch creation", () => {
    expect(checkCommand("git branch --contains")).toMatchObject({ decision: "allow" });
    expect(checkCommand("git branch --contains HEAD")).toMatchObject({ decision: "allow" });
    expect(checkCommand("git branch --merged origin/main")).toMatchObject({ decision: "allow" });
  });
});

describe("context activation cap", () => {
  it("stops activating tools after eight matches instead of only truncating the return value", () => {
    const registry = getRegistry();
    registry.clear();

    for (let index = 0; index < 10; index++) {
      registry.register(makeDeferredTool(`schema_tool_${index}`));
    }

    const activated = registry.activateForContext("please inspect the schema helpers");

    expect(activated).toHaveLength(8);
    expect(registry.listActive().map(tool => tool.name)).toHaveLength(8);
  });
});
