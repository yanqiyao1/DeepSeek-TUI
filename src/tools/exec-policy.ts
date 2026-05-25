/** Shell execution policy.
 *
 * The policy is intentionally conservative: only commands that can be
 * validated as read-only are auto-allowed. Code execution, shell expansion,
 * redirection, unknown flags, and unknown commands fall back to ask.
 */

import { basename } from "node:path";

export type Decision = "allow" | "deny" | "ask";

interface BaseRule {
  decision: Decision;
  justification?: string;
}

interface ExactRule extends BaseRule {
  type: "exact";
  command: string;
}

interface PrefixRule extends BaseRule {
  type: "prefix";
  prefix: string[];
}

interface RegexRule extends BaseRule {
  type: "regex";
  pattern: string;
}

export type Rule = ExactRule | PrefixRule | RegexRule;

interface PolicyResult {
  decision: Decision;
  justification: string;
}

interface Token {
  kind: "word" | "operator" | "redirect";
  value: string;
}

interface ParseResult {
  tokens: Token[];
  error?: string;
}

type FlagArgType = "none" | "string" | "number";

interface FlagSpec {
  none?: string[];
  value?: Record<string, FlagArgType>;
  shortNone?: string;
  shortValue?: Record<string, FlagArgType>;
  allowNumericShort?: boolean;
  dangerous?: string[];
}

