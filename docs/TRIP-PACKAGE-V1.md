# TripPackage v1 — contrato de importación de investigación

Formato JSON estable para que un agente (p. ej. Cursor) entregue investigación de viaje
que la PWA Viajes puede **validar → previsualizar → importar/actualizar** sin confundir
opciones investigadas con reservas reales (`Booking`).

## Principios

1. **No inventar datos.** Si no se verificó en fuente, `verificationStatus` = `unverified` o `estimated`.
2. **Siempre que se consulte la web:** guardar `sourceUrl` y `checkedAt` (ISO con offset).
3. **No crear Bookings** en el paquete. Solo `travelOptions` (y opcionalmente itinerario libre, checklist, notas).
4. **No incluir documentos binarios** (PDF/JPG) en v1.
5. **`schemaVersion` obligatorio** y debe ser `1`. Campos desconocidos → rechazo (schema estricto).
6. **`packageId` estable** entre revisiones del mismo viaje de investigación (p. ej. `sma-2026-research`).
7. **`externalId` obligatorio** en cada opción / ítem importado — identidad de upsert.
8. El agente **solo** puede proponer `researched` \| `shortlisted`. `selected` / `booked` / `rejected` son decisiones del viajero en la PWA y **rechazan** el paquete si aparecen.

## Raíz

| Campo | Obligatorio | Descripción |
|-------|-------------|-------------|
| `schemaVersion` | sí | Literal `1` |
| `packageId` | sí | Id estable de la investigación (no cambia en cada revisión) |
| `revision` | no (default `1`) | Entero ≥ 1; aumenta cuando Cursor re-investiga |
| `generatedAt` | no | ISO+offset de cuándo se generó este JSON |
| `trip` | sí | Datos del viaje |
| `travelOptions` | no (default `[]`) | Opciones investigadas |
| `itineraryItems` | no | Ítems libres (sin Booking) |
| `checklistItems` | no | Checklist |
| `notes` | no | Notas |

## `trip`

| Campo | Obligatorio | Notas |
|-------|-------------|-------|
| `title` | sí | |
| `startDate` / `endDate` | sí | `YYYY-MM-DD`, end ≥ start |
| `timezone` | no | Default `America/Mexico_City` |
| `destination` | no | |
| `goals` | no | Array de strings |
| `id` | no | Si se omite, la PWA genera uno (en reimport se reutiliza el trip del packageImport) |
| `status` | no | `planned` \| `active` \| `archived` |
| `notes` | no | |

## `travelOptions[]`

Representan **investigación**, no reservas confirmadas.

### Tipos (`type`)

`flight` · `lodging` · `bus` · `train` · `transfer` · `car_rental` · `restaurant` · `activity` · `event` · `other`

### Estados en el paquete (`status`) — solo agente

| Valor | Significado |
|-------|-------------|
| `researched` | Encontrada / anotada |
| `shortlisted` | Candidata seria |

**Prohibidos en el JSON:** `selected`, `booked`, `rejected` (decisiones humanas en la PWA).

### Verificación (`verificationStatus`)

| Valor | Significado |
|-------|-------------|
| `verified` | Dato contrastado en fuente en `checkedAt` |
| `estimated` | Aproximado / no confirmado en checkout |
| `unverified` | Sin contraste suficiente |

### Procedencia (`sourceType`)

`cursor` · `manual` · `imported` · `other`  
Para investigación generada por Cursor: **`cursor`**.

### Campos de opción

Obligatorios: `externalId`, `type`, `title`  
Recomendados al investigar web: `sourceUrl`, `checkedAt`, `verificationStatus`, `provider`, precios con `currency`  
Opcionales: horarios ISO+offset, origen/destino, address, phone, description, notes, `priceObserved`

Si hay `priceObserved`, **`currency` es obligatorio** (ISO 4217, p. ej. `MXN`).

Datetimes: ISO 8601 **con offset** (`2026-09-25T07:30:00-06:00`).

`externalId` ejemplos: `flight-volaris-mex-gdl-20260925`, `hotel-meson-cristeros`, `event-serenata-2026`.

## Itinerario / checklist / notas

También requieren `externalId`. Upsert por id derivado; no se borran ítems ausentes en la nueva revisión.  
Checklist: se preserva `open`/`done` del usuario.  
Itinerario ya vinculado a un `Booking` no se sobrescribe.

## Ejemplo

Ver [`examples/trip-package-example.json`](../examples/trip-package-example.json).

## Flujo en la PWA

1. Usuario elige el `.json`
2. Validación Zod (fallo → cero writes)
3. Preview:
   - Primera vez → **Importar**
   - Mismo `packageId` → **Actualizar investigación** con conteos: Nuevas / Actualizadas / Sin cambios / Decisiones preservadas
4. Confirmación: **Cancelar** / **Importar** o **Actualizar**
5. Upsert transaccional Dexie por `externalId` (no borra opciones ausentes)
6. Vista **Opciones**; convertir a Booking es acción separada

## Upsert y decisiones humanas

| Situación | Comportamiento |
|-----------|----------------|
| `externalId` nuevo | Crea `TravelOption` |
| `externalId` existente | Actualiza datos investigados (precio, URLs, horarios, notas, …) |
| Opción en PWA `selected` / `booked` / `rejected` | **Conserva** ese status (y `bookingId` si existe) |
| Opción ya no viene en el JSON | **No se borra** |
| Bookings / Documents | Intocados |

Ids de entidad: `opt-{packageId}-{externalId}` (análogo para itin/chk/note).

## Convertir a Booking

- Copia campos compatibles a un `Booking` con status `selected` (gestionado, no asume pagado/confirmado).
- Marca la `TravelOption` como `booked` y guarda `bookingId`.
- **No borra** la opción investigada.
- Reimportaciones posteriores **no** rompen el vínculo.

## Revisiones

```json
{
  "packageId": "sma-2026-research",
  "revision": 2,
  "generatedAt": "2026-09-12T18:00:00-06:00"
}
```

No hace falta un `packageId` nuevo por cada investigación del mismo viaje.
