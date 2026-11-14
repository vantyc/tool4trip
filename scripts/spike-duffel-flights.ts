#!/usr/bin/env npx tsx
/**
 * Spike aislado: Duffel Offer Requests → inventario normalizado.
 *
 * NO conecta a travel-agent / researchCoverage / TripPanel / prod.
 *
 * Credencial:
 *   export DUFFEL_ACCESS_TOKEN='duffel_test_...'   # test mode (preferido)
 *   # o duffel_live_... solo si sabes lo que haces
 *
 * Ejemplo (caso SMA):
 *   npx tsx scripts/spike-duffel-flights.ts \
 *     --origin MEX --destination GDL --departure-date 2026-09-19 \
 *     --adults 1 --non-stop off
 *
 * Segundo caso si la fecha es rechazada (fecha futura):
 *   npx tsx scripts/spike-duffel-flights.ts \
 *     --origin MEX --destination GDL --departure-date 2026-10-03 \
 *     --adults 1 --non-stop off
 *
 * Flags:
 *   --non-stop off|preferred|required
 *     off       → sin max_connections (inventario completo; default)
 *     preferred → sin max_connections; summary marca directos vs con escala
 *     required  → max_connections=0 en el request a Duffel
 *   --max-offers N     (default 50 en summary; imprime todos normalizados hasta N)
 *   --write-fixture PATH  escribe JSON sanitizado (sin token/PII)
 *   --supplier-timeout-ms N  (default 20000)
 */

const DUFFEL_API = 'https://api.duffel.com'
const DUFFEL_VERSION = 'v2'

type NonStopMode = 'off' | 'preferred' | 'required'

type CliArgs = {
  origin: string
  destination: string
  departureDate: string
  adults: number
  nonStop: NonStopMode
  maxOffers: number
  writeFixture: string | null
  supplierTimeoutMs: number
}

type NormalizedOffer = {
  providerOfferId: string | null
  origin: string | null
  destination: string | null
  departureDateFromSegments: string | null
  departureAt: string | null
  arrivalAt: string | null
  carrierCode: string | null
  carrierName: string | null
  ownerCode: string | null
  ownerName: string | null
  flightNumber: string | null
  stops: number | null
  durationMinutes: number | null
  amount: string | null
  currency: string | null
  expiresAt: string | null
  /** Campos derivados por nosotros (no provider-raw). */
  _derived: {
    stopsFromSegmentCount: boolean
    durationFromIso8601: boolean
    flightNumberConcat: boolean
  }
}

function usageAndExit(code: number, msg?: string): never {
  if (msg) console.error(msg)
  console.error(`
Usage:
  DUFFEL_ACCESS_TOKEN=duffel_test_... npx tsx scripts/spike-duffel-flights.ts \\
    --origin MEX --destination GDL --departure-date YYYY-MM-DD \\
    [--adults 1] [--non-stop off|preferred|required] \\
    [--max-offers 50] [--write-fixture path.json] [--supplier-timeout-ms 20000]
`)
  process.exit(code)
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    origin: '',
    destination: '',
    departureDate: '',
    adults: 1,
    nonStop: 'off',
    maxOffers: 50,
    writeFixture: null,
    supplierTimeoutMs: 20_000,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => {
      const v = argv[++i]
      if (v == null) usageAndExit(1, `Missing value after ${a}`)
      return v
    }
    switch (a) {
      case '--origin':
        out.origin = next().toUpperCase()
        break
      case '--destination':
        out.destination = next().toUpperCase()
        break
      case '--departure-date':
        out.departureDate = next()
        break
      case '--adults':
        out.adults = Number(next())
        break
      case '--non-stop': {
        const v = next() as NonStopMode
        if (v !== 'off' && v !== 'preferred' && v !== 'required') {
          usageAndExit(1, `--non-stop must be off|preferred|required`)
        }
        out.nonStop = v
        break
      }
      case '--max-offers':
        out.maxOffers = Number(next())
        break
      case '--write-fixture':
        out.writeFixture = next()
        break
      case '--supplier-timeout-ms':
        out.supplierTimeoutMs = Number(next())
        break
      case '-h':
      case '--help':
        usageAndExit(0)
      default:
        usageAndExit(1, `Unknown arg: ${a}`)
    }
  }
  if (!/^[A-Z]{3}$/.test(out.origin)) usageAndExit(1, 'Invalid --origin')
  if (!/^[A-Z]{3}$/.test(out.destination))
    usageAndExit(1, 'Invalid --destination')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.departureDate)) {
    usageAndExit(1, 'Invalid --departure-date (YYYY-MM-DD)')
  }
  if (!Number.isFinite(out.adults) || out.adults < 1 || out.adults > 9) {
    usageAndExit(1, 'Invalid --adults')
  }
  return out
}

