# Viajes

Aplicación personal y privada para organizar viajes (offline first).

- **Ruta de producción prevista:** https://tool4speak.com/travel/
- **Repositorio:** https://github.com/vantyc/viajes

## Stack (MVP)

- React + TypeScript + Vite
- PWA (`vite-plugin-pwa`), `base: /travel/`
- IndexedDB vía Dexie
- Capas: UI → application (próximo) → repository interfaces → Dexie

## Desarrollo local

Prerrequisitos: Node.js 22+ y npm.

```bash
npm install
npm run dev
```

La app se sirve en `http://localhost:5173/travel/`.

```bash
npm run build
npm run preview
```

## Estado actual

Etapa 6 — Plan de despliegue k3s (**sin aplicar**):

- Manifiestos en [`deploy/k3s/`](deploy/k3s/)
- Plan detallado: [`deploy/k3s/PLAN.md`](deploy/k3s/PLAN.md)
- Dockerfile + nginx listos para servir bajo `/travel/`

Sin despliegue a producción hasta aprobación explícita.
