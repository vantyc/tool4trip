#!/usr/bin/env bash
# Run on vandesk (has kubectl + docker login to ghcr).
# Applies Postgres + trip-api + ingress, then rollouts web + travel-agent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS=tool4trip

cd "$ROOT"
git fetch origin
git checkout cursor/cloud-agent-1789495870419-r69zt
git pull origin cursor/cloud-agent-1789495870419-r69zt

# DB secret (idempotent)
if ! kubectl -n "$NS" get secret trip-api-db >/dev/null 2>&1; then
  echo "Creating trip-api-db secret…"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)}"
  echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" "$ROOT/scripts/create-trip-api-db-secret.sh"
fi

kubectl apply -f "$ROOT/deploy/k3s/tool4trip/09-postgres.yaml"
kubectl apply -f "$ROOT/deploy/k3s/tool4trip/10-trip-api.yaml"
kubectl apply -f "$ROOT/deploy/k3s/tool4trip/06-ingress.yaml"

kubectl -n "$NS" rollout status statefulset/postgres --timeout=300s || true
kubectl -n "$NS" rollout restart deploy/trip-api
kubectl -n "$NS" rollout restart deploy/travel-agent
kubectl -n "$NS" rollout restart deploy/tool4trip-web

kubectl -n "$NS" rollout status deploy/trip-api --timeout=180s
kubectl -n "$NS" rollout status deploy/travel-agent --timeout=180s
kubectl -n "$NS" rollout status deploy/tool4trip-web --timeout=180s

echo "=== pods ==="
kubectl -n "$NS" get pods,svc
echo "=== healthz trip-api ==="
kubectl -n "$NS" exec deploy/trip-api -- wget -qO- http://127.0.0.1:8080/healthz || true
echo
echo "Prod apply done. Open https://tool4trip.com/ and re-test Ask Travel."