function detectProviderMode(token: string): 'test' | 'live' | 'unknown' {
  if (token.startsWith('duffel_test_')) return 'test'
  if (token.startsWith('duffel_live_')) return 'live'
  return 'unknown'
}

/** Parse ISO-8601 duration like PT2H26M / PT1H / PT45M → minutes. */
function parseDurationMinutes(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i)
  if (!m) return null
  const days = Number(m[1] ?? 0)
  const hours = Number(m[2] ?? 0)
  const mins = Number(m[3] ?? 0)
  const secs = Number(m[4] ?? 0)
  return days * 24 * 60 + hours * 60 + mins + Math.round(secs / 60)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return null
}

function iataOfPlace(place: unknown): string | null {
  const p = asRecord(place)
  if (!p) return null
  return typeof p.iata_code === 'string' ? p.iata_code : null
}

function datePrefix(isoLocal: string | null): string | null {
  if (!isoLocal) return null
  const m = isoLocal.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1]! : null
}

function normalizeOffer(raw: unknown): NormalizedOffer {
  const o = asRecord(raw) ?? {}
  const slices = Array.isArray(o.slices) ? o.slices : []
  const slice0 = asRecord(slices[0]) ?? {}
  const segments = Array.isArray(slice0.segments) ? slice0.segments : []
  const first = asRecord(segments[0]) ?? {}
  const last = asRecord(segments[segments.length - 1] ?? null) ?? {}

  const marketing = asRecord(first.marketing_carrier)
  const owner = asRecord(o.owner)

  const carrierCode =
    typeof marketing?.iata_code === 'string' ? marketing.iata_code : null
  const carrierName =
    typeof marketing?.name === 'string' ? marketing.name : null
  const flightNumRaw =
    typeof first.marketing_carrier_flight_number === 'string'
      ? first.marketing_carrier_flight_number
      : null
  const flightNumber =
    carrierCode && flightNumRaw
      ? `${carrierCode}${flightNumRaw}`
      : flightNumRaw

  const durationIso =
    typeof slice0.duration === 'string'
      ? slice0.duration
      : typeof o.total_duration === 'string'
        ? o.total_duration
        : null

  const departureAt =
    typeof first.departing_at === 'string' ? first.departing_at : null
  const arrivalAt =
    typeof last.arriving_at === 'string' ? last.arriving_at : null

  return {
    providerOfferId: typeof o.id === 'string' ? o.id : null,
    origin: iataOfPlace(first.origin) ?? iataOfPlace(slice0.origin),
    destination:
      iataOfPlace(last.destination) ?? iataOfPlace(slice0.destination),
    departureDateFromSegments: datePrefix(departureAt),
    departureAt,
    arrivalAt,
    carrierCode,
    carrierName,
    ownerCode: typeof owner?.iata_code === 'string' ? owner.iata_code : null,
    ownerName: typeof owner?.name === 'string' ? owner.name : null,
    flightNumber,
    stops: segments.length > 0 ? Math.max(0, segments.length - 1) : null,
    durationMinutes: parseDurationMinutes(durationIso),
    amount: typeof o.total_amount === 'string' ? o.total_amount : null,
    currency: typeof o.total_currency === 'string' ? o.total_currency : null,
    expiresAt: typeof o.expires_at === 'string' ? o.expires_at : null,
    _derived: {
      stopsFromSegmentCount: true,
      durationFromIso8601: durationIso != null,
      flightNumberConcat: Boolean(carrierCode && flightNumRaw),
    },
  }
}

