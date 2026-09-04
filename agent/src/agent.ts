import { z } from "zod";
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import type { RunnableConfig } from "@langchain/core/runnables";

import {
  stateItem,
  stateStreamingMiddleware,
} from "@ag-ui/langgraph/middlewares";

import { todo_tools, TodoSchema } from "./todos.js";
import { query_data } from "./query.js";
import { search_flights } from "./a2ui_fixed_schema.js";
import { generate_a2ui } from "./a2ui_dynamic_schema.js";

const AgentStateSchema = z.object({
  todos: z.array(TodoSchema).default(() => []),
});

const GATEWAY_BASE_URL =
  process.env.VERCEL_AI_GATEWAY_URL ||
  process.env.LLM_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  undefined;

const GATEWAY_API_KEY =
  process.env.VERCEL_AI_GATEWAY_KEY ||
  process.env.LLM_API_KEY ||
  process.env.OPENAI_API_KEY ||
  undefined;

const model: ChatOpenAI = new ChatOpenAI({
  model: "gpt-5.4",
  modelKwargs: { parallel_tool_calls: false },
  timeout: 30000,
  maxRetries: 1,
  ...(GATEWAY_BASE_URL ? { baseURL: GATEWAY_BASE_URL } : {}),
  ...(GATEWAY_API_KEY ? { apiKey: GATEWAY_API_KEY } : {}),
}) as ChatOpenAI;

const __origInvoke = model.invoke.bind(model);
(model as any).invoke = async function diagInvoke(
  input: any,
  config?: RunnableConfig,
): Promise<any> {
  const t0 = Date.now();
  try {
    const result = await __origInvoke(input, config);
    const durationMs = Date.now() - t0;
    const usage = (result as any)?.usage_metadata;
    const contentLen = Array.isArray((result as any)?.content)
      ? (result as any).content.length
      : typeof (result as any)?.content === "string"
        ? (result as any).content.length
        : "n/a";
    console.error(
      `[diag:llm] OK durationMs=${durationMs} tokens≈${usage?.total_tokens ?? contentLen}`,
    );
    return result;
  } catch (e: any) {
    const durationMs = Date.now() - t0;
    const errMsg =
      e?.message || e?.error?.message || String(e).slice(0, 400);
    const status =
      e?.response?.status ||
      e?.status ||
      e?.code ||
      (errMsg.toLowerCase().includes("timeout") ? "TIMEOUT" : undefined);
    console.error(
      `[diag:llm] FAIL status=${status ?? "?"} durationMs=${durationMs} baseURL=${
        GATEWAY_BASE_URL ?? "default"
      } apiKeySet=${!!GATEWAY_API_KEY} msg=${errMsg.slice(0, 400)}`,
    );
    throw e;
  }
};

export const graph = createAgent({
  model,
  tools: [query_data, ...todo_tools, generate_a2ui, search_flights],
  middleware: [
    stateStreamingMiddleware(
      stateItem({
        stateKey: "todos",
        tool: "manage_todos",
        toolArgument: "todos",
      }),
    ) as any,
  ],
  stateSchema: AgentStateSchema,
  systemPrompt: `
    You are a polished, professional demo assistant. Keep responses to 1-2 sentences.

    Tool guidance:
    - Flights: call search_flights to show flight cards with a pre-built schema.
    - Dashboards & rich UI: call generate_a2ui to create dashboard UIs with metrics,
      charts, tables, and cards. It handles rendering automatically.
    - Charts: call query_data first, then render with the chart component.
    - Todos: enable app mode first, then manage todos.
    - A2UI actions: when you see a log_a2ui_event result (e.g. "view_details"),
      respond with a brief confirmation. The UI already updated on the frontend.
  `,
});
