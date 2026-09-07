#!/usr/bin/env bash
# Create/update travel-agent-llm Secret in ns tool4trip.
# Usage:
#   LLM_API_KEY=... TAVILY_API_KEY=... ./scripts/create-travel-agent-llm-secret.sh
# Does not print secret values.
set -euo pipefail

NS="${NS:-tool4trip}"
: "${LLM_API_KEY:?Set LLM_API_KEY (OpenAI key)}"
: "${TAVILY_API_KEY:?Set TAVILY_API_KEY}"

kubectl -n "$NS" create secret generic travel-agent-llm \
  --from-literal=LLM_API_KEY="$LLM_API_KEY" \
  --from-literal=TAVILY_API_KEY="$TAVILY_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NS" rollout restart deploy/travel-agent
kubectl -n "$NS" rollout status deploy/travel-agent --timeout=120s
echo "Secret travel-agent-llm applied in $NS (values not shown)."
