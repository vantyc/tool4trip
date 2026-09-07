#!/usr/bin/env bash
# Crea/actualiza Secret viajes-session-auth (usuario + bcrypt + SESSION_SECRET).
# NO imprime ni guarda el password en el repo.
set -euo pipefail

NS="${VIAJES_NAMESPACE:-viajes}"
SECRET_NAME="${VIAJES_SESSION_AUTH_SECRET:-viajes-session-auth}"

if ! command -v htpasswd >/dev/null 2>&1; then
  echo "htpasswd no está instalado (apache2-utils / httpd-tools)." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl no está instalado." >&2
  exit 1
fi
if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl no está instalado." >&2
  exit 1
fi

read -r -p "Usuario: " USER
if [[ -z "${USER}" ]]; then
  echo "Usuario vacío." >&2
  exit 1
fi

read -r -s -p "Password: " PASS
echo
read -r -s -p "Confirmar password: " PASS2
echo
if [[ "${PASS}" != "${PASS2}" ]]; then
  echo "Los passwords no coinciden." >&2
  exit 1
fi
if [[ -z "${PASS}" ]]; then
  echo "Password vacío." >&2
  exit 1
fi

# htpasswd line → extract hash only
HASH="$(htpasswd -nbB "${USER}" "${PASS}" | cut -d: -f2 | tr -d '\n')"
SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

kubectl -n "${NS}" create secret generic "${SECRET_NAME}" \
  --from-literal=AUTH_USERNAME="${USER}" \
  --from-literal=AUTH_PASSWORD_HASH="${HASH}" \
  --from-literal=SESSION_SECRET="${SESSION_SECRET}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret ${NS}/${SECRET_NAME} aplicado (usuario=${USER}). Password no se guardó en el repo."
