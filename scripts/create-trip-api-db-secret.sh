#!/usr/bin/env bash
# Create / update trip-api Postgres secret in tool4trip namespace.
set -euo pipefail

NS="${NS:-tool4trip}"
SECRET_NAME="${SECRET_NAME:-trip-api-db}"
POSTGRES_USER="${POSTGRES_USER:-trip}"
POSTGRES_DB="${POSTGRES_DB:-tool4trip}"

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  echo "Generated POSTGRES_PASSWORD (save it): ${POSTGRES_PASSWORD}"
fi

DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl no está instalado." >&2
  exit 1
fi

kubectl -n "${NS}" create secret generic "${SECRET_NAME}" \
  --from-literal=POSTGRES_USER="${POSTGRES_USER}" \
  --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  --from-literal=POSTGRES_DB="${POSTGRES_DB}" \
  --from-literal=DATABASE_URL="${DATABASE_URL}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret ${SECRET_NAME} applied in ${NS}."
