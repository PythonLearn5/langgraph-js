# langgraph-js-starter 功能说明

本项目是一个基于 **CopilotKit v2 Runtime + LangGraph.js** 的完整 Starter，演示了从受控组件到自由生成式 UI、从 Agent 工具调度到跨进程 MCP 服务的 9 大典型场景。所有示例可通过聊天输入框下方的 Suggestion 提示词一键触发。

---

## 一、技术架构概览

| 层级 | 技术栈 | 关键文件 |
|------|--------|----------|
| 前端 UI | Next.js 16 (App Router) + React 19 + CopilotKit/react-core/v2 | [page.tsx](../src/app/page.tsx) |
| Runtime 层 | CopilotKit/runtime/v2 + LangGraphAgent (@ag-ui/langgraph) | [src/agent.ts](../src/agent.ts) · [route.ts](../src/app/api/copilotkit/[[...slug]]/route.ts) |
| Agent 后端 | LangGraph.js (LangChain) + ChatOpenAI + CopilotKit middlewares | [agent/src/agent.ts](../agent/src/agent.ts) |
| 通信 | HTTP (GraphQL/SSE) + 可选 Channels (Slack/Teams WebSocket) | [channel-host.mts](../channel-host.mts) · [channels.mts](../channels.mts) |

---

## 二、核心演示功能

### 1. 受控生成式 UI（Controlled Generative UI）

**场景**：饼图 / 柱状图渲染  
**Agent 工具**：`query_data`（读取本地 CSV 数据源） + 前端声明式组件 `PieChart` / `BarChart`  
**数据流向**：LLM 调用 `query_data` → 工具返回结构化数据 → LLM 选择正确的组件名并填入 data → Runtime 将组件指令下发到前端渲染

- **工具实现**：[agent/src/query.ts](../agent/src/query.ts)
- **组件定义**：[declarative-generative-ui/definitions.ts](../src/app/declarative-generative-ui/definitions.ts)（Title / Row / Column / DashboardCard / Metric / PieChart / BarChart / Badge / DataTable 等）
- **组件渲染**：[declarative-generative-ui/renderers.tsx](../src/app/declarative-generative-ui/renderers.tsx)

### 2. 人在循环（Human In The Loop — 工具中断）

**场景**：会议预约 `scheduleTime`  
**机制**：Agent 发出一个不带 `execute` 的 **interrupt 工具**，运行时暂停（RUN_FINISHED → outcome: interrupt），前端弹出交互式控件让用户选择时间；用户提交后通过 `resume` 注入工具执行结果，Agent 继续后续流程。

### 3. A2UI 固定 Schema（结构化富卡片）

**场景**：机票搜索结果卡片列表  
**Agent 工具**：`search_flights`  
**机制**：后端加载预先写好的 JSON Schema（`flight_schema.json`），LLM 只需按结构化字段返回 2 条机票数据，UI 完全由预定义组件目录 + 数据模型绑定（DynString / path bindings）驱动，保证视觉一致且 LLM 无法「自由发挥」破坏布局。

- **工具实现**：[agent/src/a2ui_fixed_schema.ts](../agent/src/a2ui_fixed_schema.ts)
- **Schema 文件**：[agent/src/a2ui/schemas/flight_schema.json](../agent/src/a2ui/schemas/flight_schema.json)

### 4. A2UI 动态生成式 UI（双 LLM 编排）

**场景**：销售仪表盘（KPI 指标 + 饼图 + 柱状图）  
**Agent 工具**：`generate_a2ui`  
**机制**：主 Agent 触发该工具后，**内部再启动一个子 LLM（gpt-4.1 + bindTools）**，子 LLM 以结构化输出 `render_a2ui` 工具调用，内容包含 `surfaceId`、`catalogId`、`components[]`、`data` 四个域；主工具把这些指令交给 A2UI renderer 渲染。适用于「根据对话上下文自由设计界面」的开放场景。

- **工具实现**：[agent/src/a2ui_dynamic_schema.ts](../agent/src/a2ui_dynamic_schema.ts)
- **A2UI 渲染基础库**：[agent/src/a2ui.ts](../agent/src/a2ui.ts)（`createSurface` / `updateComponents` / `updateDataModel` / `render`）

### 5. MCP 应用集成（Model Context Protocol）