function redactForFixture(body: unknown): unknown {
  // Keep structure; drop passenger PII if ever present; never keep auth.
  return JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (/authorization|access_token|password|secret|email|phone/i.test(key)) {
        return '[REDACTED]'
      }
      if (
        typeof value === 'string' &&
        (value.startsWith('duffel_test_') || value.startsWith('duffel_live_'))
      ) {
        return '[REDACTED_TOKEN]'
      }
      return value
    }),
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const token = (process.env.DUFFEL_ACCESS_TOKEN ?? '').trim()

  if (!token) {
    console.error(JSON.stringify({
      ok: false,
      error: 'DUFFEL_ACCESS_TOKEN missing',
      howToObtain: {
        steps: [
          'Create a free account at https://duffel.com (or sign in).',
          'Open Dashboard → Developers (ensure "Developer test mode" is ON).',
          'Create an Access Token. Test tokens start with duffel_test_.',
          'Docs: https://duffel.com/docs/api/overview/test-mode',
        ],
        localConfig: [
          'export DUFFEL_ACCESS_TOKEN=\'duffel_test_...\'',
          '# optional: put in a gitignored file and: set -a; source .env.duffel; set +a',
          '# never commit the token',
        ],
        runExample: [
          'npx tsx scripts/spike-duffel-flights.ts \\',
          '  --origin MEX --destination GDL --departure-date 2026-09-19 \\',
          '  --adults 1 --non-stop off',
        ],
      },
      note: 'Spike NOT executed. No simulated Duffel response.',
    }, null, 2))
    process.exit(2)
  }

  const providerMode = detectProviderMode(token)
  if (providerMode === 'unknown') {
    console.error(
      'Warning: token does not start with duffel_test_ or duffel_live_; proceeding anyway.',
    )
  }
  if (providerMode === 'live') {
    console.error(
      'Warning: using LIVE token. Spike will hit live inventory/billing. Prefer duffel_test_.',
    )
  }

  const passengers = Array.from({ length: args.adults }, () => ({
    type: 'adult' as const,
  }))

  const body: Record<string, unknown> = {
    data: {
      slices: [
        {
          origin: args.origin,
          destination: args.destination,
          departure_date: args.departureDate,
        },
      ],
      passengers,
      cabin_class: 'economy',
      ...(args.nonStop === 'required' ? { max_connections: 0 } : {}),
    },
  }

  const url = new URL(`${DUFFEL_API}/air/offer_requests`)
  url.searchParams.set('return_offers', 'true')
  url.searchParams.set(
    'supplier_timeout',
    String(Math.min(60_000, Math.max(2_000, args.supplierTimeoutMs))),
  )

  const checkedAt = new Date().toISOString()
  const t0 = performance.now()

  let httpStatus = 0
  let rawText = ''
  let fetchError: string | null = null

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept-Encoding': 'gzip',
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Duffel-Version': DUFFEL_VERSION,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    httpStatus = res.status
    rawText = await res.text()
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e)
  }

  const elapsedMs = Math.round(performance.now() - t0)

  let parsed: unknown = null
  try {
    parsed = rawText ? JSON.parse(rawText) : null
  } catch {
    parsed = null
  }

  const data = asRecord(asRecord(parsed)?.data)
  const liveModeField =
    typeof data?.live_mode === 'boolean' ? data.live_mode : null
  const offerRequestId = typeof data?.id === 'string' ? data.id : null
  const rawOffers = Array.isArray(data?.offers) ? data.offers : []
  const normalizedAll = rawOffers.map(normalizeOffer)
  const normalized = normalizedAll.slice(0, args.maxOffers)

  const carriers = new Map<string, number>()
  for (const o of normalizedAll) {
    const c = o.carrierCode ?? 'UNKNOWN'
    carriers.set(c, (carriers.get(c) ?? 0) + 1)
  }
  const owners = new Map<string, number>()
  for (const o of normalizedAll) {
    const c = o.ownerCode ?? 'UNKNOWN'
    owners.set(c, (owners.get(c) ?? 0) + 1)
  }

  const routeOk = normalizedAll.filter(
    (o) => o.origin === args.origin && o.destination === args.destination,
  )
  const dateOk = normalizedAll.filter(
    (o) => o.departureDateFromSegments === args.departureDate,
  )
  const directCount = normalizedAll.filter((o) => o.stops === 0).length
  const connectingCount = normalizedAll.filter(
    (o) => o.stops != null && o.stops > 0,
  ).length

  const duffelErrors = asRecord(parsed)?.errors
  const errorSummary = Array.isArray(duffelErrors)
    ? duffelErrors.map((e) => {
        const er = asRecord(e)
        return {
          type: er?.type ?? null,
          code: er?.code ?? null,
          title: er?.title ?? null,
          message: er?.message ?? null,
        }
      })
    : fetchError
      ? [{ type: 'fetch_error', code: null, title: null, message: fetchError }]
      : httpStatus >= 400
        ? [
            {
              type: 'http_error',
              code: String(httpStatus),
              title: null,
              message: rawText.slice(0, 500),
            },
          ]
        : []

  const dateRejected =
    errorSummary.some((e) => {
      const blob = `${e.code ?? ''} ${e.title ?? ''} ${e.message ?? ''}`.toLowerCase()
      return (
        blob.includes('departure') ||
        blob.includes('date') ||
        blob.includes('past') ||
        blob.includes('invalid')
      )
    }) && normalizedAll.length === 0

  const result = {
    provider: 'duffel' as const,
    providerMode,
    live_mode_from_response: liveModeField,
    api: {
      method: 'POST',
      path: '/air/offer_requests',
      duffelVersion: DUFFEL_VERSION,
      return_offers: true,
      max_connections_sent:
        args.nonStop === 'required' ? 0 : null,
      nonStopMode: args.nonStop,
    },
    checkedAt,
    httpStatus,
    elapsedMs,
    offerRequestId,
    query: {
      origin: args.origin,
      destination: args.destination,
      departureDate: args.departureDate,
      adults: args.adults,
      oneWay: true,
    },
    errors: errorSummary,
    dateRejectedLikely: dateRejected,
    validation: {
      totalOffers: normalizedAll.length,
      printedOffers: normalized.length,
      carriersFound: Object.fromEntries([...carriers.entries()].sort()),
      ownersFound: Object.fromEntries([...owners.entries()].sort()),
      AM_present: carriers.has('AM'),
      Y4_present: carriers.has('Y4'),
      VB_present: carriers.has('VB'),
      ZZ_duffel_airways_present: carriers.has('ZZ') || owners.has('ZZ'),
      offersMatchingOriginDest: routeOk.length,
      offersMatchingDepartureDate: dateOk.length,
      unequivocalRouteAndDate:
        normalizedAll.length > 0 &&
        routeOk.length === normalizedAll.length &&
        dateOk.length === normalizedAll.length,
      directCount,
      connectingCount,
      fieldProvenance: {
        providerReported: [
          'providerOfferId (offer.id)',
          'departureAt (segments[0].departing_at)',
          'arrivalAt (segments[last].arriving_at)',
          'carrierCode/Name (marketing_carrier)',
          'amount/currency (total_amount/total_currency)',
          'expiresAt (expires_at)',
          'ownerCode/Name (owner)',
          'origin/destination IATA from segment places',
        ],
        ourTransformation: [
          'stops = segments.length - 1',
          'durationMinutes = parse ISO-8601 slice.duration',
          'flightNumber = carrierCode + marketing_carrier_flight_number',
          'departureDateFromSegments = date prefix of departureAt',
        ],
      },
    },
    testModeNotes: {
      docs:
        'https://duffel.com/docs/api/overview/test-mode',
      expected: [
        'Test tokens (duffel_test_) talk to test mode only.',
        'Airline sandboxes are external; behaviour not strongly guaranteed.',
        'Duffel Airways (ZZ) appears in test with synthetic/non-realistic schedules/prices.',
        'Other carriers in test may be sandbox subsets — not guaranteed equal to live MX inventory.',
      ],
    },
    offers: normalized,
    sampleOffersForInspection: normalized.slice(0, 5).map((o) => ({
      providerOfferId: o.providerOfferId,
      origin: o.origin,
      destination: o.destination,
      departureAt: o.departureAt,
      arrivalAt: o.arrivalAt,
      carrierCode: o.carrierCode,
      carrierName: o.carrierName,
      flightNumber: o.flightNumber,
      stops: o.stops,
      durationMinutes: o.durationMinutes,
      amount: o.amount,
      currency: o.currency,
      expiresAt: o.expiresAt,
      ownerCode: o.ownerCode,
    })),
    nextIfDateRejected: dateRejected
      ? {
          doNotSilentlyChangeCase: true,
          suggestedSecondRun: [
            'Document the rejection above.',
            'Re-run with a near-future valid date, e.g.:',
            `npx tsx scripts/spike-duffel-flights.ts --origin ${args.origin} --destination ${args.destination} --departure-date YYYY-MM-DD --adults ${args.adults} --non-stop off`,
          ],
        }
      : null,
  }

  console.log(JSON.stringify(result, null, 2))

  if (args.writeFixture && httpStatus === 200 && data) {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const fixture = {
      note: 'Sanitized Duffel offer_request response for spike/tests. No tokens.',
      capturedAt: checkedAt,
      providerMode,
      query: result.query,
      // Cap offers in fixture to keep repo small
      data: redactForFixture({
        ...data,
        offers: Array.isArray(data.offers)
          ? data.offers.slice(0, Math.min(10, args.maxOffers))
          : [],
      }),
    }
    mkdirSync(dirname(args.writeFixture), { recursive: true })
    writeFileSync(args.writeFixture, JSON.stringify(fixture, null, 2) + '\n')
    console.error(`Wrote sanitized fixture: ${args.writeFixture}`)
  }

  if (fetchError || httpStatus === 0) process.exit(1)
  if (httpStatus >= 400) process.exit(1)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
