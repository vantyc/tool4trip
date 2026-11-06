#!/usr/bin/env bash
# Read-only guest for tool4trip.com: sees only the shared trips, cannot change
# anything nor use Ask Travel. Stored in Secret tool4trip-session-auth.
#
#   scripts/tool4trip-guest-access.sh enable <usuario> [viaje1,viaje2]   # default: filipinas-nov-2026
#   scripts/tool4trip-guest-access.sh disable
#
# enable generates a random password and writes it only to
# ~/tool4trip-invitado-<usuario>.txt (mode 600); it is never printed.
set -euo pipefail

NS="${TOOL4TRIP_NAMESPACE:-tool4trip}"
SECRET="tool4trip-session-auth"

for cmd in kubectl htpasswd base64; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Falta $cmd." >&2; exit 1; }
done

restart() {
  kubectl -n "$NS" rollout restart deploy/tool4trip-auth deploy/trip-api >/dev/null
  kubectl -n "$NS" rollout status deploy/tool4trip-auth --timeout=120s
  kubectl -n "$NS" rollout status deploy/trip-api --timeout=180s
}

b64() { printf '%s' "$1" | base64 -w0; }

case "${1:-}" in
  enable)
    GUEST="${2:-}"
    TRIPS="${3:-filipinas-nov-2026}"
    if [[ ! "$GUEST" =~ ^[A-Za-z0-9._-]{3,32}$ ]]; then
      echo "Usuario inválido (3–32 letras, números, . _ -)." >&2
      exit 1
    fi
    OWNER="$(kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.data.AUTH_USERNAME}' | base64 -d)"
    if [[ "$GUEST" == "$OWNER" ]]; then
      echo "El invitado no puede llamarse igual que la cuenta principal." >&2
      exit 1
    fi
    RAW="$(LC_ALL=C tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789' </dev/urandom | head -c 12 || true)"
    [[ ${#RAW} -eq 12 ]] || { echo "No se pudo generar la contraseña." >&2; exit 1; }
    PASS="${RAW:0:4}-${RAW:4:4}-${RAW:8:4}"
    HASH="$(printf '%s' "$PASS" | htpasswd -niBC 10 "$GUEST" | cut -d: -f2-)"
    FILE="$HOME/tool4trip-invitado-$GUEST.txt"
    umask 077
    printf 'Tool4Trip — acceso de solo lectura\nhttps://tool4trip.com\nUsuario: %s\nContraseña: %s\nViajes: %s\n' \
      "$GUEST" "$PASS" "$TRIPS" >| "$FILE"
    unset PASS RAW
    kubectl -n "$NS" patch secret "$SECRET" --type merge -p "{\"data\":{\
\"AUTH_GUEST_USERNAME\":\"$(b64 "$GUEST")\",\
\"AUTH_GUEST_PASSWORD_HASH\":\"$(b64 "$HASH")\",\
\"AUTH_GUEST_TRIPS\":\"$(b64 "$TRIPS")\"}}" >/dev/null
    restart
    echo "Invitado '$GUEST' activo (solo lectura: $TRIPS)."
    echo "Usuario y contraseña en $FILE — compártelos por un canal privado y borra el archivo."
    ;;
  disable)
    kubectl -n "$NS" patch secret "$SECRET" --type merge -p \
      '{"data":{"AUTH_GUEST_USERNAME":null,"AUTH_GUEST_PASSWORD_HASH":null,"AUTH_GUEST_TRIPS":null}}' >/dev/null
    restart
    echo "Acceso de invitado desactivado; su sesión ya no sirve."
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