**场景**：Excalidraw 白板绘图  
**配置位置**：[route.ts#L38-L46](../src/app/api/copilotkit/[[...slug]]/route.ts#L38-L46) → `mcpApps.servers`  
**机制**：Runtime 内置 MCP 客户端，通过 HTTP 连接 `https://mcp.excalidraw.com`（或本地 `MCP_SERVER_URL`），将 MCP Server 暴露的工具自动注入到 Agent 的可用工具集；LLM 直接调用即可完成图形绘制。无需手写任何工具包装代码。

### 6. Open Generative UI（沙箱自由 UI 生成）

**场景**：`generateSandboxedUi` 计算器  
**机制**：由 Runtime 的 `openGenerativeUI: true` + `a2ui.injectA2UITool` 配置自动开启。Agent 无需显式工具，LLM 可直接发出任意 HTML/组件片段，在隔离沙箱中渲染执行。适用于「任意一次性交互小部件」的快速原型。

### 7. 前端工具调用（Client Tools）

**场景**：`toggleTheme` 主题切换  
**机制**：工具定义在前端 React 一侧（而非后端 Agent）。Runtime 收到 LLM 的 tool_call 后，不经过 LangGraph，直接分发到前端 `action` 执行；结果再作为 ToolMessage 回写会话历史。用于操作纯前端状态。

### 8. 共享状态同步（App Mode + Canvas）

**场景**：Todo 任务管理器（Agent 侧增删 ↔ 侧栏画布实时展示）  
**Agent 工具**：`manage_todos` / `get_todos`  
**状态同步机制**：
1. `stateStreamingMiddleware(stateItem({ stateKey: "todos", tool: "manage_todos", toolArgument: "todos" }))` 将每次 `manage_todos` 的参数增量同步到 LangGraph `StateSchema.todos`
2. 前端通过 `ExampleLayout.appContent` 挂载 `ExampleCanvas`，从同一 `CopilotChatConfigurationProvider` 读取活跃线程状态
3. 聊天区与画布共享同一个 `agentId` + `threadId`，两者实时双向一致

- **工具 & Schema**：[agent/src/todos.ts](../agent/src/todos.ts)
- **状态 Schema**：[agent/src/agent.ts#L21-L24](../agent/src/agent.ts#L21-L24)

### 9. 多会话线程管理（Threads Drawer）

**场景**：聊天顶部「+ New」与历史线程列表  
**组件**：`<CopilotThreadsDrawer agentId="default" />`  
**机制**：`CopilotKit v2` 官方提供的开箱即用 SSR 安全组件。当配置 `CPK_INTELLIGENCE_API_KEY` 时使用 CopilotKit Intelligence 云端线程存储；未配置时回退到 `InMemoryAgentRunner`（仅当前进程内）。抽屉与 `<CopilotChat>` 通过外层 `CopilotChatConfigurationProvider` 自动联动，无需手动接线。

---

## 三、附加运行模式

### 3.1 Channels 模式（Slack / Teams 等 IM 平台）

在独立 Node.js 进程（非 Next.js）中托管同一个 Agent，并通过 Intelligence Gateway 的 WebSocket 长连接接入 IM 平台。

- 入口：`yarn channel` 脚本（见 [package.json#L16](../package.json#L16)）
- 宿主进程：[channel-host.mts](../channel-host.mts)（负责生命周期、SIGINT/SIGTERM 清理、ready 超时）
- 业务 Channel：[channels.mts](../channels.mts)（声明 `onMessage` → 调用 `thread.runAgent({ prompt })`）
- 特点：无 HTTP 服务、无 Provider 凭证外泄（全部由 Intelligence Gateway 处理）、与 Web 端共享同一个 `createDefaultAgent()` 工厂函数。

### 3.2 LangSmith 可观测性

在 [src/agent.ts#L20](../src/agent.ts#L20) 通过 `LANGSMITH_API_KEY` 环境变量开启。开启后 LangGraph 每次运行的节点路径、输入输出 Token、延迟、状态快照会自动上报到 LangSmith 平台用于线上排障与效果评估。

### 3.3 Docker / AG-UI 模式

在 Docker 环境下 `langgraph-cli` 无法使用 DinD，改为使用 `HttpAgent` 直连 `AGENT_URL:8123`（由 AG-UI 提供）。代码位于 [docker-route-override.ts](../docker-route-override.ts)，与主 `route.ts` 并存，构建时按需切换入口。

---

## 四、快速触发方式

点击聊天输入框下方的 9 个 Suggestion pill，分别对应上述 9 个场景：

| 提示词标题 | 对应章节 |
|-----------|---------|
| Pie Chart (Controlled Generative UI) | §1 |
| Bar Chart (Controlled Generative UI) | §1 |
| Schedule Meeting (Human In The Loop) | §2 |
| Search Flights (A2UI Fixed Schema) | §3 |
| Sales Dashboard (A2UI Dynamic) | §4 |
| Excalidraw Diagram (MCP App) | §5 |
| Calculator App (Open Generative UI) | §6 |
| Toggle Theme (Frontend Tools) | §7 |
| Task Manager (Shared State) | §8 |
