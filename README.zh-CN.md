# Seek Code

[English](./README.md)

Seek Code 是一个专为 DeepSeek 打造的终端 Code Agent。它围绕 `deepseek-v4-pro` / `deepseek-v4-flash`、长上下文工程任务、工具调用、本地验证、权限控制、MCP、Skills、任务、回滚和 Server Runtime 设计。

<p align="center">
  <img src="./example.png" alt="Seek Code 终端界面" width="900">
</p>

```bash
npm install -g seekcode
export SEEKCODE_API_KEY="sk-your-api-key"
seek
```

需要 Node.js `>=22`。

## 专为 DeepSeek 打造

- 默认模型是 `deepseek-v4-pro`，默认 fast model 是 `deepseek-v4-flash`。
- 上下文限制、reasoning effort、thinking stream、工具循环、token 使用和成本统计都按 DeepSeek 编码工作流调优。
- 支持 provider：`deepseek`、`deepseek-cn`、`nvidia-nim`、`openrouter`、`novita`、`fireworks`、`sglang`。
- 面向真实仓库长会话，不只是短 prompt 聊天。

## 快速开始

交互模式：

```bash
seek
```

一次性任务：

```bash
seek "review the current diff and suggest the smallest safe fix"
seek --mode plan "survey this repo and explain the architecture"
seek --mode agent "fix the failing tests and run the relevant verification"
seek --mode yolo "format the repo and run the full test suite"
```

模型、provider 和 reasoning：

```bash
seek --model deepseek-v4-pro -r high
seek --provider deepseek-cn
seek --provider sglang --base-url http://localhost:30000/v1 --model deepseek-v4-pro
```

本地 HTTP/SSE Server：

```bash
seek serve --host 127.0.0.1 --port 8080
```

检查或升级：

```bash
seek update --check
seek update -y
```

## 完整功能支持

| 能力 | 已支持内容 | 使用方式 |
|---|---|---|
| 终端 TUI | inline scrollback、fullscreen、状态栏、实时工具状态、审批弹窗、Tab 补全 | `seek`、`--alt-screen`、`--no-alt-screen` |
| 模式控制 | 只读规划、审批驱动 agent、高信任 yolo | `--mode plan`、`/agent`、`/yolo` |
| 代码工具 | 读写/编辑文件、搜索、glob、patch、git status/diff/log | 直接描述任务，Agent 自动调用工具 |
| Shell 与验证 | 前台命令、后台 jobs、等待/取消、verification gate、LSP diagnostics | 让 Agent 运行测试，或用 `/jobs` 查看 |
| Web | 搜索和抓取 URL、多搜索源、域名 allow/block、代理配置 | 让 Agent 搜索，或配置 `[web]` |
| MCP | stdio/SSE MCP Server，注册为 `mcp_*` 工具 | `/mcp add ...`、`/mcp reload` |
| Skills | `SKILL.md` 工作流、安装/更新/信任、项目/全局发现 | `/skills`、`/skill <name>` |
| 自定义工具 | 项目级 `.seekcode/tools/*.js|*.cjs|*.ts` 工具模块，默认 ASK 权限 | 放入 `.seekcode/tools`，用 `custom_tools` 查看 |
| 任务系统 | durable tasks、checklist、plan、notes、长任务状态 | `/tasks`，Agent 工具如 `task_create` |
| Artifacts | 保存长日志、诊断、patch 和证据，避免污染上下文 | 工具自动创建，或使用 artifact 工具 |
| Sessions | 保存、列出、加载、删除和恢复工作上下文 | `/save`、`/sessions`、`/load` |
| 回滚 | workspace snapshot 和恢复流程 | `/restore` |
| 子 Agent | bounded worker、并行调查 | Agent 工具 `spawn_agent` |
| Server | HTTP/SSE threads、sessions、runtime events、skills API | `seek serve` |

## 常用功能示例

模式与上下文：

```text
/plan                 # 切到只读规划
/agent                # 切到常规 agent 模式
/yolo                 # 切到高信任执行
/tokens               # 查看 token 使用
/cost                 # 查看成本
/clear                # 清空当前上下文
```

