#!/usr/bin/env bash
# ONE-SHOT on vandesk: build, push GHCR, apply k3s tool4trip cloud storage + grounding fix.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS=tool4trip
cd "$ROOT"

git fetch origin
git checkout cursor/cloud-agent-1789495870419-r69zt
git pull --ff-only origin cursor/cloud-agent-1789495870419-r69zt

echo "== docker login ghcr =="
if ! docker pull ghcr.io/vantyc/viajes:latest >/dev/null 2>&1; then
  echo "Need: echo \$GHCR_TOKEN | docker login ghcr.io -u USER --password-stdin"
fi

echo "== build & push =="
docker build -t ghcr.io/vantyc/viajes:latest -f Dockerfile .
docker build -t ghcr.io/vantyc/travel-agent:latest -f travel-agent/Dockerfile .
docker build -t ghcr.io/vantyc/trip-api:latest -f trip-api/Dockerfile .
docker push ghcr.io/vantyc/viajes:latest
docker push ghcr.io/vantyc/travel-agent:latest
docker push ghcr.io/vantyc/trip-api:latest

echo "== k8s apply =="
if ! kubectl -n "$NS" get secret trip-api-db >/dev/null 2>&1; then
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)}"
  echo "Generated POSTGRES_PASSWORD=$POSTGRES_PASSWORD (save it)"
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" "$ROOT/scripts/create-trip-api-db-secret.sh"
fi

kubectl apply -f "$ROOT/deploy/k3s/tool4trip/09-postgres.yaml"
kubectl apply -f "$ROOT/deploy/k3s/tool4trip/10-trip-api.yaml"
kubectl apply -f "$ROOT/deploy/k3s/tool4trip/06-ingress.yaml"

kubectl -n "$NS" rollout status statefulset/postgres --timeout=300s
kubectl -n "$NS" rollout restart deploy/trip-api deploy/travel-agent deploy/tool4trip-web
kubectl -n "$NS" rollout status deploy/trip-api --timeout=180s
kubectl -n "$NS" rollout status deploy/travel-agent --timeout=180s
kubectl -n "$NS" rollout status deploy/tool4trip-web --timeout=180s

kubectl -n "$NS" get pods
kubectl -n "$NS" exec deploy/trip-api -- wget -qO- http://127.0.0.1:8080/healthz
echo
echo "OK — https://tool4trip.com"
