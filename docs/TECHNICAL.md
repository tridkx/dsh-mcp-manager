# dsh-mcp-manager 技术文档

> **English summary** — Architecture and maintenance guide for the DSH MCP
> manager plugin. The host half (`lib/index.js`) is a **zero-import** Cordis
> plugin: it hand-builds ToolDefinitions (raw JSON-Schema `parameters`), speaks
> MCP JSON-RPC 2.0 over stdio (spawned child) or streamable-HTTP (per-request
> `curl` + SSE parsing), persists servers to `$DSH_HOME/.dsh-mcp-servers.json`,
> and exposes a same-origin HTTP route `/mcp-manager/api` for the GUI. The
> client half (`lib/client.js`) is a `window.__ModuleLoader__.load()` bundle
> that registers the settings section and the official/custom plugin tabs.

本文档面向后续维护者（人或 AI Agent），描述本插件的架构、实现细节、维护与拓展方法。
最后更新：2026-08-15（对应 v1.1.0）。

---

## 1. 概述与形态决策

### 1.1 这是什么

一套挂在 DSH Web 宿主组合上的自研插件，提供三块能力：

1. **MCP 服务器管理**：设置页" MCP 管理"可视化增删改（含改名）MCP 服务器配置（stdio / streamable-HTTP），连接/断开、浏览工具、调用测试。
2. **模型工具桥接**：连接成功后把服务器工具注册为 `mcp__<服务器>__<工具>`；另有 `mcp_manager` 管理工具。
3. **插件分类页签**：设置 → 插件 的"官方插件"/"自定义插件"两个独立页签。

### 1.2 形态决策（重要背景）

- 早期用**动态插件**（会话级，`cordis_define`/`cordis_run`）验证功能，但**动态插件随进程重启即失**，无法满足"重启后自动常驻"。
- 最终实现为**宿主组合插件**：一个真实 npm 包 + `cordis.patch.yml` 一行接线。重启后由 DSH 自动加载，服务器自动重连。
- 包安装位置在 profile 目录（`$DSH_HOME/profiles/web`），不依赖 npx 缓存目录；随 DSH 安装恢复时 profile 是持久层。

---

## 2. 架构总览

```
┌──────────────────────────── 浏览器 (GUI) ────────────────────────────┐
│  lib/client.js（__ModuleLoader__ bundle，普通浏览器 JS）              │
│    ├─ 设置页 "MCP 管理"     ──fetch──▶ POST /mcp-manager/api          │
│    ├─ 设置页 "官方/自定义插件" ──ctx.remote.pluginInventory.list()      │
│    └─ styles：<style data-plugin-css="@dsh-user/dsh-mcp-manager">      │
└───────────────────────────────────────────────────────────────────────┘
                          │                        │
                HTTP(Same-origin)            Remote RPC（官方网关）
                          ▼                        ▼
┌──────────────────────────── Host (Node) ─────────────────────────────┐
│  lib/index.js（零 import 的 ESM Cordis 插件）                          │
│    ├─ webServer 路由  /mcp-manager/api  （GUI 的 JSON RPC）           │
│    ├─ ctx.tools.register → mcp_manager + mcp__<server>__<tool>       │
│    ├─ subprocess 服务：stdio 传输（spawn 子进程）                      │
│    ├─ subprocess + curl：HTTP 传输（streamable-http + SSE 解析）      │
│    └─ 配置读写：$DSH_HOME/.dsh-mcp-servers.json                       │
└───────────────────────────────────────────────────────────────────────┘
                          │
              stdio / streamable-http（MCP 协议 JSON-RPC 2.0）
                          ▼
              外部 MCP 服务器（如 godot-ai @ 127.0.0.1:8000/mcp）
```

**关键设计**：宿主插件**零 import**（不 `import` 任何 `@deepseek-ai/*` 包）。原因：
loader 的行名解析域是 profile 目录（`baseUrl` 锚定在 profile 的 `cordis.yml`），profile 的
node_modules 里没有 `@deepseek-ai` 依赖树，import 会解析失败。所有能力都用 Cordis 服务注入
+ 手工构建对象实现（见 §4）。

---

## 3. 文件与位置

