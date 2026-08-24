

# Seek Code

[简体中文](./README.zh-CN.md)

Seek Code is a DeepSeek-first terminal code agent. It is built around `deepseek-v4-pro` / `deepseek-v4-flash`, long-context engineering work, tool use, local verification, permissions, MCP, skills, tasks, rollback, and a server runtime.

<p align="center">
  <img src="./example.png" alt="Seek Code terminal interface" width="900">
</p>

```bash
npm install -g seekcode
export SEEKCODE_API_KEY="sk-your-api-key"
seek
```

Node.js `>=22` is required.

## Built For DeepSeek

- Defaults to `deepseek-v4-pro`; the fast companion model defaults to `deepseek-v4-flash`.
- Context limits, reasoning effort, thinking streams, tool loops, token usage, and cost reporting are tuned for DeepSeek-style coding work.
- Supported providers: `deepseek`, `deepseek-cn`, `nvidia-nim`, `openrouter`, `novita`, `fireworks`, `sglang`.
- Designed for real repository sessions, not just short chat prompts.

## Quick Start

Interactive mode:

```bash
seek
```

One-shot tasks:

```bash
seek "review the current diff and suggest the smallest safe fix"
seek --mode plan "survey this repo and explain the architecture"
seek --mode agent "fix the failing tests and run the relevant verification"
seek --mode yolo "format the repo and run the full test suite"
```

Model, provider, and reasoning:

```bash
seek --model deepseek-v4-pro -r high
seek --provider deepseek-cn
seek --provider sglang --base-url http://localhost:30000/v1 --model deepseek-v4-pro
```

Local HTTP/SSE server:

```bash
seek serve --host 127.0.0.1 --port 8080
```

`SEEKCODE_SERVER_TOKEN` enables Bearer-token authentication for `/v1` routes; `/v1/health` remains open.

Update:

```bash
seek update --check
seek update -y
```

## Feature Support

| Area | Supported now | How to use |
|---|---|---|
| Terminal UX | Inline scrollback, fullscreen TUI, status line, live tool activity, approvals, Tab completion | `seek`, `--alt-screen`, `--no-alt-screen` |
| Modes | Read-only planning, approval-driven agent mode, high-trust yolo mode | `--mode plan`, `/agent`, `/yolo` |
| Code tools | Read/write/edit files, search, glob, patches, git status/diff/log | Describe the task; the agent calls tools |
| Shell and verification | Foreground commands, background jobs, wait/cancel, verification gates, LSP diagnostics | Ask the agent to run tests; inspect `/jobs` |
| Web | Search and fetch URLs, multiple search engines, allow/block domains, proxy config | Ask the agent to search; configure `[web]` |
| MCP | stdio/SSE MCP servers exposed as `mcp_*` tools | `/mcp add ...`, `/mcp reload` |
| Skills | `SKILL.md` workflows, install/update/trust, project/global discovery | `/skills`, `/skill <name>` |
| Custom tools | Workspace `.seekcode/tools/*.js|*.cjs|*.ts` tool modules with default ASK permissions | Add files under `.seekcode/tools`; inspect with `custom_tools` |
| Tasks | Durable tasks, checklist, plan, notes, long-running task state | `/tasks`; agent tools such as `task_create` |
| Artifacts | Store long logs, diagnostics, patches, and evidence outside the live context | Created by tools or artifact commands |
| Sessions | Save, list, load, delete, and resume work | `/save`, `/sessions`, `/load` |
| Rollback | Workspace snapshots and restore flow | `/restore` |
| Sub-agents | Bounded workers and parallel investigation | Agent tool `spawn_agent` |
| Server | HTTP/SSE threads, sessions, runtime events, skills API | `seek serve` |

## Common Usage

Modes and context:

```text
/plan                 # switch to read-only planning
/agent                # switch to normal agent mode
/yolo                 # switch to high-trust execution
/tokens               # show token usage
/cost                 # show cost
/clear                # clear current context
```

Sessions and recovery:

```text
/save                 # save current session
/sessions             # list sessions
/load <session-id>    # load a session
/delete <session-id>  # delete a session
/restore              # list and restore workspace snapshots
```

MCP:

```text
/mcp list
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .
/mcp disable filesystem
/mcp reload
```

MCP can also be configured in TOML:

