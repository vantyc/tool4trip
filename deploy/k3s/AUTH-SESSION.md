# viajes-auth — session cookie (ForwardAuth)
#
## What it is
Small independent Deployment (`viajes-auth`) that:
- Serves a self-contained login form at `GET /travel/login`
- Accepts `POST /travel/api/login` and sets `viajes_session`
- Clears session at `/travel/logout` and `POST /travel/api/logout`
- Answers Traefik ForwardAuth at `GET /_auth/verify`

`viajes-web` (nginx/PWA) is unchanged.

## Cookie
| Attribute | Value |
|-----------|--------|
| Name | `viajes_session` |
| Secure | yes |
| HttpOnly | yes |
| SameSite | Strict |
| Path | `/travel` |
| Max-Age | 30 days |

Token = HMAC-SHA256 signed payload `{u,e}` (no session DB).

## Secrets (not in Git)
```bash
./scripts/create-viajes-session-auth-secret.sh
```
Creates `viajes/viajes-session-auth` with `AUTH_USERNAME`, `AUTH_PASSWORD_HASH`, `SESSION_SECRET`.

## Deploy (pre-cutover)
```bash
# 1) Secret (interactive)
./scripts/create-viajes-session-auth-secret.sh

# 2) Image build/push (from auth/)
docker build -t ghcr.io/vantyc/viajes-auth:latest auth/
docker push ghcr.io/vantyc/viajes-auth:latest

# 3) Workloads + public login Ingress + middleware (not attached to web yet)
kubectl apply -f deploy/k3s/08-auth-deployment.yaml
kubectl apply -f deploy/k3s/09-auth-ingress-public.yaml
kubectl apply -f deploy/k3s/10-middleware-forwardauth.yaml
```

`viajes-web` Ingress keeps Basic Auth until cutover (`11-CUTOVER-SESSION-AUTH.md`).

## Local / in-cluster checks
```bash
kubectl -n viajes port-forward svc/viajes-auth 18080:8080
curl -sS http://127.0.0.1:18080/healthz
curl -sS http://127.0.0.1:18080/travel/login | head
# Login (cookie Secure requires HTTPS browsers; use --insecure tricks carefully).
# Verify without cookie → 302 to login for HTML navigations:
curl -sSI -H 'Accept: text/html' -H 'X-Forwarded-Method: GET' \
  -H 'X-Forwarded-Uri: /travel/' http://127.0.0.1:18080/_auth/verify
```

## Cutover
See `deploy/k3s/11-CUTOVER-SESSION-AUTH.md`. Do not apply
`11-ingress-forwardauth-cutover.yaml` until that checklist is approved.
