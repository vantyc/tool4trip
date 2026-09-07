# Tool4Trip — namespace + dominio tool4trip.com

PWA en `/` (raíz). Auth ForwardAuth + cookie `tool4trip_session`.
Agent: `POST /api/agent/ask` → `travel-agent` (Groq + Tavily).

## Apply

```bash
kubectl apply -f deploy/k3s/tool4trip/00-namespace.yaml
# secrets: ghcr-registry + tool4trip-session-auth (03-secret.example.yaml)
# + travel-agent-llm (abajo) ANTES de aplicar 07-travel-agent.yaml
kubectl apply -f deploy/k3s/tool4trip/
```

## Secret LLM + Tavily (valores reales; no commits)

```bash
kubectl -n tool4trip create secret generic travel-agent-llm \
  --from-literal=LLM_API_KEY='YOUR_GROQ_API_KEY' \
  --from-literal=TAVILY_API_KEY='YOUR_TAVILY_API_KEY' \
  --dry-run=client -o yaml | kubectl apply -f -
```

Plantilla sin valores: `08-travel-agent-secret.example.yaml`.

Env no secretos (en Deployment):

- `LLM_PROVIDER=openai-compatible`
- `LLM_BASE_URL=https://api.groq.com/openai/v1`
- `LLM_MODEL=llama-3.3-70b-versatile`
- `WEB_SEARCH_PROVIDER=tavily`
- `ENABLE_DDG_FALLBACK=0`
- `AGENT_MAX_TOOL_CALLS=6` / `AGENT_MAX_STEPS=8` / `LLM_TIMEOUT_MS=60000`

Fallback OpenAI (solo env, sin tocar PWA):

```text
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4.1-mini
# LLM_API_KEY = key OpenAI en el mismo Secret
```

## Verify

- `https://tool4trip.com/` → PWA
- `https://tool4trip.com/login` → form
- `https://tool4trip.com/api/agent/ask` → detrás de ForwardAuth
