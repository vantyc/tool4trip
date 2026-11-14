#!/usr/bin/env bash
# Local smoke test for trip-api (requires DATABASE_URL + running server, or starts one).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${TRIP_API_BASE:-http://127.0.0.1:18080}"

curl -sf "$BASE/healthz" | grep -q '"ok":true'
echo "healthz ok"

TRIP_ID="smoke-$(date +%s)"
curl -sf -X POST "$BASE/api/trips" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$TRIP_ID\",\"title\":\"Smoke\",\"startDate\":\"2026-09-20\",\"endDate\":\"2026-09-22\",\"timezone\":\"America/Mexico_City\",\"goals\":[],\"status\":\"planned\",\"createdAt\":\"2026-09-15T00:00:00.000Z\",\"updatedAt\":\"2026-09-15T00:00:00.000Z\",\"syncStatus\":\"synced\"}" \
  | grep -q "$TRIP_ID"
echo "create trip ok"

curl -sf "$BASE/api/trips" | grep -q "$TRIP_ID"
echo "list trips ok"

curl -sf -X DELETE "$BASE/api/trips/$TRIP_ID" -o /dev/null -w "%{http_code}" | grep -q 204
echo "delete trip ok"
echo "trip-api smoke passed"
