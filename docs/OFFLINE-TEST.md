# Prueba manual — PWA offline (etapa 5)

Objetivo: confirmar que tras la primera visita, la app sigue siendo usable sin red
para datos y documentos ya guardados en IndexedDB.

## Preparación

```bash
npm run build
npm run preview
```

Abre: http://localhost:4173/travel/

(En producción será https://tool4speak.com/travel/ — mismo `base`/`scope`.)

## Pasos

1. **Arrancar** la app en `/travel/` (no en `/`).
2. **Cargar seed** San Miguel (FICTICIO) desde la lista de viajes.
3. **Adjuntar** un PDF o JPG real en Documentos (opcional pero recomendado).
4. Navegar: Resumen (reloj DEMO) → Reservas → Itinerario → Docs → Checklist.
5. En DevTools → Network → marcar **Offline** (o Application → Service Workers → Offline).
6. **Recargar** la página (`/travel/` o una ruta directa como `/travel/trips/demo-sma-2026`).
7. Comprobar sin conexión:

| Área | Esperado |
|------|----------|
| Shell / navegación | La UI carga (precache del service worker) |
| Viaje | El viaje DEMO sigue listado |
| Resumen | SIGUIENTE / HOY / CRUCIAL / QUÉ ME FALTA con datos locales |
| Reserva | Horarios y localizadores visibles |
| Documento | Abrir PDF/imagen desde IndexedDB (visor) |
| Checklist | Ítems y poder marcarlos |
| Indicador | Muestra «Sin conexión» |

8. Volver **Online** y confirmar que el indicador pasa a «En línea».

## Qué NO debe pasar

- Pantalla en blanco tras reload offline
- Pérdida de viajes o documentos tras actualizar el service worker
- Intentar cachear Blobs de documentos en Cache API (viven solo en IndexedDB)

## Notas iPhone

- Añadir a pantalla de inicio desde Safari tras una visita online.
- `start_url` / `scope` = `/travel/`.
- Probar safe areas (notch) y el visor de documentos a pantalla completa.