| 路径 | 说明 |
|---|---|
| `package.json` | 包声明：`main` = 宿主入口；`exports["./client"]` = 浏览器 bundle；`dsh.client` = 客户端模块声明（platform: web + inject 服务列表） |
| `lib/index.js` | 宿主插件（ESM，零 import） |
| `lib/client.js` | 客户端 bundle（`window.__ModuleLoader__.load({id, factory})` 格式） |
| profile 的 `cordis.patch.yml` | 组合接线：`- id: mcp-manager / name: '@dsh-user/dsh-mcp-manager'`；另有 `ui-settings-plugin-inventory: disabled`（禁用官方平面清单页签）；同文件还可能有 `dsh-winfix`、`dsh-remote` 用户配置行，改动时勿动 |
| `$DSH_HOME/.dsh-mcp-servers.json` | MCP 服务器配置（GUI / `mcp_manager` 增删改即写） |
| profile 的 `package.json` | profile 清单（bundles 列表）；自定义包不需要加进 bundles（patch 行直接引用模块名即可） |

> `$DSH_HOME` 通常是 `~/.dsh`（本机 `C:\Users\DKX\.dsh`）。

---

## 4. 宿主实现细节（lib/index.js）

### 4.1 插件骨架

```js
export const name = 'mcp-manager';
export const inject = ['subprocess', 'timer', 'fs', 'settings', 'tools', 'sandboxPolicy', 'webServer'];
export async function apply(ctx) { /* ... */ }
export default { name, inject, apply };
```

### 4.2 手工 ToolDefinition（关键技巧）

不 import `@deepseek-ai/dsh-tools` 的 `defineTool`，而是**直接构造定义对象**交给
`ctx.tools.register()`。注册层只校验：

- `output` 存在、`output.render` 是函数；
- `output.schema` 通过 `assertSupportedJsonSchema`（注解-only 的 `{}` 即"任意 JSON"，合法）；
- `timeoutMs` 为正数；名字不是保留的 `run_code`。

**`parameters` 注册层不校验、原样插入**（官方注释称其为 "raw register" 通道）。因此
`parameters` 直接给**已编译的 JSON Schema 子集**（object 根 + properties + required +
additionalProperties 布尔）。模型侧 `schemas()` 投影会原样展示。

```js
const tool = {
  name: 'mcp__godot-ai__editor_state',
  description: '[MCP godot-ai] ...',
  parameters: { type: 'object', properties: { session_id: { type: 'string', default: '' } }, additionalProperties: false },
  output: { schema: {}, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
  async execute(args) { /* ... */ },
  timeoutMs: 60000,
};
ctx.tools.register(tool); // 返回 disposer
```

MCP 服务器下发的 `inputSchema` 经 `sanitizeSchema()` 递归裁剪到受支持子集
（object/array/scalar/oneOf + 注解），非对象根包一层 `{ type:'object', properties:{ input: <schema> } }`。

### 4.3 MCP 客户端

- **stdio 传输**：`subprocess.spawn({ argv, cwd, stdio: { stdin:'pipe', stdout:'pipe', stderr:{maxBytes} } })`；
  stdout 按行解析 JSON-RPC；请求 id 关联 pending Map；超时用 `ctx.timeout`。
- **HTTP 传输（streamable-http）**：`subprocess` + `curl.exe`（每请求一个 curl 进程）：

  ```
  curl -sS -i -X POST <url> -H "Content-Type: application/json" \
       -H "Accept: application/json, text/event-stream" \
       [-H "Mcp-Session-Id: <sid>"] --max-time <secs> --data-binary @-
  ```

  - `-i` 必须：靠响应头的 `Mcp-Session-Id` 维持会话（FastMCP 后续请求缺它返回 400 "Missing session ID"）。
  - `Accept` 必须同时接受两者（FastMCP 只接受纯 JSON 会 406）。
  - 响应体按 SSE 解析（`data:` 行），匹配请求 id 的事件为结果；其余事件走 notifier
    （`tools/list_changed` → 重同步）。
- 握手流程：`initialize`（协议版本 2025-03-26）→ `notifications/initialized` → `tools/list`
  （分页 nextCursor 循环）→ 注册工具。
- 子进程退出/连接受挫 → 注销工具、状态置 disconnected/error，stderr 尾部进错误信息。

### 4.4 GUI RPC（/mcp-manager/api）

`webServer.register({ kind:'exact', path:'/mcp-manager/api', handler })`。
POST JSON `{ op, ...payload }` → `runOp()` 分发（list/add/update/remove/connect/disconnect/tools/call）
→ 统一 `{ ok, ... }` / `{ ok:false, error }`。

> 安全注：该路由**无鉴权**。webserver 默认绑定 127.0.0.1；若显式改绑 0.0.0.0，局域网内
> 任何人可借此拉起进程（stdio 服务器）。生产/局域网场景需加鉴权。

### 4.5 启动行为

