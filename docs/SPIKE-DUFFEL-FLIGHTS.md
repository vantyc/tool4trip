# Spike Duffel flights (SEARCH only)

Companion to `scripts/spike-duffel-flights.ts`.  
Design approval: `docs/SEARCH-FLIGHTS-PROVIDER-DESIGN.md`.

**Status:** **PAUSED (2026-09-19).**  
MVP pivoted to **schedule-only** (`FlightScheduleProvider`). Fare/offer providers (Duffel, Skyscanner) are out of scope.  
See `docs/SEARCH-FLIGHTS-PROVIDER-DESIGN.md` — primary schedule source: **AeroDataBox**.  
Keep this Duffel spike only if a future `FlightOfferProvider` is revived.

## Endpoint (API v2)

Confirmed from current Duffel docs:

- `POST https://api.duffel.com/air/offer_requests`
- Headers: `Authorization: Bearer <token>`, `Duffel-Version: v2`, `Content-Type: application/json`, `Accept: application/json`
- Query: `return_offers=true`, optional `supplier_timeout` (ms)
- Body: `{ data: { slices: [{ origin, destination, departure_date }], passengers: [{ type: "adult" }], cabin_class?, max_connections? } }`
- One-way = one slice
- Direct required = `max_connections: 0`
- Direct preferred (our spike) = omit `max_connections`, inspect `stops` client-side

Docs:

- https://duffel.com/docs/api/offer-requests/create-offer-request
- https://duffel.com/docs/api/overview/test-mode
- https://duffel.com/docs/api/offers/schema (`expires_at`, segments, amounts)

## Credencial

| Variable | Valor |
| --- | --- |
| `DUFFEL_ACCESS_TOKEN` | Access token del dashboard Duffel |

- **Test (preferido):** token empieza por `duffel_test_`
- **Live:** `duffel_live_` — no usar en spike salvo decisión explícita

### Cómo obtener el test token

1. Crear cuenta / entrar en https://duffel.com
2. Dashboard → **Developers**
3. Activar **Developer test mode**
4. **Access tokens** → Create → copiar token (`duffel_test_…`)
5. Docs: https://duffel.com/docs/api/overview/test-mode

### Config local (nunca en git)

```bash
export DUFFEL_ACCESS_TOKEN='duffel_test_...'

# o archivo gitignored:
# echo "DUFFEL_ACCESS_TOKEN=duffel_test_..." > .env.duffel
# echo '.env.duffel' >> .gitignore   # si aún no está
# set -a && source .env.duffel && set +a
```

## Ejecución

Caso original (no cambiar en silencio si falla por fecha):

```bash
npx tsx scripts/spike-duffel-flights.ts \
  --origin MEX --destination GDL --departure-date 2026-09-19 \
  --adults 1 --non-stop off
```

Si Duffel rechaza `2026-09-19` (fecha pasada / no consultable), **documentar el rechazo** y correr segundo caso:

```bash
npx tsx scripts/spike-duffel-flights.ts \
  --origin MEX --destination GDL --departure-date 2026-10-03 \
  --adults 1 --non-stop off
```

Luego, si hace falta, comparar inventario completo vs required:

```bash
# required non-stop
npx tsx scripts/spike-duffel-flights.ts \
  --origin MEX --destination GDL --departure-date 2026-10-03 \
  --adults 1 --non-stop required
```

Fixture sanitizada opcional:

```bash
npx tsx scripts/spike-duffel-flights.ts \
  --origin MEX --destination GDL --departure-date 2026-10-03 \
  --adults 1 --non-stop off \
  --write-fixture scripts/fixtures/duffel-mex-gdl.sanitized.json
```

## Test mode (docs oficiales)

| Aspecto | Qué dice Duffel |
| --- | --- |
| Aislamiento | Tokens test solo ven recursos test; live solo live |
| Airline sandboxes | Externos; sin garantías fuertes (mantenimiento, inventory agotado) |
| Duffel Airways (`ZZ`) | Airline sintética fiable en test; **schedules/prices no realistas** |
| Otros carriers en test | Pueden aparecer vía sandboxes; **no asumir = inventario live MX** |

`providerMode` en el spike se deduce del prefijo del token (`test` / `live`).

## nonStop preferred vs required

| Modo spike | Request Duffel | Uso |
| --- | --- | --- |
| `--non-stop off` (default) | sin `max_connections` | Observar inventario completo |
| `--non-stop preferred` | sin `max_connections` | Igual request; summary cuenta directos vs escalas (preferencia nuestra) |
| `--non-stop required` | `max_connections: 0` | Filtro server-side Duffel |

Futuro contrato `searchFlights`: mapear `nonStop: true` → **required** (`max_connections: 0`) si el usuario pide “solo directos”; si es “preferible directo”, omitir filtro y ordenar/priorizar `stops===0` en normalización.

## Search-to-book (comercial) — SEARCH + EVIDENCE sin booking

Fuentes: [pricing](https://duffel.com/pricing), [Services Agreement §2.3](https://duffel.com/services-agreement), [Help: search limits](https://help.duffel.com/hc/en-gb/articles/360019684099-Is-there-any-limit-to-how-many-searches-I-can-make)

- Ratio: **1500:1**; excess **$0.005**/search
- **Corrección:** `zero Orders shall be treated as one Order` → con 0 orders hay hasta **1500** searches incluidas antes de excess (no “cada search cobra”)
- Help Centre: Managed Content **may not suit metasearch**
- Producto Tool4Trip (buy elsewhere): Duffel = **secondary**; primary = Skyscanner (ver design doc)

## Resultados reales

_Pending — `DUFFEL_ACCESS_TOKEN` ausente en este entorno el 2026-09-19._

Cuando exista token, pegar aquí (o adjuntar salida del spike) las secciones:

- HTTP status / elapsedMs
- totalOffers
- AM / Y4 / VB present
- sample offers
- unequivocalRouteAndDate
- GO / NO-GO

## GO / NO-GO (provisional)

| Criterio | Estado |
| --- | --- |
| Script spike | **GO** (listo) |
| Validación empírica MEX→GDL | **NO-GO hasta llamada real** |
| Integración `searchFlights` en agente | **NO-GO** (explícitamente diferida) |
| Consulta comercial search-only | **Requerida antes de prod** |
