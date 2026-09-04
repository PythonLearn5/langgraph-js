import { z } from "zod";
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import {
  copilotkitMiddleware,
  CopilotKitStateSchema,
  zodState,
} from "@copilotkit/sdk-js/langgraph";
import { StateSchema } from "@langchain/langgraph";

import {
  stateItem,
  stateStreamingMiddleware,
} from "@copilotkit/sdk-js/langgraph-middlewares";

import { todo_tools, TodoSchema } from "./todos.js";
import { query_data } from "./query.js";
import { search_flights } from "./a2ui_fixed_schema.js";
import { generate_a2ui } from "./a2ui_dynamic_schema.js";

const AgentStateSchema = new StateSchema({
  todos: zodState(z.array(TodoSchema).default(() => [])),
  ...(CopilotKitStateSchema.fields as Record<string, any>),
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

const model = new ChatOpenAI({
  model: "gpt-5.4",
  modelKwargs: { parallel_tool_calls: false },
  ...(GATEWAY_BASE_URL ? { baseURL: GATEWAY_BASE_URL } : {}),
  ...(GATEWAY_API_KEY ? { apiKey: GATEWAY_API_KEY } : {}),
});

export const graph = createAgent({
  model,
  tools: [query_data, ...todo_tools, generate_a2ui, search_flights],
  middleware: [
    copilotkitMiddleware,
    stateStreamingMiddleware(
      stateItem({
        stateKey: "todos",
        tool: "manage_todos",
        toolArgument: "todos",
      }),
    ),
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