- `apply` 末尾读配置 → `ctx.timeout(500ms)` 后**自动连接所有已保存服务器**（best-effort，失败仅记 error）。
- 所有 disposer（路由、工具、子进程清理）都包在 `ctx.effect()` 里，插件卸载时自动回收。

---

## 5. 客户端实现细节（lib/client.js）

### 5.1 Bundle 格式

客户端模块是构建产物形态的 CJS bundle：

```js
window.__ModuleLoader__.load({
  id: '@dsh-user/dsh-mcp-manager',        // 必须 = 组合行模块名（graph row id）
  factory: (require) => { ...; exports.apply = apply; return module.exports; },
});
```

- `require('react')` 来自 shell 的 seed 静态模块表（react / react-dom / @deepseek-ai/cordis / primitives 等，均为官方 seed，无需打包）。
- `package.json` 的 `dsh.client: { platform:'web', inject:['slots','locale','remote.pluginInventory'] }` 声明客户端注入。
- 样式：`apply` 里插 `<style data-plugin-css=...>`（模块系统会做归属记账）。

### 5.2 槽位注册

```js
slots.inject('settings.section', () => slots.register(
  { name: 'settings.section', id: 'mcp-manager', order: 25, label: () => 'MCP 管理' },
  (props) => h(McpManagerPage, props),
));
```

插件清单两个页签（独立 id，避免与官方 `all` 冲突——**列表槽同 id 不会替换而是共存，
点击会同时选中**，这是踩过的坑）：

```js
slots.inject('settings.plugins.tab', () => slots.register(
  { name: 'settings.plugins.tab', id: 'official', order: 10, label: () => '官方插件', inject: () => ({ list: makeList(isOfficial) }) },
  (props) => h(CatalogPage, props),
));
slots.inject('settings.plugins.tab', () => slots.register(
  { name: 'settings.plugins.tab', id: 'custom', order: 11, label: () => '自定义插件', inject: () => ({ list: makeList(custom) }) },
  (props) => h(CatalogPage, props),
));
```

### 5.3 分类规则（官方 vs 自定义）

```js
const isOfficial = (e) => e.moduleName.startsWith('@deepseek-ai/') || e.moduleName.startsWith('cordis:');
```

- 官方：`@deepseek-ai/*` 全部 + `cordis:*`（Cordis loader 内置组件，如 `cordis:include`）。
- 自定义：其余。
- 数据源：`ctx.remote.pluginInventory.list()`（官方 Remote，由 api-remotes 启动时挂载；
  客户端 `list` 注入面内做过滤）。条目字段：`entryId / moduleName / enabled / fiberPhase`。

---

## 6. 维护指南

### 6.1 常规操作

| 想做什么 | 怎么做 |
|---|---|
| 查看/管理 MCP 服务器 | 设置 → MCP 管理；或对话里让 Agent 调 `mcp_manager`（list/connect/disconnect/add/update/remove/tools/call） |
| 看连接状态与错误 | GUI 卡片红字即错误详情；宿主日志含 `[mcp-manager]` 前缀 |
| 改服务器配置 | GUI 编辑表单（HTTP：URL/请求头；stdio：命令/参数/环境变量/工作目录/超时） |
| 给服务器改名 | GUI 编辑 → 只改「名称」→ 保存（v1.1.0 起原子完成；原连接状态会断开，需重新连接）；或 `mcp_manager update` 带 `originalName`（旧名）+ `name`（新名） |
| 改插件代码 | 编辑 `lib/*.js` → **重启 DSH 生效**（无热更新） |
| 移除插件 | 删 `cordis.patch.yml` 中 `mcp-manager` 行（`ui-settings-plugin-inventory` 的 disabled 行可一并恢复）→ 重启；可再删包目录与配置文件 |

### 6.2 排查清单

1. **插件没加载**：重启后 `Tool.listTools` 无 `mcp_manager` → 检查 `cordis.patch.yml` 行名与包目录名一致、
   `node --check lib/*.js` 语法、包能否从 profile 解析
   （`require.resolve('@dsh-user/dsh-mcp-manager/package.json', { paths: [profileDir] })`）。
2. **工具没注册**：服务器连接失败（GUI 红字）；或 `registerTools` 逐个 catch 吞错（宿主日志见
   `failed to register mcp__...`）。FastMCP schema 根 `additionalProperties:false` 在**手工注册通道无限制**；
   若以后改回 `defineTool` 通道，须先置根 `additionalProperties:true`。
3. **HTTP 连不上**：先 `curl` 直连验证服务器存活；检查是否缺 `-i`/双 Accept（见 §4.3）；
   检查 `Mcp-Session-Id` 是否透传。
