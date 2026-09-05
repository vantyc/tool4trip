# TLS renovable + Auth — decisiones (sin apply)

## Verificación cert-manager / HTTP-01

| Pregunta | Respuesta |
|----------|-----------|
| ¿Puede emitir un cert independiente para `tool4speak.com` en ns `viajes`? | **Sí.** Let's Encrypt permite varios certs para el mismo FQDN. El `ClusterIssuer` `letsencrypt-prod` usa `http01.ingress.class: traefik`. |
| ¿Funciona el challenge con el Ingress `/` de ToolForSpeak? | **Sí, en esta infra.** cert-manager crea un Ingress temporal con path `/.well-known/acme-challenge/<token>`, más específico que Prefix `/`. Evidencia: `Certificate/tool4speak-tls` está **Ready** con ese mismo issuer y el catch-all `/` ya existía. Traefik **no** tiene redirect HTTP→HTTPS global en entrypoints (solo `web`/:8000 y `websecure`/:8443). |
| ¿Colisión entre ambos Ingress del mismo host? | **Baja / manejable.** Routers distintos por path (`/` vs `/travel`). Cada uno usa su propio Secret TLS (`tool4speak-tls` vs `viajes-tls`). Ambos certificados son válidos para el mismo SNI; Traefik elige el router por path. |
| ¿Secret TLS final en `viajes`? | **`viajes-tls`** (creado/renovado por el CR `Certificate/viajes-tls`). |

### Qué no hacemos

- Copiar `tool4speak-tls` a mano (no se renueva solo).
- Poner `cert-manager.io/cluster-issuer` en el Ingress **y** un Certificate a la vez (doble dueño). El **Certificate CR** es la fuente de emisión/renovación.

### Riesgo residual

Si en el futuro se añade un redirect HTTP→HTTPS de alta prioridad, habría que anotar el solver con `router.priority` alto (no necesario hoy). Rate-limit LE: un segundo cert del mismo dominio es normal.

---

## YAML a revisar (Auth + TLS + Ingress)

### 1) Auth — Middleware (`03-middleware-basicauth.yaml`)

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: viajes-basicauth
  namespace: viajes
  labels:
    app: viajes-web
spec:
  basicAuth:
    secret: viajes-basic-auth
    realm: Viajes
    removeHeader: true
```

Secret **fuera de Git** — ver `AUTH.md` y `scripts/create-viajes-basic-auth-secret.sh`  
(`htpasswd -nbB` → Secret key `users`).

### 2) TLS — Certificate (`05-certificate.yaml`)

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: viajes-tls
  namespace: viajes
  labels:
    app: viajes-web
spec:
  secretName: viajes-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
    group: cert-manager.io
  dnsNames:
    - tool4speak.com
    - www.tool4speak.com
  usages:
    - digital signature
    - key encipherment
```

### 3) Ingress (`04-ingress.yaml`)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: viajes-web
  namespace: viajes
  labels:
    app: viajes-web
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
    traefik.ingress.kubernetes.io/router.middlewares: viajes-viajes-basicauth@kubernetescrd
spec:
  ingressClassName: traefik
  rules:
    - host: tool4speak.com
      http:
        paths:
          - path: /travel
            pathType: Prefix
            backend:
              service:
                name: viajes-web
                port:
                  number: 80
    - host: www.tool4speak.com
      http:
        paths:
          - path: /travel
            pathType: Prefix
            backend:
              service:
                name: viajes-web
                port:
                  number: 80
  tls:
    - hosts:
        - tool4speak.com
        - www.tool4speak.com
      secretName: viajes-tls
```

---

## Orden exacto de apply (cuando apruebes el deploy)

```bash
# A. Imagen (cuando apruebes push)
npm run validate && npm run lint && npm run build
docker build -t ghcr.io/vantyc/viajes:latest .
docker push ghcr.io/vantyc/viajes:latest

# B. Namespace + pull secret
kubectl apply -f deploy/k3s/00-namespace.yaml
kubectl -n tool4speak get secret ghcr-registry -o json \
  | jq 'del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,
            .metadata.annotations,.metadata.ownerReferences,.metadata.managedFields)
        | .metadata.namespace="viajes"' \
  | kubectl apply -f -

# C. Workload
kubectl apply -f deploy/k3s/01-deployment.yaml
kubectl apply -f deploy/k3s/02-service.yaml

# D. Auth secret (interactivo, fuera de Git) + Middleware
./scripts/create-viajes-basic-auth-secret.sh
kubectl apply -f deploy/k3s/03-middleware-basicauth.yaml

# E. TLS renovable
kubectl apply -f deploy/k3s/05-certificate.yaml
kubectl -n viajes wait --for=condition=Ready certificate/viajes-tls --timeout=300s

# F. Ingress (después de que exista viajes-tls Ready)
kubectl apply -f deploy/k3s/04-ingress.yaml
```

Verificar:

```bash
kubectl -n viajes get certificate,secret,middleware,ingress
curl -sI https://tool4speak.com/          # ToolForSpeak, sin Basic Auth
curl -sI https://tool4speak.com/travel/   # 401 hasta enviar credenciales
```

---

**No se ha hecho push ni apply.** Esperando revisión de estos manifiestos.
