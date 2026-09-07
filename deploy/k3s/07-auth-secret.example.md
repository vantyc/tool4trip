# Secret viajes-session-auth — NO aplicar desde Git con valores reales.
#
# Keys:
#   AUTH_USERNAME       — single user (e.g. travel)
#   AUTH_PASSWORD_HASH  — bcrypt hash ($2y$… from htpasswd -nbB, or $2a$)
#   SESSION_SECRET      — random ≥32 bytes (openssl rand -base64 48)
#
# Helper:
#   ./scripts/create-viajes-session-auth-secret.sh
#
# Example (fake values — do not use):
#
# apiVersion: v1
# kind: Secret
# metadata:
#   name: viajes-session-auth
#   namespace: viajes
# type: Opaque
# stringData:
#   AUTH_USERNAME: "REPLACE_USER"
#   AUTH_PASSWORD_HASH: "$2y$05$REPLACE_WITH_REAL_BCRYPT_HASH"
#   SESSION_SECRET: "REPLACE_WITH_OPENSSL_RAND_BASE64_48"
