# 程序入口与调用逻辑链条

本文档梳理 `langgraph-js-starter` 的全部启动入口、分层架构以及从用户输入到 Agent 响应的完整调用链路。

---

## 一、程序启动入口

本项目采用 **双进程架构**（前端 Next.js + 独立 Agent 后端），另有可选的 Channels 进程用于 IM 平台接入。

### 1.1 根命令入口

所有启动命令均定义于根目录 [package.json](../package.json)：

| 命令 | 作用 | 实际执行 |
|------|------|----------|
| `yarn dev` | **开发环境一键启动**（推荐） | `concurrently` 并行执行 `dev:ui` + `dev:agent`，蓝色=UI，绿色=Agent |
| `yarn dev:ui` | 仅启动 Next.js 前端 | `next dev --turbopack`（默认端口 `3000`） |
| `yarn dev:agent` | 仅启动 LangGraph Agent 服务 | `cd agent && yarn dev`（端口 `8123`，绑定 `127.0.0.1`） |
| `yarn channel` | 启动 Channels 进程（接入 Slack/Teams 等） | `tsx channel-host.mts`，需配置 `CPK_INTELLIGENCE_API_KEY` |
| `yarn build` / `start` | 生产构建与启动 | 标准 Next.js 产物构建与 SSR 服务 |

