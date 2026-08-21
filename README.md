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
| **模型工具桥接** | 连接成功后把服务器的 MCP 工具注册成模型可直接调用的工具：`mcp__<服务器名>__<工具名>`（如 `mcp__godot-ai__editor_state`）；另有管理工具 `mcp_manager` 供 Agent 在对话中直接管理 |
| **插件分类页签** | 在 设置 → 插件 提供"官方插件"与"自定义插件"两个独立页签，替代官方平面"插件列表" |

版本：**1.1.0**（v1.1.0 修复「编辑页改名实为报错+删除」问题，宿主支持原子改名）。
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

### 使用桥接工具

连接成功的服务器，其工具自动以 `mcp__<服务器名>__<工具名>` 注册给模型。
例如 `mcp__godot-ai__editor_state`，参数即服务器下发的 `inputSchema`。

### mcp_manager 工具

Agent 可直接管理服务器的全部操作：

| action | 用途 |
|---|---|
| `list` / `status` | 列出所有服务器及连接状态 |
| `add` / `update` / `remove` | 增删改配置（改名为 `update` + `originalName` 旧名 + `name` 新名） |
| `connect` / `disconnect` | 建立/断开连接 |
| `tools` | 查看某服务器发现的工具 |
| `call` | 直接调用某服务器的一个工具 |

---

## 仓库结构

```
dsh-mcp-manager/
├── package.json        # 包声明：main = 宿主入口；exports["./client"] = 浏览器 bundle
├── lib/
│   ├── index.js        # 宿主插件（ESM，零 import）—— MCP 客户端、工具桥接、GUI RPC
│   └── client.js       # 浏览器端 bundle（设置页 UI + 插件分类页签）
├── docs/
│   └── TECHNICAL.md    # 技术文档：架构、实现细节、维护与拓展指南
└── README.md           # 本文件
```

---

## 相关文件（运行时机器的实际位置）

| 路径 | 说明 |
|---|---|
| `$DSH_HOME/.dsh-mcp-servers.json` | MCP 服务器配置（GUI / `mcp_manager` 增删改即写） |
| `$DSH_HOME/profiles/web/cordis.patch.yml` | 组合接线：`mcp-manager` 行 + 官方清单禁用行 |

> 详细架构、踩坑记录与拓展指南见 [docs/TECHNICAL.md](docs/TECHNICAL.md)。

## 许可证

MIT License — 见 [LICENSE](LICENSE)。
