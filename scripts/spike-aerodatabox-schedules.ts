#!/usr/bin/env npx tsx
/**
 * Spike aislado: AeroDataBox FIDS → horarios MEX→GDL (schedule only).
 *
 * NO conecta a travel-agent / researchCoverage / TripPanel / prod.
 *
 * Credenciales (una de):
 *   export AERODATABOX_RAPIDAPI_KEY='...'   # RapidAPI (preferido)
 *   export AERODATABOX_API_KEY='...'        # acceso directo (si aplica)
 *
 * Ejemplo:
 *   npx tsx scripts/spike-aerodatabox-schedules.ts \
 *     --origin MEX --destination GDL --date 2026-09-19
 *
 * Flags:
 *   --date YYYY-MM-DD          (caso principal; no se cambia en silencio)
 *   --fallback-date YYYY-MM-DD (opcional: segunda corrida SOLO si --date falla)
 *   --write-fixture PATH       fixture sanitizada (sin secretos)
 *
 * FIDS page size (planes Basic/Pro): max 12h por call → dos ventanas por día.
 */

const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com'
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`

type Cli = {
  origin: string
  destination: string
  date: string
  fallbackDate: string | null
  writeFixture: string | null
}

type NormalizedFlight = {
  origin: string | null
  destination: string | null
  departureAt: string | null
  arrivalAt: string | null
  carrierCode: string | null
  carrierName: string | null
  flightNumber: string | null
  status: string | null
  operatingCarrierCode: string | null
  operatingCarrierName: string | null
  stops: number | null
  /** Campos crudos seleccionados (provider-reported). */
  raw: {
    number?: unknown
    callSign?: unknown
    status?: unknown
    airline?: unknown
    departure?: unknown
    arrival?: unknown
    codeshareStatus?: unknown
  }
  _derived: {
    flightNumberNormalized: boolean
    filteredByDestination: boolean
    stopsAssumedNonstopFromSingleLeg: boolean
  }
}

function usage(code: number, msg?: string): never {
  if (msg) console.error(msg)
  console.error(`
Usage:
  AERODATABOX_RAPIDAPI_KEY=... npx tsx scripts/spike-aerodatabox-schedules.ts \\
    --origin MEX --destination GDL --date 2026-09-19 \\
    [--fallback-date 2026-09-20] [--write-fixture path.json]
