# TripPackage v1 — contrato de importación de investigación

Formato JSON estable para que un agente (p. ej. Cursor) entregue investigación de viaje
que la PWA Viajes puede **validar → previsualizar → importar** sin confundir
opciones investigadas con reservas reales (`Booking`).

## Principios

1. **No inventar datos.** Si no se verificó en fuente, `verificationStatus` = `unverified` o `estimated`.
2. **Siempre que se consulte la web:** guardar `sourceUrl` y `checkedAt` (ISO con offset).
3. **No crear Bookings** en el paquete. Solo `travelOptions` (y opcionalmente itinerario libre, checklist, notas).
4. **No incluir documentos binarios** (PDF/JPG) en v1.
5. **`schemaVersion` obligatorio** y debe ser `1`. Campos desconocidos → rechazo (schema estricto).
6. **`packageId` obligatorio** y estable: reimportar el mismo id no duplica en silencio.

## Raíz

| Campo | Obligatorio | Descripción |
|-------|-------------|-------------|
| `schemaVersion` | sí | Literal `1` |
| `packageId` | sí | Id estable del paquete (dedupe) |
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
| `id` | no | Si se omite, la PWA genera uno |
| `status` | no | `planned` \| `active` \| `archived` |
| `notes` | no | |

## `travelOptions[]`

Representan **investigación**, no reservas confirmadas.

### Tipos (`type`)

`flight` · `lodging` · `bus` · `train` · `transfer` · `car_rental` · `restaurant` · `activity` · `event` · `other`

### Estados (`status`)

| Valor | Significado |
|-------|-------------|
| `researched` | Encontrada / anotada |
| `shortlisted` | Candidata seria |
| `selected` | Preferida por el viajero (aún no Booking) |
| `booked` | **Prohibido en el JSON de import** — solo tras convertir en la PWA |
| `rejected` | Descartada |

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

Obligatorios: `type`, `title`  
Recomendados al investigar web: `sourceUrl`, `checkedAt`, `verificationStatus`, `provider`, precios con `currency`  
Opcionales: `externalId` (estable dentro del paquete), horarios ISO+offset, origen/destino, address, phone, description, notes, `priceObserved`

Si hay `priceObserved`, **`currency` es obligatorio** (ISO 4217, p. ej. `MXN`).

Datetimes: ISO 8601 **con offset** (`2026-09-25T07:30:00-06:00`).

## Itinerario / checklist / notas (opcionales)

Sin `bookingId`. Sirven para borradores del paquete.  
Ids estables vía `externalId` opcional.

## Ejemplo

Ver [`examples/trip-package-example.json`](../examples/trip-package-example.json).

## Flujo en la PWA

1. Usuario elige el `.json`
2. Validación Zod (fallo → cero writes)
3. Preview (conteos por tipo)
4. Si `packageId` ya existe → advertencia; solo reemplazo explícito
5. Import transaccional Dexie → `TravelOption` + trip (+ opcionales)
6. Vista **Opciones** del viaje; convertir a Booking es acción separada con confirmación

## Convertir a Booking

- Copia campos compatibles a un `Booking` con status `selected` (gestionado, no asume pagado/confirmado).
- Marca la `TravelOption` como `booked` y guarda `bookingId`.
- **No borra** la opción investigada.

## Dedupe

Clave: **`packageId`**.  
Tabla `packageImports` + opciones con el mismo `packageId`.  
Ids de opción derivados: `opt-{packageId}-{externalId}` cuando hay `externalId`.