```toml
[[mcp_servers]]
name = "filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
enabled = true
```

Skills:

```text
/skills
/skills remote
/skill install github:org/repo
/skill trust my-skill
/skill my-skill
```

Workspace custom tools:

```js
// .seekcode/tools/hello.cjs
module.exports = tool({
  name: "hello_tool",
  description: "Say hello",
  parameters: { type: "object", properties: { name: { type: "string" } } },
  readOnly: true,
  run(args) { return `hello ${args.name}`; }
});
```

Custom tools load during startup, use `ask` permission by default, and can be inspected with `custom_tools`.

Configuration diagnostics:

```bash
seek config validate
seek config explain
seek config migrate --target user
seek config migrate --target project --dry-run
```

## Configuration And Paths

Configuration precedence:

```text
defaults < user config < project config < environment variables < CLI flags
```

| Data | Default path | Override |
|---|---|---|
| User config | `~/.seekcode/config.toml` | Edit the file, env vars, or CLI flags |
| Project config | `./.seekcode/config.toml` | Put it in the current repo |
| Sessions | `${XDG_DATA_HOME:-~/.local/share}/seekcode/sessions` | `SEEKCODE_SESSIONS_DIR=/path` |
| Artifacts | `${XDG_DATA_HOME:-~/.local/share}/seekcode/artifacts` | `SEEKCODE_ARTIFACTS_DIR=/path` |
| Tasks | `${XDG_DATA_HOME:-~/.local/share}/seekcode/tasks/tasks.json` | `SEEKCODE_TASKS_DIR=/path` |
| Jobs | `${XDG_DATA_HOME:-~/.local/share}/seekcode/jobs` | `SEEKCODE_JOBS_DIR=/path` |
| Runtime server data | `${XDG_DATA_HOME:-~/.local/share}/seekcode/runtime` | `SEEKCODE_RUNTIME_DIR=/path` |
| Global skills | `~/.seekcode/skills` | `skills_dir` or `SEEKCODE_SKILLS_DIR` |
| Project skills | `./.seekcode/skills`, `./skills`, `./.agents/skills` | Put skills in those folders |
| Rollback snapshots | `./.seekcode/side-git` | Workspace-local |

Common config:

```toml
api_key = ""
provider = "deepseek"
base_url = "https://api.deepseek.com"
model = "deepseek-v4-pro"
flash_model = "deepseek-v4-flash"

mode = "agent"
reasoning_effort = "high"
max_tokens = 8192
context_limit = 1000000

approval_policy = "on-request"
sandbox_mode = "workspace-write"
workspace_boundary = true
rollback_enabled = true
lsp_auto_diagnostics = true
status_items = ["mode", "model", "workspace", "cache", "tools", "cost", "hints"]

[web]
enabled = true
mode = "live"
search_engine = "auto"
allowed_domains = []
blocked_domains = []
```

Common environment variables:

```bash
export SEEKCODE_API_KEY="sk-..."
export SEEKCODE_MODEL="deepseek-v4-pro"
export SEEKCODE_PROVIDER="deepseek"
export SEEKCODE_BASE_URL="https://api.deepseek.com"
export SEEKCODE_REASONING_EFFORT="high"
export SEEKCODE_TUI_ALTERNATE_SCREEN="never"
export XDG_DATA_HOME="$HOME/.local/share"
```

`SEEKCODE_*` is the canonical namespace. Legacy `DEEPSEEK_*` variables are still recognized for provider/API/model compatibility and migration.

## Compatibility

Seek Code keeps DeepSeek-first defaults while supporting common code-agent conventions:

- Native `AGENTS.md` support with layered project instructions.
- Claude Code instruction compatibility: `CLAUDE.md` and `.claude/CLAUDE.md`.
- Claude Code markdown slash commands from `.claude/commands/**/*.md`, exposed as `/project:name` or `/user:name`.
- Skill discovery from `./.seekcode/skills`, `./skills`, `./.agents/skills`, `~/.seekcode/skills`, plus compatible `.agents`, `.claude`, and `.deepseek` skill paths.
- Generic stdio/SSE MCP server configuration.
- Migration from old `.deepseek` config paths via `seek config migrate --target user|project`.

Compatibility files add project context and command expansion; they do not weaken Seek Code permissions, sandboxing, or DeepSeek-first tool policy.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