const DEFAULT_RULES: Rule[] = [
  { type: "prefix", prefix: ["rm", "-rf", "/"], decision: "deny", justification: "recursive root deletion" },
  { type: "regex", pattern: "\\brm\\s+(?=[^\\n;|&]*(?:^|\\s)--?\\s*/|[^\\n;|&]*\\s/(?:\\s|$|[*]))(?=[^\\n;|&]*(?:-[^-\\s]*r[^-\\s]*f|-\\S*f\\S*r|-r\\b|\\s-r\\b|--recursive))(?=[^\\n;|&]*(?:-[^-\\s]*f|-f\\b|\\s-f\\b|--force))", decision: "deny", justification: "recursive root deletion" },
  { type: "regex", pattern: ">\\s*/dev/(?:sd[a-z]\\b|disk\\d+\\b|nvme\\d+n\\d+\\b|mapper/\\S+)", decision: "deny", justification: "write to raw block device" },
  { type: "regex", pattern: "\\bmkfs(?:\\.|\\s)", decision: "deny", justification: "filesystem format" },
  { type: "regex", pattern: "\\bdd\\s+[^\\n;|&]*\\b(?:if|of)=/dev/", decision: "deny", justification: "raw device copy" },
  { type: "regex", pattern: ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:", decision: "deny", justification: "fork bomb" },
  { type: "regex", pattern: ":\\{\\s*:\\|:&\\s*\\};:", decision: "deny", justification: "fork bomb" },
  { type: "regex", pattern: "\\bchmod\\s+(?:-[A-Za-z]+\\s+)*(?:0?777|7777|a\\+rwx|ugo\\+rwx)\\b", decision: "deny", justification: "world-writable permissions" },
];

const SUSPICIOUS_SHELL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\$\(/, reason: "command substitution" },
  { pattern: /`/, reason: "backtick command substitution" },
  { pattern: /<\(/, reason: "process substitution" },
  { pattern: />\(/, reason: "process substitution" },
  { pattern: /\$\{/, reason: "parameter expansion" },
  { pattern: /\$\[/, reason: "legacy arithmetic expansion" },
  { pattern: /(?:^|[\s;&|])=[a-zA-Z_]/, reason: "zsh equals expansion" },
  { pattern: /(?:^|[\s;&|])(?:eval|source)(?:\s|$)/, reason: "shell evaluation" },
];

const CODE_EXECUTION_COMMANDS = new Set([
  "node", "python", "python3", "python2", "perl", "ruby", "php", "lua",
  "bash", "sh", "zsh", "fish", "dash", "deno", "bun", "tsx", "ts-node",
]);

const READ_ONLY_COMMANDS = new Set([
  "pwd", "echo", "printf", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep",
  "rg", "find", "which", "command", "type", "git", "file", "stat", "realpath", "du",
]);

let customRules: Rule[] = [];

export function setCustomRules(rules: Rule[]): void {
  customRules = rules.map(normalizeRule).filter((rule): rule is Rule => Boolean(rule));
}

export function addRule(rule: Rule): void {
  const normalized = normalizeRule(rule);
  if (normalized) customRules.push(normalized);
}

export function checkCommand(command: string): PolicyResult {
  const raw = command.trim();
  if (!raw) return { decision: "allow", justification: "empty command" };

  const parsed = parseShell(raw);
  const words = parsed.tokens.filter(token => token.kind === "word").map(token => token.value);
  const builtInRule = firstMatchingRule(words, raw, DEFAULT_RULES);
  if (builtInRule) return { decision: builtInRule.decision, justification: builtInRule.justification ?? "built-in policy rule matched" };

  const customDeny = firstMatchingRule(words, raw, customRules.filter(rule => rule.decision === "deny"));
  if (customDeny) return { decision: "deny", justification: customDeny.justification ?? "custom deny rule matched" };

  if (parsed.error) return { decision: "ask", justification: parsed.error };
  if (parsed.tokens.length && parsed.tokens[parsed.tokens.length - 1]?.kind !== "word") {
    return { decision: "ask", justification: "trailing shell operator requires approval" };
  }

  const suspicious = SUSPICIOUS_SHELL_PATTERNS.find(item => item.pattern.test(raw));
  if (suspicious) return { decision: "ask", justification: `${suspicious.reason} requires approval` };

  if (parsed.tokens.some(token => token.kind === "redirect")) {
    return { decision: "ask", justification: "shell redirection requires approval" };
  }
  if (parsed.tokens.some(token => token.kind === "operator" && token.value === "&")) {
    return { decision: "ask", justification: "background shell execution requires approval" };
  }

  const segments = splitSegments(parsed.tokens);
  if (!segments.length) return { decision: "allow", justification: "empty command" };

  const askReasons: string[] = [];
  const allowReasons: string[] = [];
  for (const segment of segments) {
    const segmentWords = stripLeadingEnvAssignments(segment);
    const customSegmentDeny = firstMatchingRule(segmentWords, segmentWords.join(" "), customRules.filter(rule => rule.decision === "deny"));
    if (customSegmentDeny) return { decision: "deny", justification: customSegmentDeny.justification ?? "custom deny rule matched" };
    if (hasLeadingEnvAssignmentsWithCommand(segment)) {
      askReasons.push("environment overrides on commands require approval");
      continue;
    }
    const customSegmentAllow = firstMatchingRule(segmentWords, segmentWords.join(" "), customRules.filter(rule => rule.decision === "allow"));
    if (customSegmentAllow) {
      allowReasons.push(customSegmentAllow.justification ?? "custom allow rule matched");
      continue;
    }
    const result = checkSegment(segment);
    if (result.decision === "deny") return result;
    if (result.decision === "ask") askReasons.push(result.justification);
  }
  if (askReasons.length) return { decision: "ask", justification: [...new Set(askReasons)].join("; ") };
  if (allowReasons.length) return { decision: "allow", justification: [...new Set(allowReasons)].join("; ") };
  return { decision: "allow", justification: "all command segments are validated read-only" };
}

export function isCommandReadOnly(command: string): boolean {
  return checkCommand(command).decision === "allow";
}

export function getAllRules(): Rule[] {
  return [...DEFAULT_RULES, ...customRules];
}

function checkSegment(words: string[]): PolicyResult {
  const args = [...words];
  let envAssignments = 0;
  while (args[0] !== undefined && isEnvAssignment(args[0])) {
    args.shift();
    envAssignments++;
  }
  if (!args.length) return { decision: "allow", justification: "environment assignment only" };
  if (envAssignments > 0) return { decision: "ask", justification: "environment overrides on commands require approval" };

  const command = normalizeCommand(args.shift() ?? "");
  if (!READ_ONLY_COMMANDS.has(command)) {
    if (CODE_EXECUTION_COMMANDS.has(command)) return checkCodeExecutionCommand(command, args);
    return { decision: "ask", justification: `${command} is not in the read-only allowlist` };
  }

  switch (command) {
    case "pwd":
      return checkFlags(command, args, { none: ["--help", "--version"], shortNone: "LP" });
    case "echo":
      return checkFlags(command, args, { none: ["--help", "--version"], shortNone: "neE" });
    case "printf":
      return checkFlags(command, args, { none: ["--help", "--version"] });
    case "ls":
      return checkFlags(command, args, {
        none: [
          "--all", "--almost-all", "--long", "--human-readable", "--recursive", "--directory",
          "--classify", "--inode", "--numeric-uid-gid", "--reverse", "--help", "--version",
          "--color", "--no-color", "--group-directories-first",
        ],
        value: { "--sort": "string", "--time-style": "string", "--ignore": "string", "--hide": "string", "--quoting-style": "string" },
        shortNone: "aAhlRrdFipqstS1GC",
      });
    case "cat":
      return checkFlags(command, args, {
        none: ["--number", "--number-nonblank", "--squeeze-blank", "--show-ends", "--show-tabs", "--show-all", "--show-nonprinting", "--help", "--version"],
        shortNone: "nbsETAv",
      });
    case "head":
      return checkFlags(command, args, {
        none: ["--quiet", "--verbose", "--zero-terminated", "--help", "--version"],
        value: { "--lines": "number", "--bytes": "string" },
        shortNone: "qvz",
        shortValue: { "-n": "number", "-c": "string" },
        allowNumericShort: true,
      });
    case "tail":
      return checkFlags(command, args, {
        none: ["--quiet", "--verbose", "--zero-terminated", "--help", "--version"],
        value: { "--lines": "number", "--bytes": "string" },
        shortNone: "qvz",
        shortValue: { "-n": "number", "-c": "string" },
        allowNumericShort: true,
        dangerous: ["-f", "-F", "--follow", "--pid", "--retry"],
      });
    case "wc":
      return checkFlags(command, args, {
        none: ["--lines", "--words", "--bytes", "--chars", "--max-line-length", "--help", "--version"],
        value: { "--files0-from": "string" },
        shortNone: "lwcLm",
      });
    case "grep":
    case "egrep":
    case "fgrep":
      return checkFlags(command, args, grepFlags());
    case "rg":
      return checkFlags(command, args, ripgrepFlags());
    case "find":
      return checkFind(args);
    case "which":
      return checkFlags(command, args, { none: ["--all", "--skip-alias", "--skip-functions", "--help", "--version"], shortNone: "a" });
    case "command":
      return args[0] === "-v" || args[0] === "-V"
        ? { decision: "allow", justification: "command lookup is read-only" }
        : { decision: "ask", justification: "only command -v/-V is read-only" };
    case "type":
      return checkFlags(command, args, { shortNone: "apPt" });
    case "git":
      return checkGit(args);
    case "file":
      return checkFlags(command, args, {
        none: ["--brief", "--mime", "--mime-type", "--mime-encoding", "--no-dereference", "--dereference", "--help", "--version"],
        value: { "--exclude": "string", "--separator": "string", "--magic-file": "string" },
        shortNone: "biEhLz0",
        shortValue: { "-F": "string", "-m": "string" },
      });
    case "stat":
      return checkFlags(command, args, {
        none: ["--terse", "--dereference", "--file-system", "--help", "--version"],
        value: { "--format": "string", "--printf": "string" },
        shortNone: "tLf",
        shortValue: { "-c": "string" },
      });
    case "realpath":
      return checkFlags(command, args, {
        none: ["--canonicalize-existing", "--canonicalize-missing", "--logical", "--physical", "--quiet", "--strip", "--zero", "--help", "--version"],
        value: { "--relative-to": "string", "--relative-base": "string" },
        shortNone: "emLPqsz",
      });
    case "du":
      return checkFlags(command, args, {
        none: ["--all", "--summarize", "--human-readable", "--total", "--one-file-system", "--apparent-size", "--help", "--version"],
        value: { "--max-depth": "number", "--block-size": "string", "--exclude": "string" },
        shortNone: "aschxBLP0",
        shortValue: { "-d": "number", "-t": "string" },
      });
    default:
      return { decision: "ask", justification: `${command} is not in the read-only allowlist` };
  }
}

function checkCodeExecutionCommand(command: string, args: string[]): PolicyResult {
  if (["node", "python", "python3", "python2", "ruby", "perl", "php"].includes(command)
    && args.length === 1
    && ["--version", "-v", "-V"].includes(args[0] ?? "")) {
    return { decision: "allow", justification: `${command} version check is read-only` };
  }
  if (args.some(arg => ["-e", "--eval", "-p", "--print", "-c", "-r"].includes(arg) || arg.startsWith("-e") || arg.startsWith("-c"))) {
    return { decision: "ask", justification: `${command} inline execution requires approval` };
  }
  return { decision: "ask", justification: `${command} executes code and requires approval` };
}

function checkFind(args: string[]): PolicyResult {
  const destructive = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
  const executes = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
  const valueFlags = new Set([
    "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type", "-maxdepth", "-mindepth",
    "-size", "-mtime", "-mmin", "-newer", "-user", "-group", "-perm", "-printf",
  ]);
  const noValueFlags = new Set(["-print", "-print0", "-ls", "-empty", "-readable", "-writable", "-executable", "-and", "-or", "-not", "-prune"]);
  const hyphenValuesAllowed = new Set(["-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-perm"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (destructive.has(arg)) return { decision: "deny", justification: `find ${arg} mutates files` };
    if (executes.has(arg)) return { decision: "ask", justification: `find ${arg} executes commands` };
    if (arg.startsWith("-") && !valueFlags.has(arg) && !noValueFlags.has(arg)) {
      return { decision: "ask", justification: `find flag ${arg} is not allowlisted` };
    }
    if (valueFlags.has(arg)) {
      const next = args[i + 1];
      if (next === undefined) return { decision: "ask", justification: `find flag ${arg} expects a value` };
      if (destructive.has(next)) return { decision: "deny", justification: `find ${next} mutates files` };
      if (executes.has(next)) return { decision: "ask", justification: `find ${next} executes commands` };
      if (next === "--" || valueFlags.has(next) || noValueFlags.has(next)) {
        return { decision: "ask", justification: `find flag ${arg} has ambiguous value ${next}` };
      }
      if (next.startsWith("-") && !hyphenValuesAllowed.has(arg)) {
        return { decision: "ask", justification: `find flag ${arg} has ambiguous value ${next}` };
      }
      i++;
    }
  }
  return { decision: "allow", justification: "find expression is read-only" };
}

function checkGit(args: string[]): PolicyResult {
  const normalized = peelGitGlobalOptions(args);
  if (!normalized.ok) return normalized.result;
  const subcommand = normalized.args[0] ?? "";
  const rest = normalized.args.slice(1);
  switch (subcommand) {
    case "status":
      return checkFlags("git status", rest, gitCommonFlags({ shortNone: "sbuno", none: ["--short", "--branch", "--porcelain", "--ignored", "--untracked-files", "--renames"] }));
    case "diff":
      return checkFlags("git diff", rest, gitCommonFlags({
        none: ["--cached", "--staged", "--name-only", "--name-status", "--stat", "--numstat", "--shortstat", "--check", "--exit-code", "--no-ext-diff", "--color", "--no-color"],
        value: { "--unified": "number", "--word-diff": "string", "--diff-filter": "string" },
        shortNone: "w",
        shortValue: { "-U": "number" },
        dangerous: ["--output", "--ext-diff"],
      }));
    case "log":
    case "show":
      return checkFlags(`git ${subcommand}`, rest, gitCommonFlags({
        none: ["--stat", "--oneline", "--decorate", "--graph", "--patch", "--name-only", "--name-status", "--color", "--no-color"],
        value: { "--format": "string", "--pretty": "string", "--max-count": "number", "--since": "string", "--until": "string" },
        shortNone: "p",
        shortValue: { "-n": "number" },
      }));
    case "branch":
      return checkGitBranch(rest);
    default:
      return { decision: "ask", justification: `git ${subcommand || "(missing subcommand)"} is not read-only allowlisted` };
  }
}

function checkGitBranch(args: string[]): PolicyResult {
  const mutating = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--set-upstream-to", "--unset-upstream"]);
  if (args.some(arg => mutating.has(arg))) return { decision: "ask", justification: "git branch mutation requires approval" };
  const listMode = args.some(arg => ["--list", "-l", "--all", "-a", "--remotes", "-r"].includes(arg) || arg.startsWith("--list="));
  const normalizedArgs = normalizeGitBranchOptionalFlagValues(args);
  const flags = checkFlags("git branch", normalizedArgs, {
    none: ["--list", "--all", "--remotes", "--verbose", "--color", "--no-color", "--show-current"],
    value: { "--format": "string", "--sort": "string", "--points-at": "string", "--merged": "string", "--no-merged": "string", "--contains": "string", "--no-contains": "string" },
    shortNone: "larvv",
  });
  if (flags.decision !== "allow") return flags;
  const positionals = gitBranchPositionals(normalizedArgs);
  if (positionals.length && !listMode) return { decision: "ask", justification: "git branch with positional names may create branches" };
  return { decision: "allow", justification: "git branch query is read-only" };
}

function normalizeGitBranchOptionalFlagValues(args: string[]): string[] {
  const optionalValueFlags = new Set(["--merged", "--no-merged", "--contains", "--no-contains"]);
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (optionalValueFlags.has(arg)) {
      const next = args[index + 1];
      normalized.push(arg);
      if (next !== undefined && next !== "--" && !next.startsWith("-")) {
        normalized.push(next);
        index++;
      } else {
        normalized.push("HEAD");
      }
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function peelGitGlobalOptions(args: string[]): { ok: true; args: string[] } | { ok: false; result: PolicyResult } {
  const rest = [...args];
  const valueFlags = new Set(["-C", "--git-dir", "--work-tree"]);
  while (rest.length) {
    const current = rest[0];
    if (current === undefined) break;
    if (valueFlags.has(current)) {
      if (rest.length < 2 || !rest[1]) {
        return { ok: false, result: { decision: "ask", justification: `git global option ${current} expects string value` } };
      }
      rest.splice(0, 2);
      continue;
    }
    if (current.startsWith("--git-dir=") || current.startsWith("--work-tree=")) {
      const [, value] = current.split("=", 2);
      if (!value) return { ok: false, result: { decision: "ask", justification: `git global option ${current.split("=")[0]} expects string value` } };
      rest.shift();
      continue;
    }
    break;
  }
  return { ok: true, args: rest };
}

function gitBranchPositionals(args: string[]): string[] {
  const flagsWithValues = new Set(["--format", "--sort", "--points-at"]);
  const queryFlagsWithOptionalValues = new Set(["--merged", "--no-merged", "--contains", "--no-contains"]);
  const positionals: string[] = [];
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (afterDoubleDash) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (flagsWithValues.has(arg)) {
      index++;
      continue;
    }
    if (queryFlagsWithOptionalValues.has(arg)) {
      const next = args[index + 1];
      if (next !== undefined && next !== "--" && !next.startsWith("-")) index++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }
  return positionals;
}

function gitCommonFlags(extra: FlagSpec): FlagSpec {
  const spec: FlagSpec = {
    none: ["--help", "--version", ...(extra.none ?? [])],
    value: { "--git-dir": "string", "--work-tree": "string", "-C": "string", ...(extra.value ?? {}) },
  };
  if (extra.shortNone !== undefined) spec.shortNone = extra.shortNone;
  if (extra.shortValue !== undefined) spec.shortValue = extra.shortValue;
  if (extra.dangerous !== undefined) spec.dangerous = extra.dangerous;
  return spec;
}

function grepFlags(): FlagSpec {
  return {
    none: [
      "--line-number", "--ignore-case", "--recursive", "--dereference-recursive", "--fixed-strings",
      "--extended-regexp", "--perl-regexp", "--word-regexp", "--count", "--files-with-matches",
      "--files-without-match", "--invert-match", "--no-messages", "--color", "--no-color", "--help", "--version",
    ],
    value: { "--regexp": "string", "--file": "string", "--include": "string", "--exclude": "string", "--exclude-dir": "string", "--context": "number", "--after-context": "number", "--before-context": "number", "--max-count": "number" },
    shortNone: "inrRHFEPlcvsmq",
    shortValue: { "-e": "string", "-f": "string", "-C": "number", "-A": "number", "-B": "number", "-m": "number" },
  };
}

function ripgrepFlags(): FlagSpec {
  return {
    none: [
      "--line-number", "--ignore-case", "--smart-case", "--case-sensitive", "--hidden", "--no-ignore",
      "--follow", "--fixed-strings", "--files", "--files-with-matches", "--files-without-match",
      "--count", "--count-matches", "--json", "--vimgrep", "--help", "--version", "--color", "--no-heading",
    ],
    value: { "--regexp": "string", "--glob": "string", "--type": "string", "--type-not": "string", "--context": "number", "--after-context": "number", "--before-context": "number", "--max-count": "number", "--max-depth": "number", "--threads": "number" },
    shortNone: "inSsuUvclFHL",
    shortValue: { "-e": "string", "-g": "string", "-t": "string", "-T": "string", "-C": "number", "-A": "number", "-B": "number", "-m": "number", "-j": "number" },
  };
}

function checkFlags(command: string, args: string[], spec: FlagSpec): PolicyResult {
  const none = new Set(spec.none ?? []);
  const value = spec.value ?? {};
  const dangerous = new Set(spec.dangerous ?? []);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") return { decision: "allow", justification: `${command} flags are read-only` };
    if (!arg.startsWith("-") || arg === "-") continue;
    if (spec.allowNumericShort && /^-\d+$/.test(arg)) continue;
    const baseFlag = arg.split("=", 1)[0] ?? arg;
    if (dangerous.has(arg) || dangerous.has(baseFlag)) {
      return { decision: "ask", justification: `${command} flag ${arg} requires approval` };
    }
    if (arg.startsWith("--")) {
      const [rawFlag, inlineValue] = arg.split("=", 2);
      const flag = rawFlag ?? arg;
      if (none.has(flag)) {
        if (inlineValue !== undefined) return { decision: "ask", justification: `${command} flag ${flag} does not take a value` };
        continue;
      }
      const type = value[flag];
      if (!type) return { decision: "ask", justification: `${command} flag ${flag} is not allowlisted` };
      if (inlineValue !== undefined) {
        if (!validFlagValue(type, inlineValue)) return { decision: "ask", justification: `${command} flag ${flag} has invalid value` };
      } else {
        i++;
        const next = args[i];
        if (next === undefined || !validFlagValue(type, next)) return { decision: "ask", justification: `${command} flag ${flag} expects ${type} value` };
      }
      continue;
    }
    const parsed = checkShortFlags(command, arg, args, i, spec);
    if (parsed.decision !== "allow") return parsed;
    const nextIndex = Number(parsed.justification);
    if (Number.isInteger(nextIndex)) i = nextIndex;
  }
  return { decision: "allow", justification: `${command} flags are read-only` };
}

function checkShortFlags(command: string, arg: string, args: string[], index: number, spec: FlagSpec): PolicyResult {
  const none = new Set((spec.shortNone ?? "").split("").filter(Boolean).map(char => `-${char}`));
  const value = spec.shortValue ?? {};
  const dangerous = new Set(spec.dangerous ?? []);
  for (let pos = 1; pos < arg.length; pos++) {
    const flag = `-${arg[pos]}`;
    if (dangerous.has(flag)) return { decision: "ask", justification: `${command} flag ${flag} requires approval` };
    if (none.has(flag)) continue;
    const type = value[flag];
    if (!type) return { decision: "ask", justification: `${command} flag ${flag} is not allowlisted` };
    const attached = arg.slice(pos + 1);
    if (attached) {
      if (!validFlagValue(type, attached)) return { decision: "ask", justification: `${command} flag ${flag} has invalid value` };
      return { decision: "allow", justification: String(index) };
    }
    const nextIndex = index + 1;
    const next = args[nextIndex];
    if (next === undefined || !validFlagValue(type, next)) {
      return { decision: "ask", justification: `${command} flag ${flag} expects ${type} value` };
    }
    return { decision: "allow", justification: String(nextIndex) };
  }
  return { decision: "allow", justification: String(index) };
}

function validFlagValue(type: FlagArgType, value: string): boolean {
  if (type === "string") return value.length > 0;
  if (type === "number") return /^[-+]?\d+$/.test(value);
  return true;
}

function stripLeadingEnvAssignments(words: string[]): string[] {
  const args = [...words];
  while (args[0] !== undefined && isEnvAssignment(args[0])) args.shift();
  return args;
}

function hasLeadingEnvAssignmentsWithCommand(words: string[]): boolean {
  if (!words.length || !isEnvAssignment(words[0] ?? "")) return false;
  return stripLeadingEnvAssignments(words).length > 0;
}

function parseShell(command: string): ParseResult {
  const tokens: Token[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    if (!current) return;
    tokens.push({ kind: "word", value: current });
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !quote) {
      flush();
      tokens.push({ kind: "operator", value: "\n" });
      if (ch === "\r" && command[i + 1] === "\n") i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    const two = command.slice(i, i + 2);
    const three = command.slice(i, i + 3);
    if (three === "<<<") {
      flush();
      tokens.push({ kind: "redirect", value: three });
      i += 2;
      continue;
    }
    if ([">>", "<<", "&&", "||", "&>"].includes(two)) {
      flush();
      tokens.push({ kind: two.includes(">") || two.includes("<") ? "redirect" : "operator", value: two });
      i++;
      continue;
    }
    if ([";", "|", "&"].includes(ch)) {
      flush();
      tokens.push({ kind: "operator", value: ch });
      continue;
    }
    if ([">", "<"].includes(ch)) {
      flush();
      tokens.push({ kind: "redirect", value: ch });
      continue;
    }
    current += ch;
  }
  if (escaped) return { tokens, error: "trailing shell escape requires approval" };
  if (quote) return { tokens, error: "unclosed shell quote requires approval" };
  flush();
  return { tokens };
}

function splitSegments(tokens: Token[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token.kind === "word") {
      current.push(token.value);
      continue;
    }
    if (token.kind === "operator" || token.kind === "redirect") {
      if (current.length) segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  return segments;
}

function firstMatchingRule(tokens: string[], raw: string, rules: Rule[]): Rule | undefined {
  return rules.find(rule => matches(tokens, raw, rule));
}

function matches(tokens: string[], raw: string, rule: Rule): boolean {
  switch (rule.type) {
    case "exact":
      return raw === rule.command || (tokens.length === 1 && tokens[0] === rule.command);
    case "prefix":
      if (tokens.length < rule.prefix.length) return false;
      return rule.prefix.every((part, index) => tokens[index] === part);
    case "regex":
      try { return new RegExp(rule.pattern).test(raw); } catch { return false; }
  }
}

function normalizeRule(rule: Rule): Rule | null {
  if (rule.type === "exact") {
    const command = rule.command.trim();
    return command ? { ...rule, command } : null;
  }
  if (rule.type === "prefix") {
    const prefix = rule.prefix.map(part => part.trim()).filter(Boolean);
    return prefix.length ? { ...rule, prefix } : null;
  }
  if (rule.type === "regex") {
    const pattern = rule.pattern.trim();
    if (!pattern || pattern.length > 1_000) return null;
    try {
      new RegExp(pattern);
      return { ...rule, pattern };
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeCommand(command: string): string {
  return basename(command).toLowerCase();
}

function isEnvAssignment(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*=.*/.test(value);
}
