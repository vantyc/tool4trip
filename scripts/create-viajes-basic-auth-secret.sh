#!/usr/bin/env bash
# Crea/actualiza el Secret viajes-basic-auth en namespace viajes.
# NO imprime ni guarda el password en el repo.
set -euo pipefail

NS="${VIAJES_NAMESPACE:-viajes}"
SECRET_NAME="${VIAJES_BASIC_AUTH_SECRET:-viajes-basic-auth}"

if ! command -v htpasswd >/dev/null 2>&1; then
  echo "htpasswd no está instalado (paquete apache2-utils / httpd-tools)." >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl no está instalado." >&2
  exit 1
fi

read -r -p "Usuario Basic Auth: " USER
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

TMP="$(mktemp)"
cleanup() { rm -f "${TMP}"; }
trap cleanup EXIT

# -n: sin crear archivo; -b: password en argv; -B: bcrypt
htpasswd -nbB "${USER}" "${PASS}" | tr -d '\n' > "${TMP}"

kubectl -n "${NS}" create secret generic "${SECRET_NAME}" \
  --from-file=users="${TMP}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret ${NS}/${SECRET_NAME} aplicado. No se guardó el password en disco del repo."
