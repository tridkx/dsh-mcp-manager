# dsh-mcp-manager

> [!WARNING]
> **AI 生成声明 / AI-Generated Notice**
> 本项目（代码与文档）由 AI 辅助生成，仅供个人学习、参考与二次开发使用。
> 请在使用前自行审查代码的安全性，作者不对使用本项目造成的任何后果负责。
> This project (code & docs) was AI-assisted. Use at your own risk; review before use.

> **English summary** — A self-developed DeepSeek Harness (DSH) Web plugin that
> visually manages MCP (Model Context Protocol) servers from the settings page,
> bridges server tools to the model as `mcp__<server>__<tool>`, and splits the
> plugin inventory into "official" / "custom" tabs. Host plugin is a zero-import
> ESM Cordis plugin; browser half is a `__ModuleLoader__` bundle.

一个挂在 DSH（DeepSeek Harness）Web 宿主组合上的自研插件，提供三块能力：

| 能力 | 说明 |
|---|---|
| **MCP 服务器管理** | 在 设置 → "MCP 管理" 可视化增删改（含改名）MCP 服务器配置（stdio 子进程 / streamable-HTTP 两种传输），连接/断开、浏览工具、调用测试 |
| **模型工具桥接（按需注入）** | 默认 lazy 模式：连接成功后**不**把工具 schema 塞进每个请求，模型通过 `mcp_tools` 网关按需 `list` / `describe` / `call`；切到 `eager` 才注册成 `mcp__<服务器名>__<工具名>`（如 `mcp__godot-ai__editor_state`）。另有管理工具 `mcp_manager` |
| **按需环境说明（notes）** | 每台服务器可写一段 `notes`（如「Blender 不在 PATH」「9877 端口约定」「侧边栏显示 bug」）。它**不进每个请求**，只在模型 `describe` 该服务器某个工具时随附——这就是把环境知识从 `AGENTS.md` 搬出来的位置 |
| **健康探针** | 握手成功 ≠ 后端可用。配置 `healthTool` + `healthExpect` 后，连接时真调一次探针并校验返回内容，GUI 据此区分「已连接（后端正常）」与「服务不可用」 |
| **整代原子替换** | 服务器改工具列表（`tools/list_changed`）时整批校验、整批替换：重复名、构建失败、注册失败一律**保留上一代**，绝不留下"半个服务器"；失败原因在 GUI 上直接可见 |
| **插件分类页签** | 在 设置 → 插件 提供"官方插件"与"自定义插件"两个独立页签，替代官方平面"插件列表" |

版本：**1.2.1**（v1.2.1 工具列表改为**整代原子替换**：重复名/异常一律整批拒绝并保留上一代，修掉换代时同名工具被旧代 disposer 删掉的 bug；v1.2.0 新增 lazy 按需注入 + `mcp_tools` 网关、服务器 `notes` 按需说明、健康探针与诚实的连接状态；v1.1.0 修复「编辑页改名实为报错+删除」问题）。
许可：MIT。

---

## 快速开始

### 安装（以 `$DSH_HOME/profiles/web` 为例）

1. 把本包（或 `lib/`、`package.json`）放到 profile 的
   `node_modules/@dsh-user/dsh-mcp-manager/` 下（`$DSH_HOME` 通常是 `~/.dsh`）。
2. 在 profile 的 `cordis.patch.yml` 中加入接线行：

   ```yaml
   - insert:
       - id: mcp-manager
         name: '@dsh-user/dsh-mcp-manager'
   ```

3. （可选）禁用官方平面插件清单页签，避免与"官方/自定义"双页签冲突：

   ```yaml
   - id: ui-settings-plugin-inventory
     disabled: true
   ```

4. 重启 DSH（`dsh web`）。宿主零 import、无 npm 依赖，拷贝即用。

### 添加一个 MCP 服务器

- **GUI**：设置 → MCP 管理 → "+ 新增服务器"。
  - HTTP 传输：填 MCP 端点 URL（如 `http://127.0.0.1:8000/mcp`），可选请求头（每行 `KEY=VALUE`）。
  - stdio 传输：填命令（绝对路径或 PATH 中的命令，如 `node`）、参数（每行一个）、环境变量、工作目录。
- **对话**：让 Agent 调用 `mcp_manager` 工具：

  ```json
  { "action": "add", "name": "godot-ai", "transport": "http", "url": "http://127.0.0.1:8000/mcp" }
  { "action": "connect", "name": "godot-ai" }
  ```

保存后配置落盘 `$DSH_HOME/.dsh-mcp-servers.json`，重启后自动重连。

### 使用桥接工具（两种模式）

**默认 lazy：按需注入。** 服务器的工具**不会**出现在模型工具列表里，取而代之的是一个稳定网关 `mcp_tools`：