4. **GUI 没显示页签**：检查 `exports["./client"]` 路径、bundle 的 `id` 与行模块名一致、
   `dsh.client` 声明合法；浏览器控制台看模块加载错误。
5. **重启后丢失**：确认包在 profile（而非 npx 缓存）下；`~/.dsh/.dsh-mcp-servers.json` 存在。

---

## 7. 拓展指南

### 7.1 增加新的 MCP 服务器

GUI "+ 新增服务器" 或 `mcp_manager add`（HTTP：`url` 必填；stdio：`command` 必填，可带
`args/env/cwd`）。配置落盘 `~/.dsh/.dsh-mcp-servers.json`，重启自动连接。

### 7.2 增加新的管理操作（op）

1. 宿主 `runOp()` 加 `case 'xxx':`（可复用具名函数）；
2. `mcp_manager` 工具的 `action` enum + description 同步；
3. 客户端 `McpManagerPage` 加对应按钮/表单，`api('xxx', payload)` 调用。

### 7.3 调整插件分类

改 `isOfficial` 规则（§5.3）即可；如想加第三类（如"内置组件"），再注册一个
`settings.plugins.tab` 条目（唯一 id）。

### 7.4 移植到别的机器/环境

- 复制 `@dsh-user/dsh-mcp-manager` 包目录到目标 profile 的 `node_modules/@dsh-user/` 下；
- 复制 `cordis.patch.yml` 中 `mcp-manager` 行（保留官方清单 disabled 行）；
- 复制 `~/.dsh/.dsh-mcp-servers.json`（或按新机器环境重新配置）；
- 重启。宿主零 import，无 npm 依赖，拷贝即用。

---

## 8. 踩坑记录（给后来者的教训）

| # | 坑 | 原因 | 解法 |
|---|---|---|---|
| 1 | `defineTool` 报 "schema.type must be ..." | output.schema 必须显式 `type`，注解-only 不满足 DSL 编译器 | 显式 `{ type:'json' }`（仅 defineTool 通道；手工 register 通道无此要求） |
| 2 | FastMCP 工具全部注册失败 | 其 inputSchema 根 `additionalProperties:false`，DSL 编译器要求根开放 | 根置 `true`（或走手工 register 通道） |
| 3 | HTTP 请求报 "Missing session ID" | curl 未带 `-i`，拿不到响应头 | `-i` + 正则提取 `mcp-session-id`，后续请求带上 |
| 4 | FastMCP 406 Not Acceptable | 只发 `Accept: application/json` | 必须 `Accept: application/json, text/event-stream` |
| 5 | 两个"插件列表"页签、点一个选中两个 | `settings.plugins.tab` 列表槽**同 id 共存不替换** | 用唯一 id（official/custom）+ 禁用官方行 |
| 6 | 动态插件重启即失 | 动态插件进程级 | 组合插件（本方案） |
| 7 | 包名解析失败 | 模块解析域是 profile 目录，无 @deepseek-ai 依赖树 | 零 import 宿主（§4） |
| 8 | 配置文件找不到 | `sandboxPolicy.workspaceRoot` = 宿主进程 cwd（如 `C:\Users\DKX`），非会话工作区 | 改用 `settings.prepareDocument()` 定位 DSH_HOME |
| 9 | 客户端 bundle 语法错 | 手写括号易错（箭头函数不占额外括号） | `node --check` 先行 + 分段提取自检 |
| 10 | `exports` 缺 `./package.json` | client-modules 用 `require.resolve('<pkg>/package.json')` | exports 里补 `"./package.json": "./package.json"` |
| 11 | 编辑页改名实为"报错+删除" | 旧客户端先 `update(新名)` 再 `remove(旧名)`；宿主 `updateServer` 按新名查不到 → 抛 "server not found"，随后旧条目被删 | v1.1.0：宿主支持 `originalName`（旧名）+ `name`（新名）单次原子改名；客户端仅发一次 `update`，不再补 `remove` |

---

## 9. 相关命令速查

```bash
# 语法自检（改完必跑）
node --check lib/index.js
node --check lib/client.js

# 模块解析自检（从 profile 域）
node -e "console.log(require.resolve('@dsh-user/dsh-mcp-manager/client', { paths: ['<profileDir>'] }))"

# 服务器连通性（streamable-http 手测）
curl -sS -i -X POST http://127.0.0.1:8000/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 配置查看
Get-Content "$env:USERPROFILE\.dsh\.dsh-mcp-servers.json"
```
