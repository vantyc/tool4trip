# Flight schedules — Provider Design (SCHEDULE ONLY)

Status: **design only — not implemented**  
Date: 2026-09-19 (revised same day: **schedule-only MVP**)  
Context: Real SMA / NewTravel validation showed `webSearch` + `fetchUrl` cannot reliably obtain day-specific flight schedules. Research coverage correctly left `flight_day_specific` UNRESOLVED without inventing.

## Product requirement (simplified)

Tool4Trip needs **published flight schedules** for a route+date — **not** inventory, fares, offers, booking, checkout, deeplinks, or affiliates.

For `MEX → GDL` on `YYYY-MM-DD`, when evidence exists:

| Field | Required |
| --- | --- |
| origin, destination | yes |
| departureAt, arrivalAt | yes (when published) |
| carrierCode, carrierName | yes when available |
| flightNumber | yes when available |
| stops | yes (0 = nonstop) |
| operatingCarrier | optional |
| source / sourceUrl / checkedAt | yes |

**Semantics:** schedule ≠ seat availability ≠ bookable fare ≠ guaranteed reservation.

UI copy (conceptual): *“HORARIO PUBLICADO — verifica disponibilidad y reserva directamente con la aerolínea.”*

`sourceType` sugerido: `flight_schedule` (provenance; distinct from future `flight_offer` if ever added).

---

## Provider selection for schedule-only model

**Decision date:** 2026-09-19  
**Out of scope for MVP:** Duffel / Skyscanner / any fare-inventory or affiliate API (prior section archived below as historical).

### Case focus: MEX → GDL, AM / Y4 / VB

| Carrier | Public evidence of route activity | API schedule CONFIRMED |
| --- | --- | --- |
| Aeroméxico (AM) | AICM FIDS lists AM flights to Guadalajara (e.g. AM208) | **UNKNOWN** until schedule API spike |
| Volaris (Y4) | AICM lists Y4 domestics; GDL boards list Y4 MEX arrivals | **UNKNOWN** until spike |
| Viva (VB) | AICM lists VB to Guadalajara (e.g. VB1058) | **UNKNOWN** until spike |