`)
  process.exit(code)
}

function parseArgs(argv: string[]): Cli {
  const out: Cli = {
    origin: '',
    destination: '',
    date: '',
    fallbackDate: null,
    writeFixture: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => {
      const v = argv[++i]
      if (!v) usage(1, `Missing value after ${a}`)
      return v
    }
    switch (a) {
      case '--origin':
        out.origin = next().toUpperCase()
        break
      case '--destination':
        out.destination = next().toUpperCase()
        break
      case '--date':
        out.date = next()
        break
      case '--fallback-date':
        out.fallbackDate = next()
        break
      case '--write-fixture':
        out.writeFixture = next()
        break
      case '-h':
      case '--help':
        usage(0)
      default:
        usage(1, `Unknown arg: ${a}`)
    }
  }
  if (!/^[A-Z]{3}$/.test(out.origin)) usage(1, 'Invalid --origin')
  if (!/^[A-Z]{3}$/.test(out.destination)) usage(1, 'Invalid --destination')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) usage(1, 'Invalid --date')
  if (out.fallbackDate && !/^\d{4}-\d{2}-\d{2}$/.test(out.fallbackDate)) {
    usage(1, 'Invalid --fallback-date')
  }
  return out
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function iataOfAirport(movement: unknown): string | null {
  const m = asRec(movement)
  const ap = asRec(m?.airport)
  return str(ap?.iata) ?? str(ap?.iataCode)
}

function scheduledAt(movement: unknown): string | null {
  const m = asRec(movement)
  if (!m) return null
  // Flat string fields (common)
  const flat =
    str(m.scheduledTimeLocal) ??
    str(m.revisedTimeLocal) ??
    str(m.predictedTimeLocal) ??
    str(m.scheduledTimeUtc) ??
    str(m.revisedTimeUtc) ??
    str(m.actualTimeLocal) ??
    str(m.actualTimeUtc)
  if (flat) return flat
  // Nested { utc, local } objects used by some AeroDataBox payloads
  for (const key of [
    'scheduledTime',
    'revisedTime',
    'predictedTime',
    'actualTime',
    'scheduledTimeLocal',
    'scheduledTimeUtc',
  ]) {
    const nested = asRec(m[key])
    if (nested) {
      const v = str(nested.local) ?? str(nested.utc) ?? str(nested.Local) ?? str(nested.Utc)
      if (v) return v
    }
  }
  return null
}

function airlineIata(airline: unknown): string | null {
  const a = asRec(airline)
  return str(a?.iata) ?? str(a?.iataCode)
}

function airlineName(airline: unknown): string | null {
  const a = asRec(airline)
  return str(a?.name)
}

/** "AM 208" / "AM208" / "Y4 152" → display form preserving digits. */
function normalizeFlightNumber(
  number: string | null,
  carrierCode: string | null,
): string | null {
  if (!number) return null
  const compact = number.replace(/\s+/g, '')
  if (carrierCode && !compact.toUpperCase().startsWith(carrierCode.toUpperCase())) {
    return `${carrierCode}${compact}`
  }
  return compact.toUpperCase()
}

function dayWindows(date: string): Array<{ from: string; to: string }> {
  // Basic/Pro FIDS max 12h — split local calendar day into two windows.
  return [
    { from: `${date}T00:00`, to: `${date}T12:00` },
    { from: `${date}T12:00`, to: `${date}T23:59` },
  ]
}

type AuthMode =
  | { mode: 'rapidapi'; key: string }
  | { mode: 'direct'; key: string; base: string }

function loadAuth(): AuthMode | null {
  const rapid = (process.env.AERODATABOX_RAPIDAPI_KEY ?? '').trim()
  if (rapid) return { mode: 'rapidapi', key: rapid }
  const direct = (process.env.AERODATABOX_API_KEY ?? '').trim()
  if (direct) {
    const base = (
      process.env.AERODATABOX_BASE_URL ?? 'https://api.aerodatabox.com'
    )
      .trim()
      .replace(/\/$/, '')
    return { mode: 'direct', key: direct, base }
  }
  return null
}

async function fetchFidsWindow(
  auth: AuthMode,
  origin: string,
  fromLocal: string,
  toLocal: string,
): Promise<{
  httpStatus: number
  elapsedMs: number
  bodyText: string
  json: unknown
  url: string
}> {
  const path = `/flights/airports/iata/${encodeURIComponent(origin)}/${encodeURIComponent(fromLocal)}/${encodeURIComponent(toLocal)}`
  const qs = new URLSearchParams({
    withLeg: 'true',
    direction: 'Departure',
    withCancelled: 'true',
    withCodeshared: 'true',
    withCargo: 'false',
    withPrivate: 'false',
  })
  const url =
    auth.mode === 'rapidapi'
      ? `${RAPIDAPI_BASE}${path}?${qs}`
      : `${auth.base}${path}?${qs}`

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (auth.mode === 'rapidapi') {
    headers['x-rapidapi-key'] = auth.key
    headers['x-rapidapi-host'] = RAPIDAPI_HOST
  } else {
    headers['X-API-KEY'] = auth.key
    // some gateways use Authorization Bearer — try API key header first
  }

  const t0 = performance.now()
  const res = await fetch(url, { method: 'GET', headers })
  const elapsedMs = Math.round(performance.now() - t0)
  const bodyText = await res.text()
  let json: unknown = null
  try {
    json = bodyText ? JSON.parse(bodyText) : null
  } catch {
    json = null
  }
  return { httpStatus: res.status, elapsedMs, bodyText, json, url: url.replace(auth.key, '[REDACTED]') }
}

function extractDepartureRows(json: unknown): unknown[] {
  const root = asRec(json)
  if (!root) return []
  if (Array.isArray(root.departures)) return root.departures
  // some shapes nest under data
  const data = asRec(root.data)
  if (data && Array.isArray(data.departures)) return data.departures
  if (Array.isArray(json)) return json
  return []
}

function normalizeRow(row: unknown, destFilter: string): NormalizedFlight | null {
  const r = asRec(row) ?? {}
  const departure = r.departure ?? r.Departure
  const arrival = r.arrival ?? r.Arrival
  const airline = r.airline ?? r.Airline
  const number = str(r.number) ?? str(r.Number)
  const status = str(r.status) ?? str(r.Status)
  const origin = iataOfAirport(departure)
  const destination = iataOfAirport(arrival)
  if (destination !== destFilter) return null

  const carrierCode = airlineIata(airline)
  const carrierName = airlineName(airline)
  // codeshare / operating — best-effort from common fields
  const codeshare = str(r.codeshareStatus)
  let operatingCarrierCode: string | null = null
  let operatingCarrierName: string | null = null
  const op = asRec(r.operatingAirline) ?? asRec(r.operating)
  if (op) {
    operatingCarrierCode = airlineIata(op)
    operatingCarrierName = airlineName(op)
  }

  return {
    origin,
    destination,
    departureAt: scheduledAt(departure),
    arrivalAt: scheduledAt(arrival),
    carrierCode,
    carrierName,
    flightNumber: normalizeFlightNumber(number, carrierCode),
    status,
    operatingCarrierCode,
    operatingCarrierName,
    stops: 0,
    raw: {
      number,
      callSign: r.callSign,
      status,
      airline,
      departure,
      arrival,
      codeshareStatus: codeshare,
    },
    _derived: {
      flightNumberNormalized: true,
      filteredByDestination: true,
      stopsAssumedNonstopFromSingleLeg: true,
    },
  }
}

type RunReport = {
  date: string
  queryWindows: Array<{ from: string; to: string }>
  httpStatuses: number[]
  elapsedMsTotal: number
  windowErrors: Array<{ window: string; httpStatus: number; message: string }>
  dateRejectedLikely: boolean
  totalDepartureRows: number
  mexGdl: NormalizedFlight[]
  amPresent: boolean
  y4Present: boolean
  vbPresent: boolean
}

async function runForDate(
  auth: AuthMode,
  origin: string,
  destination: string,
  date: string,
): Promise<RunReport> {
  const windows = dayWindows(date)
  const httpStatuses: number[] = []
  const windowErrors: RunReport['windowErrors'] = []
  let elapsedMsTotal = 0
  const allRows: unknown[] = []
  const rawBodies: unknown[] = []

  for (const w of windows) {
    const res = await fetchFidsWindow(auth, origin, w.from, w.to)
    httpStatuses.push(res.httpStatus)
    elapsedMsTotal += res.elapsedMs
    rawBodies.push({ window: w, httpStatus: res.httpStatus, json: res.json })

    if (res.httpStatus >= 400 || res.json == null) {
      const msg =
        str(asRec(res.json)?.message) ??
        str(asRec(asRec(res.json)?.error)?.message) ??
        res.bodyText.slice(0, 400)
      windowErrors.push({
        window: `${w.from}→${w.to}`,
        httpStatus: res.httpStatus,
        message: msg,
      })
      continue
    }
    allRows.push(...extractDepartureRows(res.json))
  }

  const mexGdl = allRows
    .map((row) => normalizeRow(row, destination))
    .filter((x): x is NormalizedFlight => x != null)

  // Also keep origin match when withLeg provides it
  const filtered = mexGdl.filter(
    (f) => !f.origin || f.origin === origin || f.origin === null,
  )

  const carriers = new Set(
    filtered.map((f) => (f.carrierCode ?? '').toUpperCase()).filter(Boolean),
  )

  const errBlob = windowErrors.map((e) => e.message).join(' ').toLowerCase()
  const dateRejectedLikely =
    filtered.length === 0 &&
    (windowErrors.some((e) => e.httpStatus >= 400) ||
      /date|range|future|historical|quota|plan|limit|not available|invalid/.test(
        errBlob,
      ))

  // stash fixtures on global for optional write
  ;(runForDate as unknown as { _lastRaw?: unknown })._lastRaw = rawBodies

  return {
    date,
    queryWindows: windows,
    httpStatuses,
    elapsedMsTotal,
    windowErrors,
    dateRejectedLikely,
    totalDepartureRows: allRows.length,
    mexGdl: filtered,
    amPresent: carriers.has('AM'),
    y4Present: carriers.has('Y4'),
    vbPresent: carriers.has('VB'),
  }
}

function printReport(
  providerMode: string,
  query: { origin: string; destination: string },
  report: RunReport,
  label: string,
): void {
  const flights = report.mexGdl.map((f) => ({
    carrierCode: f.carrierCode,
    carrierName: f.carrierName,
    flightNumber: f.flightNumber,
    departureAt: f.departureAt,
    arrivalAt: f.arrivalAt,
    origin: f.origin,
    destination: f.destination,
    status: f.status,
    operatingCarrierCode: f.operatingCarrierCode,
    operatingCarrierName: f.operatingCarrierName,
    stops: f.stops,
    source: 'aerodatabox',
    provider: 'aerodatabox',
    fieldProvenance: {
      providerReported: [
        'raw.number',
        'raw.airline.iata/name',
        'raw.departure.scheduledTimeLocal (+ airport)',
        'raw.arrival.scheduledTimeLocal (+ airport) when withLeg=true',
        'raw.status',
      ],
      ourTransformation: [
        'filter destination IATA === query.destination',
        'flightNumber = strip spaces / ensure carrier prefix',
        'stops = 0 assumed for single FIDS leg row',
      ],
    },
  }))

  console.log(
    JSON.stringify(
      {
        label,
        provider: 'aerodatabox',
        providerMode,
        checkedAt: new Date().toISOString(),
        query: { ...query, date: report.date },
        httpStatuses: report.httpStatuses,
        elapsedMsTotal: report.elapsedMsTotal,
        queryWindows: report.queryWindows,
        windowErrors: report.windowErrors,
        dateRejectedLikely: report.dateRejectedLikely,
        totalDepartureRowsFromOrigin: report.totalDepartureRows,
        totalMexGdl: report.mexGdl.length,
        amPresent: report.amPresent,
        y4Present: report.y4Present,
        vbPresent: report.vbPresent,
        flights,
        semantics:
          'Published schedule only — NOT seat availability, fare, or booking guarantee.',
      },
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const auth = loadAuth()
  if (!auth) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: 'AERODATABOX_RAPIDAPI_KEY or AERODATABOX_API_KEY missing',
          howTo:
            'Subscribe at RapidAPI AeroDataBox (or aerodatabox.com), then: export AERODATABOX_RAPIDAPI_KEY=... (gitignored .env.aerodatabox OK)',
          note: 'Spike NOT executed. No simulated response.',
        },
        null,
        2,
      ),
    )
    process.exit(2)
  }

  const primary = await runForDate(
    auth,
    args.origin,
    args.destination,
    args.date,
  )
  printReport(auth.mode, args, primary, 'PRIMARY_DATE')

  const primaryFailed =
    primary.mexGdl.length === 0 &&
    (primary.dateRejectedLikely ||
      primary.httpStatuses.every((s) => s >= 400) ||
      primary.windowErrors.length > 0)

  if (primaryFailed) {
    const fb =
      args.fallbackDate ??
      // suggest next calendar day only as SEPARATE run if user passed nothing —
      // do NOT auto-run without explicit --fallback-date to avoid silent change.
      null
    if (!fb) {
      console.error(
        JSON.stringify(
          {
            note: 'Primary date produced no MEX→GDL rows and/or API errors. Date was NOT changed silently.',
            hint: 'Re-run with --fallback-date YYYY-MM-DD for the nearest valid date after documenting the primary failure.',
          },
          null,
          2,
        ),
      )
    } else {
      console.error(
        JSON.stringify(
          {
            note: 'Primary date failed/limited. Running EXPLICIT fallback date (not a silent substitution).',
            primaryDate: args.date,
            fallbackDate: fb,
          },
          null,
          2,
        ),
      )
      const secondary = await runForDate(
        auth,
        args.origin,
        args.destination,
        fb,
      )
      printReport(auth.mode, args, secondary, 'FALLBACK_DATE')
    }
  }

  if (args.writeFixture) {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const raw = (runForDate as unknown as { _lastRaw?: unknown })._lastRaw
    const fixture = {
      note: 'Sanitized AeroDataBox FIDS spike fixture — no API keys.',
      query: args,
      capturedAt: new Date().toISOString(),
      rawWindows: raw,
    }
    mkdirSync(dirname(args.writeFixture), { recursive: true })
    writeFileSync(
      args.writeFixture,
      JSON.stringify(fixture, (_, v) => {
        if (typeof v === 'string' && /rapidapi|api[_-]?key/i.test(v) && v.length > 20)
          return '[REDACTED]'
        return v
      }, 2) + '\n',
    )
    console.error(`Wrote fixture: ${args.writeFixture}`)
  }

  // exit non-zero if primary had hard HTTP failures and no flights
  if (primary.mexGdl.length === 0 && primary.httpStatuses.every((s) => s >= 400)) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