| 调用 | 作用 |
|---|---|
| `mcp_tools({action:"list"})` | 列出各服务器的工具名 + 一句话描述 + 载入状态，**不含 schema** |
| `mcp_tools({action:"describe", tool:"get_scene_info"})` | 载入该工具的完整参数 schema **以及该服务器的 `notes`** |
| `mcp_tools({action:"call", tool:"…", arguments:{…}, server:"…"})` | 直接调用（`server` 仅在工具重名时需要） |
| `mcp_tools({action:"load", server:"blender"})` | 把该服务器整体提升为常驻注册（回到 lazy 需重载插件） |

为什么这样设计：MCP 工具的 schema 会进入**每一次**请求。实测一台 blender-mcp（28 个工具）在 eager 模式下每请求多带 **28,219 字符**（约 8k–11k tokens），而 lazy 模式的网关只有 **841 字符** —— **降幅 87%**；需要某个工具时再花约 1,100 字符 `describe` 一次。

**eager（旧行为）：** 服务器工具以 `mcp__<服务器名>__<工具名>` 直接注册，例如 `mcp__godot-ai__editor_state`，参数即服务器下发的 `inputSchema`。适合工具少、调用频繁的服务器。

图片结果（如 Blender 的 `get_viewport_screenshot`）在两种模式下都会经 `attachments` 服务落库后以**真实图片块**返回给声明了图片输入的模型；模型不支持图片、或没有 `attachments` 服务、或图片非法/过大时，投影为 `[image unavailable: image/png; …]` 这类带原因的文本，**不会静默丢失，也不会把整个请求搞崩**。

### 健康探针：为什么「已连接」可能骗人

MCP 的 `initialize` 握手成功只证明**桥接进程**活着。`uvx blender-mcp` 在 Blender 没启动时照样握手成功，甚至把后端故障当**成功结果**返回（`isError:false`，错误文本在正文里）。所以：

- 未配置 `healthTool`：GUI 显示「已连接（未校验后端）」—— 不谎报可用。
- 配置了 `healthTool` + `healthExpect`：连接后真调一次探针，返回正文里必须出现 `healthExpect` 才算健康；否则标红「服务不可用（后端未响应）」并附原因。

blender 服务器的推荐值：`healthTool: get_addon_status`、`healthArguments: {"user_prompt":"health probe"}`、`healthExpect: "protocol_version"`。

### mcp_manager 工具

Agent 可直接管理服务器的全部操作：

| action | 用途 |
|---|---|
| `list` / `status` | 列出所有服务器及连接状态 |
| `add` / `update` / `remove` | 增删改配置（改名为 `update` + `originalName` 旧名 + `name` 新名） |
| `connect` / `disconnect` | 建立/断开连接 |
| `health` | 立即跑一次健康探针并返回结果 |
| `tools` | 查看某服务器发现的工具 |
| `call` | 直接调用某服务器的一个工具 |

---

## 仓库结构

```
dsh-mcp-manager/
├── package.json        # 包声明：main = 宿主入口；exports["./client"] = 浏览器 bundle
├── lib/
│   ├── index.js        # 宿主插件（ESM，零 import）—— MCP 客户端、工具桥接、按需网关、GUI RPC
│   └── client.js       # 浏览器端 bundle（设置页 UI + 插件分类页签）
├── test/
│   ├── harness.mjs     # 假 ctx（effect/timeout/fs/settings/subprocess/tools），用于离线跑宿主插件
│   ├── e2e.mjs         # 对真实 MCP 服务器跑端到端断言（模式、网关、notes、图片、探针）
│   ├── generation.mjs  # 工具代际原子替换（畸形列表 → 整批拒绝 + 保留上一代）
│   ├── mock-mcp.mjs    # 可注入畸形工具列表的极简 MCP 服务器
│   └── measure.mjs     # 量 lazy vs eager 的每请求工具负载
├── docs/
│   └── TECHNICAL.md    # 技术文档：架构、实现细节、维护与拓展指南
└── README.md           # 本文件
```

### 跑测试

```bash
# 任意一个 blender-mcp 可执行文件即可（uv 缓存里有）
node test/e2e.mjs  /path/to/blender-mcp.exe   # 端到端（含"后端不可达"方向；Blender 开着时额外覆盖 healthy + 截图）
node test/generation.mjs                      # 工具代际原子替换（自带 mock MCP 服务器，会注入畸形列表）
node test/measure.mjs /path/to/blender-mcp.exe # 打印每请求字符数对比
```

`e2e.mjs` 会故意指向一个死端口来验证探针能识破"握手成功但后端不可用"，因此**不需要**先关掉 Blender。
`generation.mjs` 用 `test/mock-mcp.mjs` 伪造重复工具名等真实服务器不会产生的畸形列表，验证"整批拒绝 + 保留上一代"。

---

## 相关文件（运行时机器的实际位置）

| 路径 | 说明 |
|---|---|
| `$DSH_HOME/.dsh-mcp-servers.json` | MCP 服务器配置（GUI / `mcp_manager` 增删改即写） |
| `$DSH_HOME/profiles/web/cordis.patch.yml` | 组合接线：`mcp-manager` 行 + 官方清单禁用行 |

> 详细架构、踩坑记录与拓展指南见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

## 许可证

MIT License — 见 [LICENSE](LICENSE)。