Sources: [AICM pasajeros/vuelos](https://www.aicm.com.mx/pasajeros/vuelos) (HTTP 200, public HTML board).

### Candidates evaluated (schedules only)

| Candidate | Access | Cost | Day-specific | Future | Fit |
| --- | --- | --- | --- | --- | --- |
| **AeroDataBox** FIDS | RapidAPI / API.Market / direct; small-dev oriented | Free/trial + Pro from ~$7.50–8/mo; Tier2 FIDS = 2 units/call | YES (local datetime range) | Up to 180–365 days by plan | **PRIMARY** |
| **Aviationstack** `flightsFuture` / schedules | Signup; future endpoints **Basic+** | Free 100 req/mo **without** future schedules; paid from ~$49.99/mo | YES | YES on paid | **SECONDARY** |
| FlightAware AeroAPI | Developer account | Paid per query set | YES | YES | Overkill / cost |
| Airline sites (AM/Y4/VB) | Public web | Free | Often opaque / JS | UNKNOWN | Fragile |
| AICM / GAP boards | Public web | Free | **Near-term / day-of** | GAP: only −2h…+24h | **WEB FALLBACK** |

### PRIMARY SCHEDULE SOURCE: AeroDataBox

| | |
| --- | --- |
| **Cost** | Marketplace Basic free/trial (~400 units); Pro ~$7.50–8/mo (5k units). FIDS = Tier 2 (2 units). Direct Starter $19/mo larger quota. |
| **Access** | Self-serve RapidAPI / API.Market / aerodatabox.com — no IATA/ARC, no MAU gate. |
| **AM/Y4/VB** | **UNKNOWN** (coverage “subject to Data Coverage”; must spike MEX→GDL). |
| **Data** | Airport FIDS: flight number, airline, scheduled times; `withLeg=true` → departure+arrival sides; filter client-side `arrival.airport.iata=GDL`. Stops usually 0 for single-leg FIDS rows. |
| **Endpoint** | `GET /flights/airports/{iata\|icao}/{code}/{fromLocal}/{toLocal}?direction=Departure&withLeg=true` — [docs](https://doc.aerodatabox.com/) / [FIDS notes](https://aerodatabox.com/fids-with-extended-information-flight-time-and-distance) |
| **Provenance** | `source=aerodatabox`, `checkedAt`, attribution required on free Basic. |
| **Blocker** | Must validate Mexico coverage + AM/Y4/VB presence on live spike; Basic free forbids commercial use (paid Pro allows). |

### SECONDARY SOURCE: Aviationstack (paid Basic+)

| | |
| --- | --- |
| **Cost** | Free plan: real-time only, **no** `flightsFuture` / schedules. Future schedules: **Basic+** (~$49.99/mo). |
| **Access** | Self-serve signup + key; no IATA. |
| **AM/Y4/VB** | **UNKNOWN** until spike. |
| **Data** | `GET /v1/flightsFuture?iataCode=MEX&type=departure&date=YYYY-MM-DD` then filter arr IATA GDL — scheduled dep/arr, airline, flight number ([documentation](https://aviationstack.com/documentation)). |
| **Blocker** | Free tier insufficient for future day-specific; higher cost than AeroDataBox for MVP volume. |

### WEB FALLBACK: AICM (+ GAP same-day only)

| | |
| --- | --- |
| **Cost** | Free. |
| **Access** | Public pages; polite `fetchUrl` only — **no** CAPTCHA bypass / anti-bot evasion / private APIs. |
| **AM/Y4/VB** | **CONFIRMED visible** on AICM board for Guadalajara (live HTML sample). |
| **Data** | Airline, flight #, scheduled time, destination, terminal/status — often **departure-only** (arrival may be missing); day-of / operational window. |
| **URLs** | [AICM vuelos](https://www.aicm.com.mx/pasajeros/vuelos); [GAP info vuelo](https://www.aeropuertosgap.com.mx/es/?Itemid=746&option=com_infovuelo) (GDL: −2h…+24h only). |
| **Blocker** | Not a stable multi-day schedule API; HTML/JS may break; poor for dates far in the future; arrivalAt often absent → `connection_feasibility` may stay UNRESOLVED. |

### Recommended MVP architecture

```
FlightScheduleProvider
  searchSchedules({ origin, destination, date })
    -> FlightScheduleResult {
         provider, checkedAt,
         flights: [{
           origin, destination, departureAt, arrivalAt?,
           carrierCode, carrierName?, flightNumber?,
           stops, operatingCarrier?,
           sourceType: 'flight_schedule',
           sourceUrl?, providerFlightId?
         }]
       }

// Future (optional, not MVP):
FlightOfferProvider  // fares / booking — out of scope
```

Tool name for agent: prefer **`searchFlightSchedules`** (or keep `searchFlights` as alias that only returns schedules).  
Semantics in prompts/UI: always “horario publicado”, never invent seats/prices.

Integration sketch (later): AeroDataBox primary → if empty/error → Aviationstack if key+paid → else WebFlightScheduleProvider (AICM) for same-day only → else UNKNOWN.

### Next action

**Crear cuenta RapidAPI (o API.Market) AeroDataBox free/Basic y ejecutar spike read-only:**  
`MEX` departures window covering `2026-09-19` (or next available local day if date rejected), filter `GDL`, record presence of **AM / Y4 / VB** and fields returned — **no agent integration yet**.

---

## Historical note (superseded): fare / affiliate providers

Earlier evaluation selected Skyscanner (deeplink) / Duffel (offers) under an external-booking model. **That requirement is withdrawn.** Those providers remain optional future `FlightOfferProvider` candidates only. Duffel spike stays **PAUSED** (`docs/SPIKE-DUFFEL-FLIGHTS.md`).

<details><summary>Prior fare-model notes (archived)</summary>

- Duffel SA §2.3: zero Orders treated as one Order → ≤1500 searches before excess.
- Skyscanner Live Prices: create/poll + deeplinks; Partnerships gate; UX branding.
- Not needed for schedule-only MVP.

</details>

---

## A. Arquitectura actual relevante

### Tools hoy

Registration (`travel-agent/src/tools/travelTools.ts` → `registerTravelTools`):

| Tool | Rol | Evidencia |
| --- | --- | --- |
| `webSearch` | Tavily (opcional DDG fallback) | `toolTrace.sources[]` con url/title/snippet |
| `fetchUrl` | HTTP → texto truncado | misma forma de trace |

Dispatch: `ToolRegistry.execute` (`registry.ts`) parsea args JSON, llama handler, exige `contentForModel` + `ToolTraceEntry`.

Runtime (`runtime.ts`):

- `AGENT_MAX_TOOL_CALLS` (default **6**) / `AGENT_MAX_STEPS`.
- Prioridad crítica de vuelo: `shouldSkipToolCallForFlightPriority`, reserva de slots para `fetchUrl`, directed retry.
- Grounding: `assertDraftGrounded` + `scrubUngroundedConcreteFields` (`claims.ts`).
- Claims LLM: `sourceType: web | context` solamente. Web exige `sourceUrl` ∈ `toolTrace`.

### Contratos / provenance de entidades

`shared/agentContracts.ts` — `packageTravelOptionSchema`:

- Campos de vuelo útiles para UI: `origin`, `destination`, `startAt`, `endAt`, `provider`, `priceObserved`, `currency`, `sourceUrl`, `checkedAt`, `verificationStatus`, `sourceType`, `notes`.
- `sourceType` entidad: `cursor | manual | imported | agent | other` (no hay `flight_provider` aún).
- `sourceUrl` debe ser `http(s)` URL.
- `toolTraceEntrySchema`: `tool`, `args?`, `ok`, `sources[]`, `error?`, `checkedAt?`.

### Research goals

`researchCoverage.ts`:

- `flight_day_specific` (critical): RESOLVED solo con option `type=flight` + llegada/salida con reloj (`T\d{2}:\d{2}` en `startAt`/`endAt`) + `verificationStatus=verified` + `https` `sourceUrl`.
- `connection_feasibility`: requiere `flightOptionHasConcreteArrival` en algún vuelo; sin `arrivalAt`/`endAt` con reloj → no viable.
- Consultados vs anclados: URLs en `toolTrace` vs `entity.sourceUrl`.

### FlightCard (consumo, sin rediseño)

`src/ui/tripPanel/OptionCard.tsx` → `FlightCard` lee `TripPanelCard` construido en `buildTripPanel.ts` desde travel options:

| Campo package / card | UI |
| --- | --- |
| `startAt` / `endAt` | “Salida: when → until”; si faltan → “Horario: Pendiente de verificar” |
| `origin` / `destination` | Origen / Destino |
| `provider` | Aerolínea |
| `priceObserved` + `currency` | Precio |
| `sourceUrl` | Fuente (link) |
| `notes` | Notas |
| `verificationStatus` → card.status | badges verified / estimated / pending |
| `airportArrival` | derivado de `startAt` vía `airportArrivalPolicy` |

Un offer válido de `searchFlights` llega a FlightCard **solo** si el agente (o un hydrator server-side futuro) materializa un `travelOption` con esos campos. No hace falta cambiar el componente.

### Config / secrets

- Env: `loadLlmEnv` — LLM_*, `TAVILY_API_KEY`, `AGENT_MAX_TOOL_CALLS`, `ENABLE_WEB_TOOLS`.
- k8s: Secret `travel-agent-llm` (`LLM_API_KEY`, `TAVILY_API_KEY`); Deployment `07-travel-agent.yaml`.
- Patrón para flights: mismas claves en secret + flags en Deployment (`ENABLE_FLIGHT_SEARCH`, `FLIGHT_SEARCH_PROVIDER`, token provider).

### Dónde entra `searchFlights` (sin romper web)

```
registerTravelTools
  ├─ webSearch          (sin cambio)
  ├─ fetchUrl           (sin cambio)
  └─ searchFlights      (NUEVO, gated por ENABLE_FLIGHT_SEARCH + credenciales)

runtime tool loop
  ├─ prioridad crítica: preferir searchFlights antes que webSearch lodging
  ├─ toolTrace entry tool="searchFlights"
  └─ researchCoverage: anclar offers → flight_day_specific

claims / hydrate
  └─ nuevo path de evidencia flight_provider (ver §H)
```

Adapter interno (no expuesto al LLM):

```
searchFlights(args)
  → FlightSearchClient.search(normalizedQuery)
      → DuffelClient | (futuro AmadeusEnterpriseClient)
  → NormalizedFlightSearchResult
  → contentForModel (UNTRUSTED_CONTENT wrap) + ToolTraceEntry
```

---

## B. Comparación Amadeus vs Duffel

| Dimensión | Amadeus Self-Service Flight Offers Search | Duffel Offer Requests |
| --- | --- | --- |
| Endpoint histórico | `GET/POST …/v2/shopping/flight-offers` | `POST /air/offer_requests` |
| Fecha concreta OD | Sí (docs históricas: `originLocationCode`, `destinationLocationCode`, `departureDate`, `adults`) | Sí (`slices[].origin/destination/departure_date`, `passengers`) |
| nonStop / direct | `nonStop=true` | `max_connections=0` |
| Sandbox | Test host histórico `test.api.amadeus.com` (cached) | Test tokens `duffel_test_*`; Duffel Airways (ZZ) |
| Search sin booking | Sí (Search / Price / Create Orders son APIs separadas; booking solo con Create Orders + requisitos) | Sí (Offer Request / Offers sin crear Order) |
| Estado a 2026-09-19 | **Self-Service decommissioned 2026-07-17** (ver §D) | **Operativo** (`api.duffel.com` responde) |

### Diferencias schedule / availability / offer / bookable

| Concepto | Significado | Amadeus (histórico Self-Service) | Duffel |
| --- | --- | --- | --- |
| **Schedule** | Horario publicado (puede no ser vendible) | APIs de status/schedule distintas de Offers | No es el producto principal; el search devuelve **offers** |
| **Availability** | Asientos / clases a la venta | Flight Availabilities Search (separado) | Implícito en offer; refresh con GET offer |
| **Offer** | Precio + itinerario en un momento | `flight-offer` de Flight Offers Search | `offer` de Offer Request |
| **Bookable inventory** | Se puede emitir/ticketear ahora | Requiere Flight Offers Price + Create Orders (+ consolidator/IATA según país) | Requiere Create Order + pago; GET offer **no garantiza** booking |

Para Tool4Trip fase 1: tratamos respuestas como **provider-reported offers**, no como reserva garantizada.

---

## C. Cobertura comprobable para México

### Amadeus

| Aerolínea | ¿Comprobable en Self-Service hoy? | Evidencia |
| --- | --- | --- |
| Aeroméxico (AM) | Self-Service **no disponible**. En Enterprise/Travel Platform hay acuerdo de distribución (EDIFACT + NDC) anunciado por Amadeus — **no verificable vía Self-Service API**. | Press Amadeus–Aeroméxico; portal Self-Service cerrado |
| Volaris (Y4) | Self-Service FAQ histórica: *“We do not return data on … and Low cost carriers”* → LCC **no** en Self-Service Offers Search. Cobertura Enterprise no comprobada aquí. | [Amadeus FAQ (archived guides)](https://amadeus4dev.github.io/developer-guides/faq/) |
| Viva (VB) | Acuerdo NDC Amadeus–Viva (abril 2025) para **travel sellers** Amadeus — no implica Self-Service. | Press Amadeus–Viva |

**Conclusión Amadeus MX:** no hay forma honestamente comprobable hoy de buscar MEX→GDL vía Self-Service. Enterprise podría cubrir AM/Viva según contratos; **no está verificado** en esta investigación sin cuenta Enterprise.

### Duffel

| Aerolínea | ¿Comprobable? | Evidencia |
| --- | --- | --- |
| Aeroméxico | **Sí (marketing + página de aerolínea)** — search/book vía Duffel; contenido **Travelport** (no direct connect). | [duffel.com/flights/airlines/aeromexico](https://duffel.com/flights/airlines/aeromexico) |
| Volaris | **Sí** — página dedicada; search/book; se presenta como direct-connect benefits. | [duffel.com/flights/airlines/volaris](https://duffel.com/flights/airlines/volaris) |
| Viva Aerobus | **No confirmado.** URLs `/flights/airlines/viva` y `viva-aerobus` → **404**. En listado HTML de airlines aparece un token “VIVa” ambiguo; **no** tratar como cobertura garantizada hasta prueba con token live/test. | Comprobado 2026-09-19 |

**Domestic MEX→GDL:** Duffel acepta IATA airport codes en slices; no hay doc pública que excluya rutas domésticas MX. La cobertura real de inventario domestic debe validarse en **spike con sandbox/live** (commit de spike, ver §N) — no inventar resultados.

### Tercer proveedor considerado: Kiwi Tequila

- Históricamente: `/v2/search` con `fly_from`/`fly_to`/fechas.
- En 2026 el acceso self-serve parece **cerrado / partner-gated**; pricing no público.
- **No recomendado** como primario. Solo alternativa si Duffel falla comercialmente.

---

## D. Pricing / requisitos actuales (solo fuentes oficiales o decommission notice)

### Amadeus Self-Service (histórica — ya no onboarding)

Fuente: guías `amadeus4dev.github.io` + FAQ + decommission reports.

| Ítem | Hecho documentado |
| --- | --- |
| Free quota | Mensual en test y production; Flight Offers Search citado en análisis de terceros como **2 000 req/mes** (la página `developers.amadeus.com/pricing` es SPA y **no devolvió tarifas parseables** en fetch; **no inventamos el USD/call**) |
| Rate limits (docs test-data) | Test ~10 TPS; Production ~40 TPS (standard) |
| Billing over quota | Pay-as-you-go por API; tasas en Pricing page (inaccesible como self-service) |
| Booking | Create Orders exige consolidator / restricciones por país; **search no requiere** eso |
| **Decommission** | Amadeus confirmó cierre Self-Service **17 Jul 2026**; keys deshabilitadas; solo Enterprise permanece. Comprobado: `/self-service` → 301 a homepage; `test.api.amadeus.com` sin DNS usable en esta máquina |

**Requisito producción Amadeus hoy:** contrato **Enterprise** + portal Enterprise — fuera de alcance self-serve.

### Duffel (oficial [duffel.com/pricing](https://duffel.com/pricing), docs)

| Ítem | Valor publicado |
| --- | --- |
| Upfront | $0 |
| Por order confirmado | **$3.00** / order |
| Managed Content | **1%** del total del order (página pricing actual) |
| Ancillaries | **$2.00** / paid ancillary |
| Excess search | Si ratio search:order **> 1500:1**, **$0.005** por search excedente |
| IATA/ARC | **No requerido** con Managed Content (help center Duffel) |
| Rate limit | Headers: **60 requests / 60 s** (docs response-handling); `rate_limit_error` + `ratelimit-reset` |
| Test | Tokens `duffel_test_`; sandbox airlines + Duffel Airways |
| Search-only | Técnicamente posible (Offer Request sin Order). Con **0 orders**, el ratio implica que **todos** los searches cuentan hacia excess fee a $0.005 — barato a escala Tool4Trip, pero **relación comercial search-only** debe confirmarse con Duffel (no asumida) |

---

## E. Recomendación técnica (hechos)

1. **No implementar Amadeus Self-Service** — producto decommissioned; no hay onboarding ni sandbox confiable.
2. **Proveedor primario: Duffel** — API viva, docs claras, Aeroméxico + Volaris documentados, search sin booking, test mode, pricing transparente para search excess.
3. **Amadeus Enterprise** — solo como *future adapter* si hay contrato comercial y se demuestra cobertura domestic MX (incl. LCC).
4. **Kiwi Tequila** — no primario (acceso gated, sin pricing público verificable).
5. **Arquitectura adapter** desde el día 1 (`FlightSearchProvider` interface) para no acoplar el tool al vendor.
6. **Spike obligatorio** antes de prod: MEX→GDL fecha concreta en test (y si posible live read-only) midiendo AM / Y4 / VB presencia real.

Riesgos aceptados:

- Viva puede no aparecer → degradar a web / UNKNOWN (ya es el comportamiento correcto).
- Offers caducan → TTL (§I).
- Excess search fee / ToS search-only → seguimiento comercial, no bloquea diseño.

---

## F. Contrato `searchFlights` (alineado a arquitectura)

### Input (Zod conceptual)

```ts
searchFlightsInputSchema = z.object({
  origin: z.string().regex(/^[A-Z]{3}$/),       // IATA airport (preferido) o city
  destination: z.string().regex(/^[A-Z]{3}$/),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  adults: z.number().int().min(1).max(9).default(1),
  cabinClass: z.enum(['economy','premium_economy','business','first']).optional(),
  nonStop: z.boolean().optional(),             // → max_connections=0
  maxOffers: z.number().int().min(1).max(20).default(8),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(), // prefer MXN when supported
}).strict()
```

Notas de adaptación:

- No exponer `providerOfferId` ni tokens al LLM en args.
- One-way = omitir `returnDate`.
- Same-day: permitir `departureDate === today` en TZ viaje; el provider decide si hay inventory.
- Validación de aeropuerto desconocido → error tipado `unsupported_airport` (no inventar).

### Output normalizado (tool → model + trace)

```ts
{
  UNTRUSTED_CONTENT: true,
  trust: 'provider_reported',  // distinto de web scrape, aún no “reserva”
  tool: 'searchFlights',
  provider: 'duffel',          // | 'amadeus_enterprise' | …
  checkedAt: '2026-09-19T20:05:00+00:00',
  staleAt: '2026-09-19T20:35:00+00:00',  // checkedAt + TTL
  query: { origin, destination, departureDate, adults, nonStop },
  ok: true,
  offers: [
    {
      origin: 'MEX',
      destination: 'GDL',
      departureAt: '…',          // ISO con offset
      arrivalAt: '…',
      carrier: 'Y4',             // IATA marketing carrier
      carrierName: 'Volaris',    // optional display
      flightNumber: 'Y4xxx',
      durationMinutes: 75,
      stops: 0,
      price: { amount: 1234.56, currency: 'MXN' } | null,
      providerOfferId: 'off_…',  // ephemeral
      sourceType: 'flight_provider',
      freshness: 'fresh' | 'stale'
    }
  ],
  errors?: [{ code, message }]
}
```

### Clasificación de campos

| Campo | Clasificación |
| --- | --- |
| `provider`, `checkedAt`, `query` | server-owned / trace |
| `departureAt`, `arrivalAt`, `carrier`, `flightNumber`, `stops`, `durationMinutes` | **provider-reported** schedule |
| `price.amount/currency` | **provider-reported** / **optional** (puede faltar) |
| `providerOfferId` | **ephemeral** (caduca; no persistir como verdad eterna) |
| `staleAt` / `freshness` | server-derived TTL |
| `verificationStatus` en package | **server/agent policy** (§H) — no “bookable” |
| `sourceUrl` en package | ver §H (anclaje) |

---

## G. Normalización

Responsabilidad: `normalizeDuffelOffers(raw) → NormalizedOffer[]` (puro, testeable).

Mapeo Duffel → normalizado (campos documentados en Offers / Offer Requests):

| Normalizado | Fuente Duffel típica |
| --- | --- |
| origin/destination | primer/último segment del slice outbound; o slice origin/destination IATA |
| departureAt / arrivalAt | `segments[0].departing_at` / last `arriving_at` |
| carrier / flightNumber | marketing carrier `marketing_carrier.iata_code` + `marketing_carrier_flight_number` |
| stops | `segments.length - 1` |
| durationMinutes | parse `total_duration` ISO-8601 duration del slice/offer |
| price | `total_amount` + `total_currency` |
| providerOfferId | `offer.id` |

Reglas:

- Descartar offers malformados (sin `departing_at`) → no aparecen en `offers[]`; contar en `errors`/`warnings`.
- Price missing + schedule OK → offer válido con `price: null`.
- Multi-segment: `stops > 0`; para connection feasibility usar **arrivalAt del último segment**.
- Cap `maxOffers` tras sort (preferir nonStop si `nonStop=true`, luego earliest departure).

Amadeus Enterprise (futuro): mismo `NormalizedOffer`; mapper separado.

---

## H. Provenance

### Problema

Hoy `verified` + anclaje exigen `https` `sourceUrl` en toolTrace web. Un offer Duffel **no es una página web**, pero **tampoco** debe perder provenance al hidratarse a `travelOption`.

### Extensiones propuestas (mínimas)

1. **`toolTrace` para `searchFlights`**
   - `tool: 'searchFlights'`
   - `ok: true|false`
   - `checkedAt`
   - `sources[]`: una entrada por offer anclable:
     - `title`: `"Duffel offer {carrier}{flightNumber} {departureAt}"`
     - `url`: **ancla estable HTTPS** recomendada:  
       `https://api.duffel.com/air/offers/{providerOfferId}`  
       (el GET existe en docs; sirve como id dereferenciable aunque el cliente no lo abra en browser)
     - `snippet`: JSON compacto de campos provider-reported (schedule + price si hay)
   - `args`: query sin secretos

2. **Claims**
   - Extender LLM claim `sourceType` con `'flight_provider'` **o** reutilizar `web` con `sourceUrl` = ancla Duffel anterior (menor cambio de schema).
   - **Preferencia de diseño:** `sourceType: 'flight_provider'` en claims internos + grounding que resuelve evidencia desde `toolTrace` entry `searchFlights` por URL ancla / `providerOfferId`.
   - Entidad package: añadir opcionales `providerOfferId`, `flightSearchProvider` (`duffel`|…) y permitir `sourceType: 'other'` **o** extender enum entidad con `flight_provider` (breaking suave en shared schema).

3. **Qué significa VERIFIED**

| Nivel | Significado |
| --- | --- |
| **provider-reported** | Campos copiados del API en `checkedAt`; no implica asiento al comprar |
| **verified** (Tool4Trip) | Server aceptó claim/option porque: (a) `searchFlights` ok, (b) offer tiene `departureAt`+`arrivalAt`+`carrier`, (c) `checkedAt` dentro de TTL, (d) ancla en toolTrace. **No** significa “reserva garantizada” ni “precio final de checkout” |
| **estimated** | Schedule usable pero price missing, o TTL cerca de expirar, o partial mapper |
| **unverified / omit clocks** | Provider fail / zero offers / stale |

UI copy sugerida en `notes` (sin rediseñar card):  
`PROVIDER-REPORTED · consultado {checkedAt local} · no es reserva`.

4. **Consulted vs anchored**

- Cada offer en trace = **consultado**.
- Option con `sourceUrl` = ancla Duffel + campos schedule = **anclado**.
- `consultedSourceCount` / `anchoredSourceCount` siguen funcionando si usamos URLs https ancla.

---

## I. Freshness / TTL

| Política | Propuesta inicial |
| --- | --- |
| `checkedAt` | ISO al completar respuesta provider |
| TTL schedule | **30 minutos** (`staleAt = checkedAt + 30m`) para day-specific planning |
| TTL price | **15 minutos** (más agresivo); si solo price stale → mantener schedule como `estimated`, scrub `priceObserved` |
| Same-day / <6h to departure | TTL schedule **10 minutos** |
| Refresh | Nueva llamada `searchFlights` con misma query; no “reusar” offerId caduco como verified |
| Persistencia Dexie | Al Apply: guardar `checkedAt` + notes; si usuario reabre horas después, panel puede mostrar estimated/pending si UI más adelante lee stale — **fase 1:** warnings en proposal si `staleAt < now` al hidratar |
| OfferId | Nunca tratar como inventario eterno |

Server helpers: `isOfferFresh(checkedAt, now, kind)`, `scrubStaleFlightFields(option)`.

---

## J. Integración con researchCoverage

Estrategia para `flight_day_specific`:

```
¿ENABLE_FLIGHT_SEARCH && credenciales?
  sí → preferir searchFlights (1 call)
         │
         ├─ offers válidas (schedule) → anclar options → RESOLVED/PARTIAL
         │     (verified solo con policy §H + TTL fresh)
         └─ zero / error → UNRESOLVED + fallback webSearch/fetchUrl
  no → comportamiento actual (web only)
```

Detalles:

- `assessResearchGoals` / `optionAnchorsGoal`: aceptar anclas `searchFlights` (URL api.duffel.com/air/offers/… o marker en trace) además de web.
- `classifyCandidates`: no aplicar `insufficient_day_specific_evidence` a resultados estructurados del provider.
- `connection_feasibility`: usar `arrivalAt` → `endAt` del flight option; **si falta arrivalAt → no marcar viable** (ya alineado con `flightOptionHasConcreteArrival`).
- `airport_terminal` / bus: siguen siendo web/context; searchFlights no los resuelve.
- webSearch como **fallback y complemento** (no solo fallback):
  - Fallback: provider down / zero offers / unsupported route.
  - Complemento: terminal AICM, políticas de equipaje, links aerolínea para compra humana — **después** de tener horario provider o en paralelo solo si sobra budget.

Directed retry: si `flight_day_specific` UNRESOLVED y aún no se llamó `searchFlights`, el nudge debe decir **call searchFlights** antes que otro webSearch genérico.

---

## K. Tool budget

`AGENT_MAX_TOOL_CALLS=6` hoy se quema fácil en web.

Propuesta:

| Regla | Detalle |
| --- | --- |
| Costo | `searchFlights` cuenta **1** hacia el mismo budget (igual que webSearch) |
| Prioridad | Si goals critical incluyen `flight_day_specific` y tool enabled → **bloquear / defer** lodging webSearch hasta `searchFlights` intentado (extender `shouldSkipToolCallForFlightPriority`) |
| Soft reserve | Reservar **1** slot para `searchFlights` cuando el goal de vuelo esté UNRESOLVED (análogo a reserve fetchUrl) |
| Evitar desperdicio | Prompt: “For day-specific flights use searchFlights first; do not burn budget on generic OTA scrapes” |
| Cap interno | `maxOffers` bajo (8) para no hinchar el contexto del LLM |
| No subir a 6→N por defecto | Primero medir; opcional `AGENT_MAX_TOOL_CALLS=8` solo si metrics lo piden |

---

## L. Fallos / fallback

| Condición | Comportamiento tool | Research / package |
| --- | --- | --- |
| Timeout | `ok:false`, error `timeout` | UNRESOLVED; permitir web fallback |
| 401/403 | `ok:false`, `auth_error` | No inventar; warning config; web fallback |
| 429 rate limit | `ok:false`, `rate_limited` + reset hint | No retry storm en el mismo turn; web fallback |
| Zero offers | `ok:true`, `offers:[]` | UNRESOLVED flight; checklist; web opcional |
| Malformed body | `ok:false`, `malformed_response` | Igual que timeout |
| Unsupported airport | `ok:false`, `unsupported_airport` | UNKNOWN; no inventar códigos |
| Provider outage / 5xx | `ok:false`, `provider_outage` | Degradar a web / UNKNOWN |
| Partial offers | `ok:true`, solo offers válidos | PARTIAL/RESOLVED según anclas |

En todos los casos: **prohibido** inventar `flightNumber` / clocks / aerolínea.

---

## M. Tests (propuestos)

| # | Caso | Capa |
| --- | --- | --- |
| 1 | Provider varios vuelos válidos → N offers normalizados | `normalize` + tool handler (mock HTTP) |
| 2 | Cero vuelos → offers=[] ok | handler |
| 3 | Same-day search aceptado / pasado al provider | input + client args |
| 4 | `nonStop:true` → `max_connections=0` / filtro stops=0 | client + normalize |
| 5 | Vuelo con escala → stops≥1, arrivalAt = último segment | normalize |
| 6 | Timeout → ok:false timeout | client |
| 7 | 429 → rate_limited | client |
| 8 | Malformed JSON → malformed_response | client |
| 9 | Price missing + schedule OK → offer con price null | normalize |
| 10 | Offer stale → scrub price/verified; no RESOLVED | freshness + researchCoverage |
| 11 | Provenance: toolTrace sources + option sourceUrl ancla | claims/hydrate |
| 12 | `flight_day_specific` RESOLVED vía provider | researchCoverage |
| 13 | `connection_feasibility` usa arrivalAt | researchCoverage |
| 14 | Sin arrivalAt → connection no viable | researchCoverage |
| 15 | Provider fail → fallback web path aún posible; no inventa vuelo | runtime integration (mock registry) |

Fixtures: JSON Duffel offer_request response (sanitizado); sin credenciales reales en repo.

---

## N. Plan de implementación por commits pequeños

1. **Docs:** este archivo (schedule-only selection closed).
2. **Spike humano:** cuenta AeroDataBox (RapidAPI free/Basic) → MEX FIDS day window → filter GDL → log AM/Y4/VB fields.
3. Shared types: `FlightSchedule` + `sourceType: flight_schedule`.
4. `FlightScheduleProvider` + AeroDataBox adapter + normalize (no prices).
5. Tool `searchFlightSchedules` + env/secret; flag off.
6. researchCoverage / prompts: resolve `flight_day_specific` from schedules; UI note “horario publicado”.
7. WebFlightScheduleProvider (AICM) as same-day fallback.
8. Optional Aviationstack adapter if AeroDataBox coverage fails.
9. Staging validation vs prior UNRESOLVED flight jobs.

No deploy / no credentials in this design phase.

---

## Resumen ejecutivo

- **MVP = horarios publicados** (no precio, no booking, no deeplink).
- **Primary:** AeroDataBox FIDS.
- **Secondary:** Aviationstack `flightsFuture` (paid).
- **Web fallback:** AICM (same-day); GAP ±24h only.
- **Contract:** `FlightScheduleProvider.searchSchedules`.
- **Next:** spike AeroDataBox MEX→GDL for AM/Y4/VB.

---

## Fuentes consultadas (2026-09-19, schedule pivot)

- AeroDataBox: https://aerodatabox.com/api , https://aerodatabox.com/pricing/ , https://doc.aerodatabox.com/ , FIDS withLeg notes
- Aviationstack: https://aviationstack.com/documentation , https://aviationstack.com/pricing
- AICM: https://www.aicm.com.mx/pasajeros/vuelos
- GAP: https://www.aeropuertosgap.com.mx/es/?Itemid=746&option=com_infovuelo
- (Archived fare research: Duffel, Skyscanner — superseded for MVP)
