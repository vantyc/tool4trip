# Cutover plan — Basic Auth → viajes-auth ForwardAuth
#
# Status before cutover (this phase):
#   ✅ viajes-auth Deployment/Service deployed
#   ✅ Secret viajes-session-auth present
#   ✅ Middleware viajes-forwardauth created (NOT attached to viajes-web)
#   ✅ Ingress viajes-auth-public for /travel/login (+ api/login, logout)
#   ✅ viajes-web Ingress STILL uses basicAuth
#   ❌ Do NOT apply 11-ingress-forwardauth-cutover.yaml until checklist below
#
# ---------------------------------------------------------------------------
# Pre-cutover validation (already done / re-check)
# ---------------------------------------------------------------------------
# 1. kubectl -n viajes get deploy,svc,middleware,ingress
# 2. Port-forward auth and exercise login/verify/logout (see AUTH-SESSION.md)
# 3. https://tool4speak.com/travel/login shows HTML form WITHOUT Basic Auth
# 4. https://tool4speak.com/travel/ still challenges Basic Auth (unchanged)
#
# ---------------------------------------------------------------------------
# Cutover (single Ingress replace — no public window)
# ---------------------------------------------------------------------------
# A. Confirm auth pods Ready:
#      kubectl -n viajes rollout status deploy/viajes-auth
#
# B. Atomic switch (ForwardAuth replaces Basic Auth on viajes-web):
#      kubectl apply -f deploy/k3s/11-ingress-forwardauth-cutover.yaml
#
#    After this, protection is cookie session only. Login paths remain on
#    viajes-auth-public (no ForwardAuth). There is no ungated /travel/.
#
# C. Immediate verify (desktop):
#      curl -sSI https://tool4speak.com/travel/ | head
#        → 302 Location: /travel/login   (or Traefik-forwarded 302)
#      curl -sS https://tool4speak.com/travel/login | head
#        → HTML "Viajes" login form
#      # login POST → Set-Cookie: viajes_session=...; then /travel/ → 200 HTML
#      curl -sSI https://tool4speak.com/ | head
#        → 200 Tool4Speak (unchanged)
#
# D. iPhone Safari:
#      Open https://tool4speak.com/travel/ → form → login → app
#
# E. iPhone PWA standalone:
#      Open home-screen icon → form (not blank) → login → Viajes
#      Kill and reopen → still in app (cookie)
#      Visit https://tool4speak.com/travel/logout → back to form
#      Airplane mode → previously cached shell + IndexedDB still work
#
# F. Only after C–E pass, remove Basic Auth leftovers:
#      kubectl -n viajes delete middleware viajes-basicauth
#      kubectl -n viajes delete secret viajes-basic-auth
#      # Optionally update deploy/k3s/04-ingress.yaml in git to match cutover
#
# G. Rollback (if needed):
#      kubectl apply -f deploy/k3s/04-ingress.yaml
#      # Restores basicAuth middleware on viajes-web
#      # Public login Ingress can stay (harmless) or be deleted
#
# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------
# - Logout does NOT clear IndexedDB (auth service never touches client storage).
# - SW/PWA assets stay behind ForwardAuth; first online visit after login
#   precaches as today.
# - Do not delete viajes-session-auth Secret.