会话与恢复：

```text
/save                 # 保存当前会话
/sessions             # 列出会话
/load <session-id>    # 加载会话
/delete <session-id>  # 删除会话
/restore              # 查看并恢复 workspace snapshot
```

MCP：

```text
/mcp list
/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .
/mcp disable filesystem
/mcp reload
```

也可以写进 TOML 配置：

```toml
[[mcp_servers]]
name = "filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
enabled = true
```

Skills：

```text
/skills
/skills remote
/skill install github:org/repo
/skill trust my-skill
/skill my-skill
```

项目自定义工具：

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

自定义工具会在启动时加载，默认权限为 `ask`，可通过 `custom_tools` 查看。

配置诊断：

```bash
seek config validate
seek config explain
seek config migrate --target user
seek config migrate --target project --dry-run
```

## 配置与路径

配置优先级：

```text
默认值 < 用户配置 < 项目配置 < 环境变量 < CLI 参数
```

| 内容 | 默认位置 | 如何更改 |
|---|---|---|
| 用户配置 | `~/.seekcode/config.toml` | 直接编辑文件、环境变量或 CLI 参数 |
| 项目配置 | `./.seekcode/config.toml` | 放在当前仓库 |
| Sessions | `${XDG_DATA_HOME:-~/.local/share}/seekcode/sessions` | `SEEKCODE_SESSIONS_DIR=/path` |
| Artifacts | `${XDG_DATA_HOME:-~/.local/share}/seekcode/artifacts` | `SEEKCODE_ARTIFACTS_DIR=/path` |
| Tasks | `${XDG_DATA_HOME:-~/.local/share}/seekcode/tasks/tasks.json` | `SEEKCODE_TASKS_DIR=/path` |
| Jobs | `${XDG_DATA_HOME:-~/.local/share}/seekcode/jobs` | `SEEKCODE_JOBS_DIR=/path` |
| Runtime Server 数据 | `${XDG_DATA_HOME:-~/.local/share}/seekcode/runtime` | `SEEKCODE_RUNTIME_DIR=/path` |
| 全局 Skills | `~/.seekcode/skills` | `skills_dir` 或 `SEEKCODE_SKILLS_DIR` |
| 项目 Skills | `./.seekcode/skills`、`./skills`、`./.agents/skills` | 放入这些目录 |
| 回滚快照 | `./.seekcode/side-git` | workspace-local |

常用配置：

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

常用环境变量：

```bash
export SEEKCODE_API_KEY="sk-..."
export SEEKCODE_MODEL="deepseek-v4-pro"
export SEEKCODE_PROVIDER="deepseek"
export SEEKCODE_BASE_URL="https://api.deepseek.com"
export SEEKCODE_REASONING_EFFORT="high"
export SEEKCODE_TUI_ALTERNATE_SCREEN="never"
export XDG_DATA_HOME="$HOME/.local/share"
```

`SEEKCODE_*` 是规范命名空间。旧的 `DEEPSEEK_*` 变量仍会作为 provider/API/model 兼容和迁移兜底被识别。

## 兼容性

Seek Code 保持 DeepSeek-first 默认体验，同时兼容常见 Code Agent 约定：

- 原生支持 `AGENTS.md`，并按目录层级合并项目指令。
- 兼容 Claude Code 指令文件：`CLAUDE.md`、`.claude/CLAUDE.md`。
- 兼容 Claude Code markdown slash commands：读取 `.claude/commands/**/*.md`，以 `/project:name` 或 `/user:name` 使用。
- Skills 会扫描 `./.seekcode/skills`、`./skills`、`./.agents/skills`、`~/.seekcode/skills`，也兼容 `.agents`、`.claude`、`.deepseek` 相关 skill 路径。
- 支持通用 stdio/SSE MCP Server 配置。
- 支持从旧 `.deepseek` 配置路径迁移：`seek config migrate --target user|project`。

兼容文件只提供项目上下文和命令扩展，不会削弱 Seek Code 的权限、sandbox 和 DeepSeek-first 工具策略。

## 开发

```bash
npm install
npm run build
npm test
```

## License

MIT
