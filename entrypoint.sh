#!/bin/bash
set -e

echo "[entrypoint] Starting: langgraph-js starter"

if [ -n "$VERCEL_AI_GATEWAY_URL" ]; then
  echo "[entrypoint] Using Vercel AI Gateway: $VERCEL_AI_GATEWAY_URL"
  if [ -n "$VERCEL_AI_GATEWAY_KEY" ]; then
    echo "[entrypoint] VERCEL_AI_GATEWAY_KEY: set"
  else
    echo "[entrypoint] WARNING: VERCEL_AI_GATEWAY_KEY not set (gateway may reject requests)"
  fi
elif [ -n "$LLM_BASE_URL" ]; then
  echo "[entrypoint] Using custom LLM endpoint: $LLM_BASE_URL"
elif [ -n "$OPENAI_BASE_URL" ]; then
  echo "[entrypoint] Using OPENAI_BASE_URL override: $OPENAI_BASE_URL"
  if [ -z "$OPENAI_API_KEY" ]; then
    echo "[entrypoint] WARNING: OPENAI_API_KEY not set!"
  else
    echo "[entrypoint] OPENAI_API_KEY: set"
  fi
elif [ -z "$OPENAI_API_KEY" ]; then
  echo "[entrypoint] WARNING: OPENAI_API_KEY not set!"
  echo "[entrypoint] TIP: set VERCEL_AI_GATEWAY_URL + VERCEL_AI_GATEWAY_KEY to route through a gateway"
else
  echo "[entrypoint] OPENAI_API_KEY: set (direct OpenAI)"
fi

# Start agent via LangGraph CLI
echo "[entrypoint] Starting agent on port 8123..."
cd /app/agent
AGENT_PORT=8123 npx --yes @langchain/langgraph-cli dev \
  --host 0.0.0.0 --port 8123 --no-browser 2>&1 &
AGENT_PID=$!
cd /app

sleep 3

# Start Next.js standalone
echo "[entrypoint] Starting Next.js on port ${PORT:-3000}..."
HOSTNAME=0.0.0.0 PORT=${PORT:-3000} node server.js 2>&1 &
NEXT_PID=$!

echo "[entrypoint] Agent=$AGENT_PID Next=$NEXT_PID"
wait -n $AGENT_PID $NEXT_PID
exit $?