> **Windows 注意**：Agent host 强制使用 `127.0.0.1` 而非 `localhost`，规避 IPv6 `::1` 导致的前端 `fetch failed` 问题。配置见 [agent/package.json](../agent/package.json#L12)。

### 1.2 前端 Next.js 入口

Next.js 16 App Router 约定：`src/app/` 下的文件即为路由与页面。

```
src/app/
├── layout.tsx                  ← 根布局（Provider 注入点）
├── page.tsx                    ← 首页（聊天 + 画布主界面）
└── api/copilotkit/[[...slug]]/
    └── route.ts                ← CopilotKit Runtime HTTP API 端点
```

#### 1.2.1 根布局 [layout.tsx](../src/app/layout.tsx)

在最外层注入两个全局 Provider：
- **`ThemeProvider`**：来自 `@/hooks/use-theme`，控制亮/暗主题切换；配合 `<head>` 中阻塞内联脚本避免首屏闪烁（FOUC）。
- **`CopilotKit`**：来自 `@copilotkit/react-core/v2`，核心配置：
  - `runtimeUrl="/api/copilotkit"`：指向 1.2.3 的 API 路由
  - `a2ui={{ catalog: demonstrationCatalog }}`：注册声明式 UI 组件目录（定义于 [declarative-generative-ui/renderers.tsx](../src/app/declarative-generative-ui/renderers.tsx)）
  - `useSingleEndpoint={false}`：启用多端点模式（SSE + REST 分开调用）

#### 1.2.2 首页 [page.tsx](../src/app/page.tsx)

页面骨架：
```
<CopilotChatConfigurationProvider agentId="default">
  ├─ <CopilotThreadsDrawer />       ← 会话历史抽屉（移动端=off-canvas）
  └─ <ExampleLayout>
       ├─ 左/上：<CopilotChat />     ← 聊天 UI（输入框 + 消息流 + 附件）
       └─ 右/下：<ExampleCanvas />   ← 应用画布（Todo List）
```

关键行为：
- `CopilotChatConfigurationProvider` 以 **非受控** 模式持有当前活动线程（`threadId`），抽屉切换会话时自动联动。
- `useGenerativeUIExamples()` + `useExampleSuggestions()` 两个 Hook 分别注册示例工具与建议提示词（聊天输入框下方的快捷按钮）。

#### 1.2.3 Runtime API 端点 [route.ts](../src/app/api/copilotkit/[[...slug]]/route.ts)

Next.js Route Handler，使用 **Hono + Vercel 适配器** 暴露 CopilotKit Runtime：
```typescript
const runtime = new CopilotRuntime({ agents: { default: defaultAgent }, ... })
const app = createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" })
export const GET/POST/PATCH/DELETE = handle(app)
```

核心职责：
- **Agent 注册**：将 `createDefaultAgent()` 返回的实例注册为 `agents.default`
- **可选 Intelligence**：若配置了 `CPK_INTELLIGENCE_API_KEY`，启用 CopilotKit Intelligence（线程持久化、用户识别、Channels 接入）；否则退化为 `InMemoryAgentRunner`（内存态，重启丢会话）
- **MCP 应用**：`mcpApps.servers` 声明了一个 HTTP 型 MCP Server（默认 Excalidraw），Runtime 自动将其暴露的工具注入到 Agent 可用工具集

### 1.3 Agent 定义入口 [src/agent.ts](../src/agent.ts)

前端 Runtime 并不直接持有 LLM 调用，而是通过 `LangGraphAgent` **桥接** 到独立的 Agent 后端进程：

```
createDefaultAgent()
  └─ new LangGraphAgent({
       agentId: "default",
       agentName: "default",
       description: "...",
       deploymentUrl: AGENT_URL || LANGGRAPH_DEPLOYMENT_URL || "http://localhost:8123",
       graphId: "sample_agent",
       langsmithApiKey: process.env.LANGSMITH_API_KEY || "",
     })
```

三个必填字段说明：
- `agentId` / `agentName` / `description`：UI 渲染层硬依赖，缺失会导致事件分发时读 `undefined` 崩溃。
- `deploymentUrl`：Agent 后端地址，前端 Runtime 通过 **HTTP** 将运行指令（`run`、工具 `resume` 等）发往此 URL。
- `langsmithApiKey`：非空时链路 trace 上报到 LangSmith 平台。

### 1.4 Agent 后端入口 [agent/src/agent.ts](../agent/src/agent.ts)

由 `langgraphjs dev` CLI 加载的图定义文件，导出 `export const graph = createAgent({...})`：

| 配置项 | 内容 |
|--------|------|
| **model** | `ChatOpenAI("gpt-5.4")`，带调用耗时/Token 诊断日志包装（`[diag:llm] OK/FAIL` 输出到 stderr） |
| **tools** | `query_data` + `todo_tools`(2个) + `generate_a2ui` + `search_flights`，共 5 个内置工具；MCP 工具由 Runtime 侧注入，不在此列 |
| **middleware** | `stateStreamingMiddleware(stateItem({stateKey:"todos", tool:"manage_todos", toolArgument:"todos"}))` — 监听 `manage_todos` 工具的参数，将其作为 `todos` 状态 **流式推送** 回前端 |
| **stateSchema** | `{ todos: Todo[] }`，Agent 的持久化状态结构 |
| **systemPrompt** | 演示助手的行为约束 + 工具选择指南（如"显示图表前先调用 query_data"） |

### 1.5 Channels 模式入口

当需要把同一个 Agent 暴露到 Slack / Teams 等 IM 平台时，启动第三个独立进程：

#### 1.5.1 宿主进程 [channel-host.mts](../channel-host.mts)

- **无 HTTP 服务器**：该进程只建立一条 **出站 WebSocket** 连接到 CopilotKit Intelligence Gateway，保持长连接不退出。
- 核心流程：
  1. `required("CPK_INTELLIGENCE_API_KEY")` 读环境变量，缺失直接退出。
  2. `new CopilotRuntime({ channels: [createDefaultChannel(...)], intelligence: ... })`
  3. `handler.channels.ready({timeoutMs: 30_000})` — 等待 30s 建立连接，超时或失败非零退出。
  4. 绑定 `SIGINT`/`SIGTERM` 优雅关闭（`channels.stop()`），避免 Gateway 端残留孤儿连接。

#### 1.5.2 Channel 定义 [channels.mts](../channels.mts)

- `resolveChannelName()`：优先读 `INTELLIGENCE_CHANNEL_NAME`，否则解析 `.copilotkit/channels.json` 取声明的唯一 Channel 名。
- `createDefaultChannel(channelName)`：
  - `identifyUser: "platform"` — 交给 Gateway 从平台上下文解析用户身份。
  - `agent(threadId)` 工厂 — 每次收到消息时 **新建** `LangGraphAgent` 并绑定 `threadId`（保证 IM 线程与 Agent 线程一一对应）。
  - `channel.onMessage` — 核心事件回调：调用 `thread.runAgent({prompt: message.contentParts || message.text})` 触发完整 Agent 运行流程，错误时通过 `thread.post()` 向用户道歉。

---

## 二、调用逻辑链条

### 2.1 Web 模式（浏览器聊天界面）

**完整链路**：用户输入 → 前端状态机 → Runtime API → LangGraphAgent HTTP 桥 → Agent 后端 → LLM/工具 → 流式回推 → 前端渲染。

```
① 用户在 <CopilotChat /> 输入框提交文本
   │
   ▼
② [前端] useAgent().addMessage({role:"user"}) + runAgent()
   │  CopilotKit react-core 内部将消息入队并触发 /connect + /run
   │
   ▼
③ [HTTP] POST /api/copilotkit/...   (SSE 流式响应)
   │
   ▼
④ [后端] createCopilotHonoHandler → CopilotRuntime.dispatch
   │  定位 agents.default（LangGraphAgent 实例）
   │
   ▼
⑤ [桥接] LangGraphAgent 通过 HTTP 调用 deploymentUrl
   │  典型端点：
   │    POST /runs/<graphId>/stream  →  流式运行图
   │    POST /runs/<id>/resume       →  人在循环恢复
   │
   ▼
⑥ [Agent 后端] langgraphjs HTTP Server 接收请求
   │  加载 graph = createAgent(...) 并执行
   │
   ├─► 6a. LLM 推理
   │      ChatOpenAI.invoke() 包装诊断日志
   │      baseURL 优先级：VERCEL_AI_GATEWAY_URL > LLM_BASE_URL > OPENAI_BASE_URL
   │
   ├─► 6b. 模型决定调用工具 (Function/Parallel Tool Call)
   │      ├─ query_data        → 读取 agent/src/db.csv 返回 JSON
   │      ├─ manage_todos      → 通过 Command({update:{todos}}) 写状态
   │      ├─ get_todos         → 读取当前 todos 状态
   │      ├─ generate_a2ui     → 内部起子 LLM 渲染 declarative UI
   │      ├─ search_flights    → 按固定 Schema 生成机票数据
   │      └─ MCP 工具          → Runtime 代理转发到 mcp.excalidraw.com 等
   │
   └─► 6c. stateStreamingMiddleware 拦截
          从 manage_todos 工具参数提取 todos 数组
          作为 state_key=todos 的增量事件推回
   │
   ▼
⑦ [流式回推] Agent 后端 → LangGraphAgent 桥 → Runtime → SSE → 前端
   │  事件类型：
   │    ├─ messages/Delta    → CopilotChat 增量渲染打字机效果
   │    ├─ ToolCall Begin/End → 显示工具调用状态
   │    ├─ CustomEvent (a2ui / open_gen_ui) → 触发 UI 组件渲染
   │    └─ stateUpdate (todos) → 更新 agent.state.todos
   │
   ▼
⑧ [前端渲染]
   ├─ <CopilotChat />          → 消息气泡 + 工具调用徽章
   ├─ <ExampleCanvas />        → useAgent().state.todos → <TodoList /> 实时刷新
   └─ A2UI / OpenGenUI         → demonstrationCatalog 匹配组件名 → 对应 React renderer
```

### 2.2 Channels 模式（Slack/Teams 等）

```
① 用户在 Slack 发送：@DemoBot 帮我查下周去北京的机票
   │
   ▼
② Slack Webhook → CopilotKit Intelligence Gateway
   │
   ▼
③ Gateway 通过已建立的 WebSocket 推送消息到 channel-host 进程
   │
   ▼
④ [channel-host] channel.onMessage 触发
   │  thread.runAgent({prompt: message.text})
   │
   ▼
⑤ createDefaultAgent() → LangGraphAgent → deploymentUrl
   │  ※ 从这一步开始的 LLM 推理 / 工具执行 / 状态中间件
   │     与 Web 模式完全复用（同一条链路）
   │
   ▼
⑥ Agent 完成后，Channel 回调中调用 thread.post(回复内容)
   │
   ▼
⑦ Gateway → Slack → 用户看到机器人回复（支持卡片、按钮等富文本）
```

### 2.3 状态同步机制（Todos 示例）

以 `todos` 状态从 Agent 后端 → 前端画布为例，展示状态闭环：

```
用户消息："把'写周报'标记为完成"
   │
   ▼
LLM 调用 manage_todos(todos=[{id:"1",title:"写周报",status:"completed",...}])
   │
   ▼
manage_todos 工具返回 new Command({ update: { todos, messages: [...] } })
   │  └─ Command 是 LangGraph 内置对象，同时更新 state 与 messages
   │
   ▼
stateStreamingMiddleware 监听到该工具的 todos 参数
   │  构造 state_item(todos) 事件进入流
   │
   ▼
Runtime 通过 SSE 将两种事件同时推到前端：
   ├─ tool_message        → 聊天区显示"Successfully updated todos"
   └─ state:todos         → agent.state.todos 被整体替换
   │
   ▼
<ExampleCanvas /> 订阅 useAgent().state.todos
   │  React 重渲染 → <TodoList todos={...} />
   │
   ▼
用户操作 TodoList（打勾/改标题）
   │  onUpdate(updatedTodos) → agent.setState({todos: updatedTodos})
   │  这个 setState 只更新前端，不会发回 Agent
   └─ 如需双向持久化，应触发一次专门的"同步状态"工具调用
```

### 2.4 A2UI 渲染链路

声明式生成式 UI 分两种模式，最终都在 [declarative-generative-ui/renderers.tsx](../src/app/declarative-generative-ui/renderers.tsx) 渲染：

| 模式 | 触发工具 | 流程 |
|------|----------|------|
| **固定 Schema** | `search_flights` | Agent 后端加载 [flight_schema.json](../agent/src/a2ui/schemas/flight_schema.json)，LLM 只返回数据；Runtime 将 `<FlightCard>` + 数据绑定指令下发；前端 `FlightCard` renderer 接收 props 渲染卡片 |
| **动态 Schema** | `generate_a2ui` | Agent 内部启动子 LLM（`bindTools(render_a2ui)`）生成 `{surfaceId, catalogId, components[], data}` 四元组；A2UI renderer 根据 `components[]` 递归选 `Title/Row/Metric/PieChart/...` 渲染 |

两种模式共用同一个 `demonstrationCatalog`，定义于 [layout.tsx#L48](../src/app/layout.tsx#L48-L48) 的 `CopilotKit a2ui={{catalog}}` 属性。

---

## 三、分层速查表

| 层级 | 技术 | 关键文件 | 核心职责 |
|------|------|----------|----------|
| L1 前端 UI | React 19 + Next.js 16 | [page.tsx](../src/app/page.tsx) · [layout.tsx](../src/app/layout.tsx) | 用户输入、消息展示、画布渲染、主题切换 |
| L2 前端 SDK | `@copilotkit/react-core/v2` | `CopilotKit` / `useAgent` / `CopilotChat` | 维护 agent 状态机、SSE 长连接、A2UI 目录 |
| L3 Runtime API | Hono + `@copilotkit/runtime/v2` | [route.ts](../src/app/api/copilotkit/[[...slug]]/route.ts) | 多端点分发、Intelligence 集成、MCP 注入、Runner 调度 |
| L4 Agent 桥 | `@ag-ui/langgraph` | [src/agent.ts](../src/agent.ts) | 将 Runtime 指令翻译为 LangGraph HTTP 协议 |
| L5 Agent 图 | `langchain` + `@langchain/langgraph` | [agent/src/agent.ts](../agent/src/agent.ts) | 图执行、LLM 调度、工具路由、状态中间件 |
| L6 工具实现 | `@langchain/core/tools` | [todos.ts](../agent/src/todos.ts) · [query.ts](../agent/src/query.ts) · [a2ui_fixed_schema.ts](../agent/src/a2ui/a2ui_fixed_schema.ts) · [a2ui_dynamic_schema.ts](../agent/src/a2ui/a2ui_dynamic_schema.ts) | 具体业务逻辑（CSV 查询 / Todo 管理 / UI 生成） |
| L7 LLM Provider | OpenAI / Gateway | ChatOpenAI | 模型推理（gpt-5.4） |
| L8 Channels 传输 | `@copilotkit/channels` + Intelligence Gateway | [channel-host.mts](../channel-host.mts) · [channels.mts](../channels.mts) | 与 IM 平台的 WebSocket 双向对接 |
