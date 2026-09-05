# Basic Auth Secret — NO aplicar desde Git con credenciales reales
#
# Traefik Middleware basicAuth espera un Secret con la clave `users`
# cuyo contenido son líneas htpasswd (usuario:hash).
#
# Formato correcto (bcrypt):
#
#   htpasswd -nbB 'TU_USUARIO' 'TU_PASSWORD'
#   →  TU_USUARIO:$2y$05$...
#
# Crear el Secret (fuera del repositorio):
#
#   # 1) Generar línea htpasswd (no commitear el archivo)
#   htpasswd -nbB 'TU_USUARIO' 'TU_PASSWORD' | tr -d '\n' > /tmp/viajes-users
#
#   # 2) Crear Secret en el cluster (ns viajes debe existir)
#   kubectl -n viajes create secret generic viajes-basic-auth \
#     --from-file=users=/tmp/viajes-users \
#     --dry-run=client -o yaml | kubectl apply -f -
#
#   # 3) Borrar el archivo local
#   rm -f /tmp/viajes-users
#
# Rotar password: repetir los pasos (kubectl apply actualiza el Secret).
#
# Script helper (pide password de forma interactiva):
#   ./scripts/create-viajes-basic-auth-secret.sh
#
# El Secret NO va en este repo. Ejemplo de estructura (valores falsos):
#
# apiVersion: v1
# kind: Secret
# metadata:
#   name: viajes-basic-auth
#   namespace: viajes
# type: Opaque
# stringData:
#   users: |
#     REPLACE_USER:$2y$05$REPLACE_WITH_REAL_BCRYPT_HASH
