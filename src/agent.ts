/**
 * @file agent.ts
 * @description 构建供 CopilotKit v2 Runtime 使用的 LangGraph Agent 实例。
 *   原 @copilotkit/runtime/langgraph 已弃用，改用上游 @ag-ui/langgraph（由 runtime 传递依赖提供）。
 */
import { LangGraphAgent, type LangGraphAgentConfig } from "@ag-ui/langgraph";

/**
 * 创建默认的 LangGraph Agent 实例。
 * @returns 配置完成的 LangGraphAgent 实例，可直接注入 CopilotRuntime.agents
 */
export function createDefaultAgent(): LangGraphAgent {
  const config: LangGraphAgentConfig = {
    // 地址优先级：AGENT_URL > LANGGRAPH_DEPLOYMENT_URL > localhost:8123
    deploymentUrl:
      process.env.AGENT_URL ||
      process.env.LANGGRAPH_DEPLOYMENT_URL ||
      "http://localhost:8123",
    graphId: "sample_agent",
    // LangSmith 追踪 Key，为空则不上报
    langsmithApiKey: process.env.LANGSMITH_API_KEY || "",
  };
  return new LangGraphAgent(config);
}
