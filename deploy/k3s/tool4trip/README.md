# Tool4Trip — namespace + dominio tool4trip.com

PWA en `/` (raíz). Auth ForwardAuth + cookie `tool4trip_session`.
Agent: async Ask Travel — `POST /api/agent/ask` → **202** `{ jobId }` → poll
`GET /api/agent/jobs/:id` (OpenAI + Tavily). Jobs in-memory (replicas=1).
All `/api/agent/*` behind ForwardAuth (`tool4trip-forwardauth`).
`POST /api/agent/ask/sync` disabled in prod unless `ENABLE_ASK_SYNC=1`.

## Apply

```bash
kubectl apply -f deploy/k3s/tool4trip/00-namespace.yaml
# secrets: ghcr-registry + tool4trip-session-auth (03-secret.example.yaml)
# + travel-agent-llm (abajo) ANTES de aplicar 07-travel-agent.yaml
kubectl apply -f deploy/k3s/tool4trip/
```

## Secret LLM + Tavily (valores reales; no commits)

```bash
# Prefer: deploy/k3s/create-agent-secret.sh (local, not committed with keys)
kubectl -n tool4trip create secret generic travel-agent-llm \
  --from-literal=LLM_API_KEY='YOUR_OPENAI_API_KEY' \
  --from-literal=TAVILY_API_KEY='YOUR_TAVILY_API_KEY' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Plantilla sin valores: `08-travel-agent-secret.example.yaml`.

Env no secretos (en Deployment):

- `LLM_PROVIDER=openai-compatible`
- `LLM_BASE_URL=https://api.openai.com/v1`
- `LLM_MODEL=gpt-4.1-mini`
- `LLM_MAX_TOKENS=4096`
- `WEB_SEARCH_PROVIDER=tavily`
- `ENABLE_DDG_FALLBACK=0`
- `LLM_MAX_TOKENS=8192` / `AGENT_MAX_TOOL_CALLS=6` / `AGENT_MAX_STEPS=8` / `LLM_TIMEOUT_MS=180000` (job budget, not HTTP)
- `AGENT_JOB_MAX_CONCURRENCY=1` / `AGENT_JOB_TTL_MS=2700000` / `AGENT_JOB_MAX_JOBS=50`

Swap de proveedor (solo env, sin tocar PWA): cambiar `LLM_BASE_URL` / `LLM_MODEL` / secret `LLM_API_KEY`.

## Verify

- `https://tool4trip.com/` → PWA
- `https://tool4trip.com/login` → form
- `https://tool4trip.com/api/agent/ask` → 202 job (ForwardAuth)
- `https://tool4trip.com/api/agent/jobs/:id` → status / proposal
