# Plan de despliegue k3s — Viajes (ETAPA 6)

**Estado:** propuesto, **NO aplicado**.

Documentos satélite: [`TLS-AUTH.md`](TLS-AUTH.md) · [`AUTH.md`](AUTH.md)

---

## 1. Estado real del cluster (inspeccionado)

| Recurso | Valor observado |
|---------|-----------------|
| Contexto kubectl | `productos-master1` |
| Ingress controller | Traefik **v3.6.7** (`traefik` namespace, LB `5.161.35.4`) |
| Cert issuer | `letsencrypt-prod` (ClusterIssuer Ready, HTTP-01 → class `traefik`) |
| Namespace ToolForSpeak | **`tool4speak`** |
| Deployment | `tool4speak` → `ghcr.io/vantyc/tool4speak:latest` |
| Service | `tool4speak` ClusterIP :80 |
| Ingress | `tool4speak` (class `traefik`) |
| Hosts | `tool4speak.com`, `www.tool4speak.com` |
| Path ToolForSpeak | `/` **Prefix** → service `tool4speak:80` |
| TLS ToolForSpeak | Secret/Certificate `tool4speak-tls` (Ready) |
| Pull secret | `ghcr-registry` en `tool4speak` |
| Namespace `viajes` | **no existe** todavía |

Traefik prioriza el path más largo: `/travel` gana sobre `/`. No hay redirect HTTP→HTTPS global en entrypoints.

---

## 2. Arquitectura

```
https://tool4speak.com/        → Ingress tool4speak  [SIN CAMBIOS]
https://tool4speak.com/travel/ → Ingress viajes-web

Nota PWA: Tool4Speak registra un SW con `scope: /`. Su `NavigationRoute`
debe denylistear `/travel` (`navigateFallbackDenylist`); si no, Chrome
sirve el `index.html` de Tool4Speak en `/travel` sin llegar al Ingress.
                                      ├─ Middleware basicAuth
                                      ├─ TLS Secret viajes-tls (Certificate CR)
                                      └─ Service/Deployment viajes-web
```

Sin API / DB / PVC. Persistencia = IndexedDB en el cliente.

---

## 3. TLS renovable (sin copiar secrets)

| Pregunta | Respuesta |
|----------|-----------|
| ¿Cert independiente en ns `viajes`? | **Sí** — `Certificate/viajes-tls` → Secret **`viajes-tls`** |
| ¿HTTP-01 con catch-all `/`? | **Sí** — challenge en `/.well-known/acme-challenge/*`; evidencia: `tool4speak-tls` ya se emitió así |
| ¿Colisión de Ingress mismo host? | Baja: routers por path; secrets TLS distintos |
| ¿Secret final? | `viajes/viajes-tls` |

No usar anotación `cert-manager.io/cluster-issuer` en el Ingress (el Certificate CR es el dueño de la emisión).

---

## 4. Auth

**Traefik Basic Auth** — Middleware `viajes-basicauth` + Secret `viajes-basic-auth` (`users` = htpasswd bcrypt).

Crear Secret fuera de Git: [`AUTH.md`](AUTH.md) / `./scripts/create-viajes-basic-auth-secret.sh`

---

## 5. Manifiestos

```
deploy/k3s/
  00-namespace.yaml
  01-deployment.yaml
  02-service.yaml
  03-middleware-basicauth.yaml
  04-ingress.yaml
  05-certificate.yaml
```

---

## 6. Orden de apply (tras tu OK de push/deploy)

Ver YAML finales y orden detallado en [`TLS-AUTH.md`](TLS-AUTH.md).

Resumen:

1. build + push imagen  
2. namespace + `ghcr-registry`  
3. deployment + service  
4. Secret basic-auth (script) + middleware  
5. Certificate → wait Ready  
6. Ingress  

---

## 7. Rollback

Borrar solo recursos de `viajes` (Ingress, Certificate, Middleware, Deployment, Service, Secrets, Namespace). ToolForSpeak intacto.

---

**DETENTE.** No push ni apply hasta aprobación de Auth + Certificate + Ingress.
