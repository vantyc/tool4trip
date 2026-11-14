#!/usr/bin/env bash
# Apply Postgres + trip-api + ingress on the tool4trip k3s cluster.
# Prerequisites: kubectl context, ghcr-registry secret, trip-api image pushed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS="${NS:-tool4trip}"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl required" >&2
  exit 1
fi

if ! kubectl -n "$NS" get secret trip-api-db >/dev/null 2>&1; then
  echo "Creating trip-api-db secret…"
  # shellcheck disable=SC1091
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" "$ROOT/scripts/create-trip-api-db-secret.sh"
fi

kubectl apply -f "$ROOT/deploy/k3s/tool4trip/09-postgres.yaml"
kubectl apply -f "$ROOT/deploy/k3s/tool4trip/10-trip-api.yaml"
kubectl apply -f "$ROOT/deploy/k3s/tool4trip/06-ingress.yaml"

kubectl -n "$NS" rollout status statefulset/postgres --timeout=180s
kubectl -n "$NS" rollout status deploy/trip-api --timeout=180s

echo "Verify:"
echo "  kubectl -n $NS exec deploy/trip-api -- wget -qO- http://127.0.0.1:8080/healthz"
echo "  curl -sS -b cookie.txt https://tool4trip.com/api/trips"
