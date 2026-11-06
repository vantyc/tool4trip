import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import {
  isLodgingCandidateNote,
  LODGING_CANDIDATE_NOTE,
} from '../../shared/lodgingCandidate.ts'
import {
  extractIataCode,
  formatClockEs,
} from './airportArrivalPolicy.ts'
import {
  isProtectedTravelOption,
  PackageMutationConflictError,
  PackageMutationValidationError,
  validateMutationOps,
} from './packageMutation.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
import {
  containsDisallowedControl,
  stripDisallowedControls,
} from './postgresSanitize.ts'
import {
  checklistEntityId,
  itineraryEntityId,
  noteEntityId,
  optionEntityId,
  type PackageTravelOption,
  type TripPackageV1,
} from './tripPackage.ts'

/**
 * Deterministic logical roles for mutation matching.
 * Prefer package.logicalRole when present; otherwise infer from structured fields.
 */
export type LogicalRole =
  | 'flight_outbound'
  | 'flight_return'
  | 'lodging_primary'
  | 'lodging_fallback'
  /** Researched lodging added next to the current one; never competes as primary. */
  | 'lodging_candidate'
  | 'ground_transfer'
  | 'other'

/** Window classification relative to the *proposed* (target) trip dates. */
export type WindowClass = 'IN_WINDOW' | 'OUT_OF_WINDOW' | 'UNKNOWN_DATE'

export type CompiledMutationPlan = {
  status: 'ok' | 'review_required'
  /** Canonical ops for Apply (validated, deduped, ordered) */
  ops: AgentOpRecord[]
  /** Package normalized for upsert (deduped winners per role + field preservation) */
  package: TripPackageV1
  warnings: string[]
  conflicts: string[]
  /** Debug / tests: role matching decisions */
  matching: Array<{
    role: LogicalRole
    action: string
    from?: string
    to?: string
    reason: string
  }>
}

type OptView = {
  externalId: string
  type: string
  status: string
  title: string
  origin?: string
  destination?: string
  address?: string
  notes?: string
  startAt?: string
  endAt?: string
  sourceType?: string
  sourceUrl?: string
  provider?: string
  description?: string
  phone?: string
  checkedAt?: string
  verificationStatus?: string
  bookingId?: string | null
  logicalRole?: LogicalRole | string
  entityId?: string
  packageId?: string
  raw: PackageTravelOption | TravelOption
}

function datePrefix(iso?: string): string {
  if (!iso) return ''
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/)
  return m?.[1] ?? ''
}

function normText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

function mentionsCity(blob: string, kind: 'sma' | 'gdl'): boolean {
  const n = normText(blob)
  if (kind === 'gdl') {
    return /\bguadalajara\b|\bgdl\b/.test(n)
  }
  return (
    /\bsan miguel\b/.test(n) ||
    /\bsma\b/.test(n) ||
    /\bel alto\b/.test(n)
  )
}

function toView(
  o: PackageTravelOption | TravelOption,
  externalId: string,
): OptView {
  const r = o as PackageTravelOption &
    TravelOption & { logicalRole?: string; id?: string }
  return {
    externalId,
    type: String(r.type ?? ''),
    status: String(r.status ?? ''),
    title: String(r.title ?? ''),
    origin: r.origin,
    destination: r.destination,
    address: r.address,
    notes: r.notes,
    startAt: r.startAt,
    endAt: r.endAt,
    sourceType: r.sourceType,
    sourceUrl: r.sourceUrl,
    provider: r.provider,
    description: r.description,
    phone: r.phone,
    checkedAt: r.checkedAt,
    verificationStatus: r.verificationStatus,
    bookingId: 'bookingId' in r ? r.bookingId : undefined,
    logicalRole: r.logicalRole,
    entityId: 'id' in r && typeof r.id === 'string' ? r.id : undefined,
    packageId: 'packageId' in r ? r.packageId : undefined,
    raw: o,
  }
}

/**
 * Infer logical role from structured fields (not LLM titles alone).
 */
export function inferLogicalRole(
  o: OptView,
  trip: { startDate: string; endDate: string; destination?: string },
): LogicalRole {
  const explicit = o.logicalRole
  if (
    explicit === 'flight_outbound' ||
    explicit === 'flight_return' ||
    explicit === 'lodging_primary' ||
    explicit === 'lodging_fallback' ||
    explicit === 'ground_transfer'
  ) {
    return explicit
  }

  if (o.type === 'transfer' || o.type === 'bus' || o.type === 'car_rental') {
    return 'ground_transfer'
  }

  if (o.type === 'lodging') {
    const blob = `${o.title} ${o.address ?? ''} ${o.destination ?? ''} ${o.notes ?? ''}`
    if (mentionsCity(blob, 'gdl') && !mentionsCity(blob, 'sma')) {
      return 'lodging_fallback'
    }
    if (mentionsCity(blob, 'sma')) return 'lodging_primary'
    const dest = trip.destination ?? ''
    if (mentionsCity(dest, 'sma') || /san miguel/i.test(dest)) {
      return 'lodging_primary'
    }
    return 'lodging_primary'
  }

  if (o.type === 'flight') {
    const ori = extractIataCode(o.origin) ?? ''
    const dest = extractIataCode(o.destination) ?? ''
    const day = datePrefix(o.startAt)
    if (ori === 'MEX' && (dest === 'GDL' || dest === 'BJX')) return 'flight_outbound'
    if ((ori === 'GDL' || ori === 'BJX') && dest === 'MEX') return 'flight_return'
    if (day && day === trip.startDate) return 'flight_outbound'
    if (day && day === trip.endDate) return 'flight_return'
    if (day && trip.startDate && trip.endDate) {
      if (day <= trip.startDate) return 'flight_outbound'
      if (day >= trip.endDate) return 'flight_return'
      if (ori && dest && ori !== 'MEX') return 'flight_return'
    }
    return 'other'
  }

  return 'other'
}

function flightRouteKey(o: OptView): string | undefined {
  if (o.type !== 'flight') return undefined
  const ori = extractIataCode(o.origin)
  const dest = extractIataCode(o.destination)
  return ori && dest ? `${ori}>${dest}` : undefined
}

/** Route → leg of the trip's current flights (only routes with a single leg). */
function routeLegs(
  curRoles: Map<LogicalRole, OptView[]>,
): Map<string, LogicalRole> {
  const map = new Map<string, LogicalRole>()
  for (const role of ['flight_outbound', 'flight_return'] as const) {
    for (const v of curRoles.get(role) ?? []) {
      const key = flightRouteKey(v)
      if (!key) continue
      const prev = map.get(key)
      map.set(key, prev && prev !== role ? 'other' : role)
    }
  }
  return map
}

/**
 * A proposed flight on a route the trip already flies keeps that leg, so a
 * date inside the shifted window cannot flip its direction.
 */
function inferProposedRole(
  o: OptView,
  trip: { startDate: string; endDate: string; destination?: string },
  legs?: Map<string, LogicalRole>,
): LogicalRole {
  const inferred = inferLogicalRole(o, trip)
  if (o.logicalRole === inferred) return inferred
  const key = flightRouteKey(o)
  const known = key ? legs?.get(key) : undefined
  return known && known !== 'other' ? known : inferred
}

function groupByRole(
  opts: OptView[],
  trip: { startDate: string; endDate: string; destination?: string },
  legs?: Map<string, LogicalRole>,
): Map<LogicalRole, OptView[]> {
  const map = new Map<LogicalRole, OptView[]>()
  for (const o of opts) {
    const role = inferProposedRole(o, trip, legs)
    const arr = map.get(role) ?? []
    arr.push(o)
    map.set(role, arr)
  }
  return map
}

function isResearchStatus(status: string): boolean {
  return status === 'researched' || status === 'shortlisted'
}

/** Current options eligible for role matching (exclude rejected). */
function matchableCurrent(opts: OptView[]): OptView[] {
  return opts.filter((o) => o.status !== 'rejected')
}

/**
 * Classify an option relative to the target trip window.
 * Flights: startAt day. Lodging: overlap of [startAt,endAt] with window.
 */
export function classifyWindow(
  o: Pick<OptView, 'type' | 'startAt' | 'endAt'>,
  window: { startDate: string; endDate: string },
): WindowClass {
  const start = datePrefix(o.startAt)
  const end = datePrefix(o.endAt)

  if (o.type === 'lodging') {
    if (!start && !end) return 'UNKNOWN_DATE'
    const s = start || end
    const e = end || start
    if (!s || !e) return 'UNKNOWN_DATE'
    // overlap with [window.start, window.end]
    if (e < window.startDate || s > window.endDate) return 'OUT_OF_WINDOW'
    return 'IN_WINDOW'
  }

  if (!start) return 'UNKNOWN_DATE'
  if (start >= window.startDate && start <= window.endDate) return 'IN_WINDOW'
  return 'OUT_OF_WINDOW'
}

export type WindowPick =
  | { status: 'ok'; primary: OptView; obsolete: OptView[] }
  | { status: 'ambiguous'; candidates: OptView[]; reason: string }
  | { status: 'empty' }

/**
 * Prefer exactly one IN_WINDOW candidate as the current vigente.
 * OUT_OF_WINDOW never ties with IN_WINDOW. UNKNOWN never beats IN_WINDOW.
 */
export function pickWindowAwarePrimary(
  opts: OptView[],
  window: { startDate: string; endDate: string },
  role: LogicalRole,
  optsExtra?: {
    /**
     * When the trip dates are shifting, all current entities may be OUT_OF_WINDOW
     * relative to the *new* window. Allow picking a primary among them for supersede.
     */
    allowOutOfWindowPrimary?: boolean
  },
): WindowPick {
  if (!opts.length) return { status: 'empty' }

  const classified = opts.map((o) => ({
    o,
    w: classifyWindow(o, window),
  }))
  const inW = classified.filter((c) => c.w === 'IN_WINDOW').map((c) => c.o)
  const outW = classified.filter((c) => c.w === 'OUT_OF_WINDOW').map((c) => c.o)
  const unk = classified.filter((c) => c.w === 'UNKNOWN_DATE').map((c) => c.o)

  if (inW.length === 1) {
    return {
      status: 'ok',
      primary: inW[0]!,
      obsolete: [...outW, ...unk],
    }
  }
  if (inW.length > 1) {
    const shortlisted = inW.filter((o) => o.status === 'shortlisted')
    if (shortlisted.length === 1) {
      return {
        status: 'ok',
        primary: shortlisted[0]!,
        obsolete: [
          ...outW,
          ...unk,
          ...inW.filter((o) => o.externalId !== shortlisted[0]!.externalId),
        ],
      }
    }
    return {
      status: 'ambiguous',
      candidates: inW,
      reason: `ambiguous ${role}: multiple IN_WINDOW (${inW.map((o) => o.externalId).join(', ')})`,
    }
  }

  // zero IN_WINDOW
  const plausible = [...unk, ...outW]
  if (plausible.length === 1) {
    return { status: 'ok', primary: plausible[0]!, obsolete: [] }
  }
  if (plausible.length > 1) {
    if (optsExtra?.allowOutOfWindowPrimary) {
      const shortlisted = plausible.filter((o) => o.status === 'shortlisted')
      if (shortlisted.length === 1) {
        return {
          status: 'ok',
          primary: shortlisted[0]!,
          obsolete: plausible.filter(
            (o) => o.externalId !== shortlisted[0]!.externalId,
          ),
        }
      }
      // Latest startAt among returns/outbounds as deterministic fallback
      const sorted = [...plausible].sort((a, b) =>
        datePrefix(b.startAt).localeCompare(datePrefix(a.startAt)),
      )
      const primary = sorted[0]!
      return {
        status: 'ok',
        primary,
        obsolete: plausible.filter((o) => o.externalId !== primary.externalId),
      }
    }
    return {
      status: 'ambiguous',
      candidates: plausible,
      reason: `ambiguous ${role}: zero IN_WINDOW, multiple candidates (${plausible.map((o) => o.externalId).join(', ')})`,
    }
  }

  return { status: 'empty' }
}

/** Same scheduled flight under another externalId (flight number or route + departure instant). */
function sameScheduledFlight(a: OptView, b: OptView): boolean {
  if (a.type !== 'flight' || b.type !== 'flight') return false
  const day = datePrefix(a.startAt)
  if (!day || day !== datePrefix(b.startAt)) return false
  const fa = extractFlightNumberFromSourceUrl(a.sourceUrl)
  const fb = extractFlightNumberFromSourceUrl(b.sourceUrl)
  if (fa && fb) return fa === fb
  const ta = Date.parse(a.startAt!)
  const tb = Date.parse(b.startAt!)
  return (
    Number.isFinite(ta) &&
    ta === tb &&
    (extractIataCode(a.origin) ?? '') === (extractIataCode(b.origin) ?? '') &&
    (extractIataCode(a.destination) ?? '') ===
      (extractIataCode(b.destination) ?? '')
  )
}

function lodgingFingerprint(o: OptView): string {
  return JSON.stringify([
    o.type,
    normText(o.title).slice(0, 80),
    datePrefix(o.startAt),
    datePrefix(o.endAt),
    normText(`${o.address ?? ''} ${o.destination ?? ''}`).slice(0, 80),
  ])
}

function canonicalOpOrder(ops: AgentOpRecord[]): AgentOpRecord[] {
  const rank = (op: string) =>
    ({ remove: 0, supersede: 1, update: 2, add: 3, noop: 4 })[op] ?? 5
  const key = (o: AgentOpRecord) =>
    `${rank(o.op)}|${o.entityKind}|${o.supersedesExternalId ?? ''}|${o.externalId}`
  const seen = new Set<string>()
  const unique: AgentOpRecord[] = []
  for (const o of ops) {
    const k = JSON.stringify([
      o.op,
      o.entityKind,
      o.externalId,
      o.supersedesExternalId ?? null,
    ])
    if (seen.has(k)) continue
    seen.add(k)
    unique.push(o)
  }
  return unique.sort((a, b) => key(a).localeCompare(key(b)))
}

function datesShifted(
  current: { startDate: string; endDate: string },
  proposed: { startDate: string; endDate: string },
): boolean {
  return (
    current.startDate !== proposed.startDate ||
    current.endDate !== proposed.endDate
  )
}

const PLACEHOLDER_TITLE =
  /^(opci[oó]n investigada|opcion investigada|tbd|n\/?a|pending|sin t[ií]tulo|untitled|placeholder)$/i

const LODGING_NIGHTS_RE = /(\d+)\s*noche\(s\)/gi

const MONTH_ABBR_ES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && !v.trim())
}

function isPlaceholderTitle(title: string): boolean {
  return !title.trim() || PLACEHOLDER_TITLE.test(title.trim())
}

/** Extract flight designator from AeroDataBox-style sourceUrl (`flight=AM221`). */
export function extractFlightNumberFromSourceUrl(
  sourceUrl: string | undefined,
): string | undefined {
  if (!sourceUrl) return undefined
  const m = sourceUrl.match(/[?&]flight=([A-Za-z0-9]+)/i)
  return m?.[1]?.toUpperCase()
}

/** Local day a date-bound schedule source is about (`date=2026-10-01`). */
export function sourceUrlDay(sourceUrl: string | undefined): string | undefined {
  return sourceUrl?.match(/[?&]date=(\d{4}-\d{2}-\d{2})(?![\d])/)?.[1]
}

/** A published schedule is evidence for one day only. */
function isDateBoundFlight(o: { type?: string; sourceType?: string; sourceUrl?: string }): boolean {
  return (
    o.type === 'flight' &&
    (o.sourceType === 'flight_schedule' || Boolean(sourceUrlDay(o.sourceUrl)))
  )
}

/** Owned fields that belong to a schedule's day and must not survive a day change. */
const RESCHEDULED_FLIGHT_FIELDS = [
  'title',
  'description',
  'notes',
  'provider',
  'sourceType',
  'sourceUrl',
  'checkedAt',
  'verificationStatus',
] as const

function formatDayMonthEs(isoWithOffset: string): string | undefined {
  const ymd = datePrefix(isoWithOffset)
  if (!ymd) return undefined
  const parts = ymd.split('-')
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (!month || !day || month < 1 || month > 12) return undefined
  return `${day} ${MONTH_ABBR_ES[month - 1]}`
}

/**
 * Deterministic title for a flight_schedule option when the LLM left a
 * placeholder. Uses carrier + flight number + route + local times.
 * Returns undefined when insufficient structured data exists.
 */
export function buildFlightScheduleTitle(o: {
  provider?: string
  sourceUrl?: string
  origin?: string
  destination?: string
  startAt?: string
  endAt?: string
}): string | undefined {
  const flight = extractFlightNumberFromSourceUrl(o.sourceUrl)
  const ori = extractIataCode(o.origin) ?? undefined
  const dest = extractIataCode(o.destination) ?? undefined
  if (!flight || !ori || !dest || !o.startAt) return undefined
  const carrier = (o.provider ?? '').trim() || flight.slice(0, 2)
  const day = formatDayMonthEs(o.startAt)
  const dep = formatClockEs(o.startAt)
  const arr = o.endAt ? formatClockEs(o.endAt) : undefined
  const time = arr ? `${dep} → ${arr}` : dep
  const dayPart = day ? ` · ${day}` : ''
  return `${carrier} ${flight} ${ori} → ${dest}${dayPart} · ${time}`
}

/**
 * Keep the local time / offset suffix of an ISO timestamp, replace the YMD.
 * Example: 2026-09-28T12:00:00-06:00 + 2026-10-01 → 2026-10-01T12:00:00-06:00
 */
export function rebindIsoDateKeepingTime(
  iso: string | undefined,
  ymd: string,
): string | undefined {
  if (!iso || !ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return undefined
  const m = iso.match(/T.+/)
  if (!m) return undefined
  return `${ymd}${m[0]}`
}

/** Calendar nights between start/end date prefixes (check-out − check-in). */
export function lodgingNightsBetween(
  startAt: string | undefined,
  endAt: string | undefined,
): number | null {
  const s = datePrefix(startAt)
  const e = datePrefix(endAt)
  if (!s || !e) return null
  const ds = Date.parse(`${s}T00:00:00Z`)
  const de = Date.parse(`${e}T00:00:00Z`)
  if (!Number.isFinite(ds) || !Number.isFinite(de) || de < ds) return null
  return Math.round((de - ds) / 86_400_000)
}

/**
 * When a lodging title embeds "N noche(s)", rewrite N to match startAt/endAt.
 * Does not invent a nights phrase if the title has none.
 */
export function syncLodgingNightsInTitle(
  title: string,
  startAt: string | undefined,
  endAt: string | undefined,
): string {
  if (!LODGING_NIGHTS_RE.test(title)) return title
  LODGING_NIGHTS_RE.lastIndex = 0
  const nights = lodgingNightsBetween(startAt, endAt)
  if (nights === null || nights < 1) return title
  return title.replace(LODGING_NIGHTS_RE, `${nights} noche(s)`)
}

/** Day kept by agent grounding when an unverified clock was stripped. */
const DATE_HINT_RE = /(Fecha asociada \(sin hora verificada\):\s*)(\d{4}-\d{2}-\d{2})/i

export type WindowFit =
  | { kind: 'keep' }
  | {
      kind: 'rebind'
      patch: Pick<Partial<PackageTravelOption>, 'startAt' | 'endAt' | 'notes'>
      reason: string
    }
  | { kind: 'conflict'; reason: string }

/**
 * Fit a window-dependent component (lodging / ground transfer) to a trip date
 * shift. A date moves only when it sat exactly on a trip boundary that moved:
 * lodging covering the whole old stay takes the new boundaries, a transfer on
 * the old arrival/departure day takes the new one; clock and offset are kept.
 * No date → nothing stale → keep. A date the rule cannot place, or a protected
 * / verified component that would move, is a conflict (never silently stale).
 */
export function fitToShiftedWindow(
  o: Pick<
    PackageTravelOption,
    'externalId' | 'startAt' | 'endAt' | 'notes' | 'verificationStatus'
  > & { status?: string; bookingId?: string | null },
  role: LogicalRole,
  from: { startDate: string; endDate: string },
  to: { startDate: string; endDate: string },
): WindowFit {
  const startMoved = from.startDate !== to.startDate
  const endMoved = from.endDate !== to.endDate
  const inNew = (d: string) => d >= to.startDate && d <= to.endDate
  const s = datePrefix(o.startAt)
  const e = datePrefix(o.endAt)
  const hint = o.notes?.match(DATE_HINT_RE)?.[2]
  const patch: Pick<Partial<PackageTravelOption>, 'startAt' | 'endAt' | 'notes'> = {}
  const retag = (day: string) => {
    if (o.notes && hint) patch.notes = o.notes.replace(DATE_HINT_RE, `$1${day}`)
  }
  const unplaceable = (dates: string) => ({
    kind: 'conflict' as const,
    reason: `${o.externalId} ${dates} is outside new window ${to.startDate}→${to.endDate} and not on a moved trip boundary — dates cannot be derived (review)`,
  })

  if (role === 'lodging_primary' || role === 'lodging_fallback') {
    if (s || e) {
      const wholeStay =
        (!s || s === from.startDate) && (!e || e === from.endDate)
      if (wholeStay) {
        if (s && startMoved) patch.startAt = rebindIsoDateKeepingTime(o.startAt, to.startDate)
        if (e && endMoved) patch.endAt = rebindIsoDateKeepingTime(o.endAt, to.endDate)
        if (hint === from.startDate && startMoved) retag(to.startDate)
      } else if ((s && !inNew(s)) || (e && !inNew(e))) {
        return unplaceable(`${s || '?'}→${e || '?'}`)
      }
    } else if (hint) {
      if (hint === from.startDate && startMoved) retag(to.startDate)
      else if (!inNew(hint)) return unplaceable(hint)
    }
  } else if (role === 'ground_transfer') {
    const d = s || hint
    if (d) {
      const target =
        d === from.startDate && startMoved
          ? to.startDate
          : d === from.endDate && endMoved
            ? to.endDate
            : undefined
      if (target) {
        if (s) patch.startAt = rebindIsoDateKeepingTime(o.startAt, target)
        if (e) {
          if (e !== d) return unplaceable(`${s}→${e}`)
          patch.endAt = rebindIsoDateKeepingTime(o.endAt, target)
        }
        if (hint === d) retag(target)
      } else if (!inNew(d)) {
        return unplaceable(d)
      }
    }
  }

  if (!Object.keys(patch).length) return { kind: 'keep' }
  if (isProtectedTravelOption(o)) {
    return {
      kind: 'conflict',
      reason: `cannot move protected ${o.externalId} (status=${o.status ?? ''}) to the new window — review`,
    }
  }
  if (o.verificationStatus === 'verified') {
    return {
      kind: 'conflict',
      reason: `${o.externalId} was verified for the old dates — re-verify for ${to.startDate}→${to.endDate} (review)`,
    }
  }
  return {
    kind: 'rebind',
    patch,
    reason: `window shift ${from.startDate}→${from.endDate} ⇒ ${to.startDate}→${to.endDate}: ${role} dates follow the moved trip boundary`,
  }
}

const WEAK_SOURCE: Record<string, number> = {
  agent: 1,
  other: 1,
  imported: 2,
  cursor: 2,
  manual: 3,
  flight_schedule: 4,
}

export type MergePreserveOpts = {
  allowTemporalReplace?: boolean
  /**
   * Explicit field mask (from structured patches / known intent).
   * Without a mask, Ask Travel package reuse of externalId does NOT imply
   * authority to overwrite owned text fields on an existing entity.
   */
  changedFields?: readonly string[]
  /**
   * Proposed trip window after a date shift. When lodging clocks were stripped
   * by agent grounding (no verified+sourceUrl), rebind current check-in/out
   * times onto these dates so the stay covers the new trip.
   */
  targetTripWindow?: { startDate: string; endDate: string }
}

function fieldExplicitlyChanged(
  field: string,
  changedFields: readonly string[] | undefined,
): boolean {
  return Boolean(changedFields?.includes(field))
}

function cleanProposedText(proposed: string | undefined): string | undefined {
  if (proposed === undefined || proposed === null) return proposed
  if (!containsDisallowedControl(proposed)) return proposed
  return stripDisallowedControls(proposed).value
}

/**
 * Prefer current when proposed is blank or control-degraded.
 * Used only for fields that are allowed to take proposed values.
 */
function preferCleanText(
  proposed: string | undefined,
  current: string | undefined,
): string | undefined {
  if (proposed !== undefined && containsDisallowedControl(proposed)) {
    if (!isBlank(current) && !containsDisallowedControl(current)) {
      return current
    }
    const cleaned = stripDisallowedControls(proposed).value
    return isBlank(cleaned) ? current : cleaned
  }
  if (!isBlank(proposed)) return proposed
  return current
}

function allowsFlightScheduleProvenance(type: string): boolean {
  return type === 'flight'
}

/**
 * Structural provenance invariant: flight_schedule ownership is flight-only.
 * Transfer/lodging must not inherit flight_schedule sourceType/url/checkedAt.
 */
function applyProvenanceInvariants(
  entityType: string,
  sourceType: PackageTravelOption['sourceType'] | undefined,
  sourceUrl: string | undefined,
  checkedAt: string | undefined,
  current: TravelOption,
): {
  sourceType: PackageTravelOption['sourceType']
  sourceUrl: string | undefined
  checkedAt: string | undefined
} {
  if (
    sourceType === 'flight_schedule' &&
    !allowsFlightScheduleProvenance(entityType)
  ) {
    return {
      sourceType:
        (current.sourceType as PackageTravelOption['sourceType']) ?? 'agent',
      sourceUrl: current.sourceUrl,
      checkedAt: current.checkedAt,
    }
  }
  return {
    sourceType: sourceType ?? 'agent',
    sourceUrl,
    checkedAt,
  }
}

/**
 * Scrub a brand-new package option (no current entity): strip disallowed
 * controls and reject flight_schedule provenance on non-flight types.
 */
export function scrubNewPackageOption(
  proposed: PackageTravelOption,
): PackageTravelOption {
  let title = cleanProposedText(proposed.title)?.trim() || proposed.title
  const entityType = proposed.type || 'other'
  let sourceType = proposed.sourceType ?? 'agent'
  let sourceUrl = cleanProposedText(proposed.sourceUrl)
  let checkedAt = cleanProposedText(proposed.checkedAt)
  const provider = cleanProposedText(proposed.provider)
  if (
    sourceType === 'flight_schedule' &&
    !allowsFlightScheduleProvenance(entityType)
  ) {
    sourceType = 'agent'
    sourceUrl = undefined
    checkedAt = undefined
  }
  if (
    entityType === 'flight' &&
    sourceType === 'flight_schedule' &&
    isPlaceholderTitle(title)
  ) {
    const built = buildFlightScheduleTitle({
      provider,
      sourceUrl,
      origin: proposed.origin,
      destination: proposed.destination,
      startAt: proposed.startAt,
      endAt: proposed.endAt,
    })
    if (built) title = built
  }
  if (entityType === 'lodging') {
    title = syncLodgingNightsInTitle(title, proposed.startAt, proposed.endAt)
  }
  return {
    ...proposed,
    title,
    provider,
    description: cleanProposedText(proposed.description),
    origin: cleanProposedText(proposed.origin),
    destination: cleanProposedText(proposed.destination),
    address: cleanProposedText(proposed.address),
    phone: cleanProposedText(proposed.phone),
    notes: cleanProposedText(proposed.notes),
    sourceUrl,
    checkedAt,
    sourceType,
  }
}

/**
 * Merge proposed fields onto a conserved current entity.
 *
 * Field ownership (preserve-by-default):
 * - Owned text (notes/description/address/phone): keep current unless the
 *   field is listed in changedFields. Blank current stays blank.
 * - Title: keep current unless changedFields includes title, or current is
 *   blank/placeholder and proposed is a clean non-placeholder.
 * - Route (origin/destination): keep current unless changedFields or current blank.
 * - Provenance: structured strength upgrade for flights only; never attach
 *   flight_schedule to transfer/lodging.
 * - Temporal: unchanged rules via allowTemporalReplace / explicit date delta.
 *
 * Control-degraded proposed text never beats clean current. No attempt is made
 * to map U+0015→"—"/U+0018→"·".
 */
export function mergePreservedPackageOption(
  current: TravelOption,
  proposed: PackageTravelOption,
  opts?: MergePreserveOpts,
): PackageTravelOption {
  const allowTemporal = opts?.allowTemporalReplace ?? false
  const changedFields = opts?.changedFields
  const entityType =
    proposed.type || (current.type as PackageTravelOption['type'])

  // Lodging date-shift: agent grounding strips startAt/endAt without
  // verified+sourceUrl. Rebind current check-in/out times onto the new trip
  // window so the stay covers trip.endDate.
  let effectiveProposed = proposed
  if (
    entityType === 'lodging' &&
    allowTemporal &&
    opts?.targetTripWindow &&
    (!proposed.startAt || !proposed.endAt)
  ) {
    const reboundStart =
      proposed.startAt ??
      rebindIsoDateKeepingTime(
        current.startAt,
        opts.targetTripWindow.startDate,
      )
    const reboundEnd =
      proposed.endAt ??
      rebindIsoDateKeepingTime(current.endAt, opts.targetTripWindow.endDate)
    effectiveProposed = {
      ...proposed,
      ...(reboundStart ? { startAt: reboundStart } : {}),
      ...(reboundEnd ? { endAt: reboundEnd } : {}),
    }
  }

  const curStart = datePrefix(current.startAt)
  const propStart = datePrefix(effectiveProposed.startAt)
  const curEnd = datePrefix(current.endAt)
  const propEnd = datePrefix(effectiveProposed.endAt)

  const explicitTemporal =
    allowTemporal ||
    fieldExplicitlyChanged('startAt', changedFields) ||
    fieldExplicitlyChanged('endAt', changedFields) ||
    (Boolean(propStart) && Boolean(curStart) && propStart !== curStart) ||
    (Boolean(propEnd) && Boolean(curEnd) && propEnd !== curEnd) ||
    (Boolean(propStart) && !curStart) ||
    (Boolean(propEnd) && !curEnd)

  const pickOwned = (
    field: string,
    proposedVal: string | undefined,
    currentVal: string | undefined,
  ): string | undefined => {
    if (fieldExplicitlyChanged(field, changedFields)) {
      return preferCleanText(proposedVal, currentVal)
    }
    // Preserve-by-default — including preserving blank/null.
    return currentVal
  }

  const propTitleClean = cleanProposedText(proposed.title) ?? ''
  let title = current.title
  if (fieldExplicitlyChanged('title', changedFields)) {
    title =
      !isPlaceholderTitle(propTitleClean) && propTitleClean.trim()
        ? propTitleClean
        : current.title
  } else if (
    proposed.title !== undefined &&
    containsDisallowedControl(proposed.title) &&
    !isBlank(current.title) &&
    !containsDisallowedControl(current.title)
  ) {
    // Control-degraded proposed must not overwrite clean current.
    title = current.title
  } else if (
    isPlaceholderTitle(propTitleClean) &&
    !isPlaceholderTitle(current.title)
  ) {
    title = current.title
  } else if (
    (isBlank(current.title) || isPlaceholderTitle(current.title)) &&
    !isPlaceholderTitle(propTitleClean) &&
    propTitleClean.trim() &&
    !(proposed.title && containsDisallowedControl(proposed.title))
  ) {
    // Fill only when current is blank/placeholder and proposed is clean.
    title = propTitleClean
  } else {
    // Preserve-by-default: package reuse of externalId is not a title rewrite.
    title = current.title
  }

  const startAt = explicitTemporal
    ? effectiveProposed.startAt ?? current.startAt
    : current.startAt ?? effectiveProposed.startAt
  const endAt = explicitTemporal
    ? effectiveProposed.endAt ?? current.endAt
    : current.endAt ?? effectiveProposed.endAt

  const curSrcRank = WEAK_SOURCE[current.sourceType ?? ''] ?? 0
  const propSrcRank = WEAK_SOURCE[proposed.sourceType ?? ''] ?? 0

  let sourceType: PackageTravelOption['sourceType']
  let sourceUrl: string | undefined
  let provider: string | undefined
  let checkedAt: string | undefined
  let verificationStatus = current.verificationStatus

  const provenanceExplicit =
    fieldExplicitlyChanged('sourceType', changedFields) ||
    fieldExplicitlyChanged('sourceUrl', changedFields) ||
    fieldExplicitlyChanged('provider', changedFields) ||
    fieldExplicitlyChanged('checkedAt', changedFields) ||
    fieldExplicitlyChanged('verificationStatus', changedFields)

  if (provenanceExplicit) {
    sourceType =
      (proposed.sourceType as PackageTravelOption['sourceType']) ??
      (current.sourceType as PackageTravelOption['sourceType']) ??
      'agent'
    sourceUrl = preferCleanText(proposed.sourceUrl, current.sourceUrl)
    provider = preferCleanText(proposed.provider, current.provider)
    checkedAt = preferCleanText(proposed.checkedAt, current.checkedAt)
    verificationStatus =
      proposed.verificationStatus ?? current.verificationStatus
  } else if (
    allowsFlightScheduleProvenance(entityType) &&
    propSrcRank > curSrcRank &&
    proposed.sourceType
  ) {
    // Structured upgrade only: stronger provenance on flights.
    sourceType = proposed.sourceType
    sourceUrl = preferCleanText(proposed.sourceUrl, current.sourceUrl)
    provider = preferCleanText(proposed.provider, current.provider)
    checkedAt = preferCleanText(proposed.checkedAt, current.checkedAt)
    verificationStatus =
      proposed.verificationStatus ?? current.verificationStatus
  } else {
    sourceType =
      (current.sourceType as PackageTravelOption['sourceType']) ??
      (propSrcRank >= curSrcRank && proposed.sourceType
        ? proposed.sourceType
        : undefined) ??
      'agent'
    // Prefer current provenance fields; fill blanks from clean proposed only
    // when current is blank (not an owned-text overwrite of meaningful data).
    sourceUrl = !isBlank(current.sourceUrl)
      ? current.sourceUrl
      : preferCleanText(proposed.sourceUrl, current.sourceUrl)
    provider = !isBlank(current.provider)
      ? current.provider
      : preferCleanText(proposed.provider, current.provider)
    checkedAt = !isBlank(current.checkedAt)
      ? current.checkedAt
      : preferCleanText(proposed.checkedAt, current.checkedAt)
    verificationStatus =
      current.verificationStatus ?? proposed.verificationStatus
  }

  const provenance = applyProvenanceInvariants(
    entityType,
    sourceType,
    sourceUrl,
    checkedAt,
    current,
  )
  sourceType = provenance.sourceType
  sourceUrl = provenance.sourceUrl
  checkedAt = provenance.checkedAt

  const origin = fieldExplicitlyChanged('origin', changedFields)
    ? preferCleanText(proposed.origin, current.origin)
    : !isBlank(current.origin)
      ? current.origin
      : preferCleanText(proposed.origin, current.origin)
  const destination = fieldExplicitlyChanged('destination', changedFields)
    ? preferCleanText(proposed.destination, current.destination)
    : !isBlank(current.destination)
      ? current.destination
      : preferCleanText(proposed.destination, current.destination)

  const address = pickOwned('address', proposed.address, current.address)
  const phone = pickOwned('phone', proposed.phone, current.phone)
  const description = pickOwned(
    'description',
    proposed.description,
    current.description,
  )
  const notes = pickOwned('notes', proposed.notes, current.notes)

  const status =
    proposed.status === 'shortlisted' || proposed.status === 'researched'
      ? proposed.status
      : current.status === 'shortlisted' || current.status === 'researched'
        ? current.status
        : 'researched'

  let finalTitle = title
  if (entityType === 'lodging' && explicitTemporal) {
    finalTitle = syncLodgingNightsInTitle(finalTitle, startAt, endAt)
  }

  return {
    externalId: proposed.externalId,
    type: entityType,
    status,
    title: finalTitle,
    provider,
    description,
    startAt,
    endAt,
    origin,
    destination,
    address,
    phone,
    priceObserved: fieldExplicitlyChanged('priceObserved', changedFields)
      ? (proposed.priceObserved ?? current.priceObserved)
      : (current.priceObserved ?? proposed.priceObserved),
    currency: (fieldExplicitlyChanged('currency', changedFields)
      ? (proposed.currency ?? current.currency)
      : (current.currency ??
        proposed.currency)) as PackageTravelOption['currency'],
    sourceUrl,
    checkedAt,
    verificationStatus,
    sourceType,
    notes,
    logicalRole: proposed.logicalRole,
  }
}

function currentToPackageOption(cur: TravelOption): PackageTravelOption {
  return {
    externalId: cur.externalId ?? cur.id,
    type: cur.type as PackageTravelOption['type'],
    status:
      cur.status === 'shortlisted' || cur.status === 'researched'
        ? cur.status
        : 'researched',
    title: cur.title,
    provider: cur.provider,
    description: cur.description,
    startAt: cur.startAt,
    endAt: cur.endAt,
    origin: cur.origin,
    destination: cur.destination,
    address: cur.address,
    phone: cur.phone,
    priceObserved: cur.priceObserved,
    currency: cur.currency as PackageTravelOption['currency'],
    sourceUrl: cur.sourceUrl,
    checkedAt: cur.checkedAt,
    verificationStatus: cur.verificationStatus,
    sourceType: (cur.sourceType as PackageTravelOption['sourceType']) ?? 'agent',
    notes: cur.notes,
  }
}

/**
 * Resolve LLM hint identifiers to contract externalIds for this trip.
 * Accepts bare externalId, or formula entity ids (opt-/itin-/chk-/note-).
 * Foreign trip/package entity ids → unresolved (ignored).
 */
export function normalizeHintExternalId(
  raw: string,
  args: {
    tripId: string
    packageIds: Set<string>
    currentByExternalId: Map<string, OptView>
    currentByEntityId: Map<string, OptView>
  },
): { externalId: string; entityKindHint?: AgentOpRecord['entityKind'] } | null {
  const id = raw.trim()
  if (!id) return null

  const byExt = args.currentByExternalId.get(id)
  if (byExt) return { externalId: byExt.externalId }

  const byEntity = args.currentByEntityId.get(id)
  if (byEntity) return { externalId: byEntity.externalId }

  for (const packageId of args.packageIds) {
    for (const [ext, view] of args.currentByExternalId) {
      if (optionEntityId(packageId, ext) === id) {
        return { externalId: view.externalId, entityKindHint: 'travelOption' }
      }
      if (itineraryEntityId(packageId, ext) === id) {
        return { externalId: ext, entityKindHint: 'itineraryItem' }
      }
      if (checklistEntityId(packageId, ext) === id) {
        return { externalId: ext, entityKindHint: 'checklistItem' }
      }
      if (noteEntityId(packageId, ext) === id) {
        return { externalId: ext, entityKindHint: 'note' }
      }
    }
    // Also try stripping known prefixes even if externalId not in current
    // (proposal-only ids) — only when packageId matches this trip's packages.
    const optPrefix = `opt-${packageId}-`
    if (id.startsWith(optPrefix)) {
      const ext = id.slice(optPrefix.length)
      if (ext && !ext.includes('/')) {
        return { externalId: ext, entityKindHint: 'travelOption' }
      }
    }
    for (const [prefix, kind] of [
      [`itin-${packageId}-`, 'itineraryItem'],
      [`chk-${packageId}-`, 'checklistItem'],
      [`note-${packageId}-`, 'note'],
    ] as const) {
      if (id.startsWith(prefix)) {
        const ext = id.slice(prefix.length)
        if (ext) return { externalId: ext, entityKindHint: kind }
      }
    }
  }

  // Malformed opt- from a *different* package/trip — reject
  if (/^(opt|itin|chk|note)-/.test(id)) {
    return null
  }

  // Bare id not found in current — may still be a proposed-only externalId
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    return { externalId: id }
  }

  return null
}

export function normalizeLlmOps(
  llmOps: AgentOpRecord[],
  args: {
    tripId: string
    packageIds: Set<string>
    currentByExternalId: Map<string, OptView>
    currentByEntityId: Map<string, OptView>
  },
): { ops: AgentOpRecord[]; warnings: string[] } {
  const warnings: string[] = []
  const out: AgentOpRecord[] = []
  for (const hint of llmOps) {
    if (hint.op === 'noop') continue
    const resolved = normalizeHintExternalId(hint.externalId, args)
    if (!resolved) {
      warnings.push(
        `ignored llm op ${hint.op}: unresolved id ${hint.externalId}`,
      )
      continue
    }
    let supersedes: string | undefined
    if (hint.supersedesExternalId) {
      const s = normalizeHintExternalId(hint.supersedesExternalId, args)
      if (!s) {
        warnings.push(
          `ignored llm op ${hint.op}: unresolved supersedesExternalId ${hint.supersedesExternalId}`,
        )
        continue
      }
      supersedes = s.externalId
    }
    const entityKind =
      hint.entityKind ??
      resolved.entityKindHint ??
      'travelOption'
    out.push({
      ...hint,
      entityKind,
      externalId: resolved.externalId,
      supersedesExternalId: supersedes,
    })
  }
  return { ops: out, warnings }
}

/**
 * Compile a deterministic MutationPlan from persisted state + proposed package.
 * llmOps are hints only — never executed blindly.
 */
export function compileMutationPlan(args: {
  tripId: string
  currentTrip: Pick<Trip, 'startDate' | 'endDate' | 'destination'>
  currentOptions: TravelOption[]
  proposedPackage: TripPackageV1
  llmOps?: AgentOpRecord[]
}): CompiledMutationPlan {
  const {
    tripId,
    currentTrip,
    currentOptions,
    proposedPackage,
    llmOps: rawLlmOps = [],
  } = args
  const warnings: string[] = []
  const conflicts: string[] = []
  const matching: CompiledMutationPlan['matching'] = []
  const ops: AgentOpRecord[] = []

  const proposedTrip = {
    startDate: proposedPackage.trip.startDate,
    endDate: proposedPackage.trip.endDate,
    destination:
      proposedPackage.trip.destination ?? currentTrip.destination,
  }

  // Matching window = proposed (target) trip dates — the vigente window.
  const window = {
    startDate: proposedTrip.startDate,
    endDate: proposedTrip.endDate,
  }

  const shift = datesShifted(currentTrip, proposedTrip)

  const currentViews = currentOptions
    .filter((o) => o.tripId === tripId)
    .map((o) => toView(o, o.externalId ?? o.id))
  const proposedViews = proposedPackage.travelOptions.map((o) =>
    toView(o, o.externalId),
  )

  const curRoles = groupByRole(currentViews, {
    ...currentTrip,
    // Prefer route inference; window classification is separate
  })
  const legs = routeLegs(curRoles)
  const propRoles = groupByRole(proposedViews, proposedTrip, legs)

  const proposedById = new Map(proposedViews.map((o) => [o.externalId, o]))
  const currentById = new Map(currentViews.map((o) => [o.externalId, o]))
  const currentByEntityId = new Map<string, OptView>()
  const packageIds = new Set<string>([tripId, proposedPackage.packageId])
  for (const v of currentViews) {
    if (v.entityId) currentByEntityId.set(v.entityId, v)
    if (v.packageId) packageIds.add(v.packageId)
    // Always index formula id for this trip's packages
    for (const pid of packageIds) {
      currentByEntityId.set(optionEntityId(pid, v.externalId), v)
    }
  }

  const { ops: llmOps, warnings: idWarnings } = normalizeLlmOps(rawLlmOps, {
    tripId,
    packageIds,
    currentByExternalId: currentById,
    currentByEntityId,
  })
  warnings.push(...idWarnings)

  const keepProposedIds = new Set<string>()
  const removeCurrentIds = new Set<string>()
  /** Same-id updates that should NOT treat proposed dates as authoritative. */
  const preserveTemporalIds = new Set<string>()
  /** Same-id flights moved to another day by a schedule for that day. */
  const rescheduledFlightIds = new Set<string>()
  /** Same-id flights moved to another day with no schedule for it: rewrite ignored. */
  const ignoredFlightRewriteIds = new Set<string>()

  const pushSupersede = (
    from: OptView,
    to: OptView,
    role: LogicalRole,
    reason: string,
  ) => {
    if (from.externalId === to.externalId) {
      ops.push({
        op: 'update',
        entityKind: 'travelOption',
        externalId: to.externalId,
        note: reason,
      })
      keepProposedIds.add(to.externalId)
      if (!shift && classifyWindow(from, window) === 'IN_WINDOW') {
        preserveTemporalIds.add(to.externalId)
      }
      matching.push({
        role,
        action: 'update',
        from: from.externalId,
        to: to.externalId,
        reason,
      })
      return
    }
    ops.push({
      op: 'supersede',
      entityKind: 'travelOption',
      externalId: to.externalId,
      supersedesExternalId: from.externalId,
      note: reason,
    })
    keepProposedIds.add(to.externalId)
    removeCurrentIds.add(from.externalId)
    matching.push({
      role,
      action: 'supersede',
      from: from.externalId,
      to: to.externalId,
      reason,
    })
  }

  const pushUpdate = (id: string, role: LogicalRole, reason: string) => {
    ops.push({
      op: 'update',
      entityKind: 'travelOption',
      externalId: id,
      note: reason,
    })
    keepProposedIds.add(id)
    matching.push({ role, action: 'update', to: id, reason })
  }

  const pushAdd = (id: string, role: LogicalRole, reason: string) => {
    ops.push({
      op: 'add',
      entityKind: 'travelOption',
      externalId: id,
      note: reason,
    })
    keepProposedIds.add(id)
    matching.push({ role, action: 'add', to: id, reason })
  }

  const pushRemove = (id: string, role: LogicalRole, reason: string) => {
    const cur = currentById.get(id)
    if (!cur) return
    if (isProtectedTravelOption(cur)) {
      conflicts.push(
        `cannot remove protected ${id} (status=${cur.status}` +
          (cur.bookingId ? ` bookingId=${cur.bookingId}` : '') +
          ')',
      )
      return
    }
    if (removeCurrentIds.has(id)) return
    ops.push({
      op: 'remove',
      entityKind: 'travelOption',
      externalId: id,
      note: reason,
    })
    removeCurrentIds.add(id)
    matching.push({ role, action: 'remove', from: id, reason })
  }

  const llmRemoveHint = (externalId: string): boolean =>
    llmOps.some(
      (op) =>
        op.op === 'remove' &&
        op.entityKind === 'travelOption' &&
        op.externalId === externalId,
    )

  /**
   * Remove OUT_OF_WINDOW currents that are not in the proposal when there is
   * structured evidence (LLM remove hint, or a kept IN_WINDOW winner for role).
   */
  const absorbObsolete = (
    obsolete: OptView[],
    role: LogicalRole,
    hasInWindowWinner: boolean,
  ) => {
    for (const obs of obsolete) {
      if (proposedById.has(obs.externalId)) continue
      if (keepProposedIds.has(obs.externalId)) continue
      const w = classifyWindow(obs, window)
      if (w === 'IN_WINDOW') continue
      const hinted = llmRemoveHint(obs.externalId)
      const shouldRemove =
        hinted ||
        (hasInWindowWinner && w === 'OUT_OF_WINDOW') ||
        (shift && w === 'OUT_OF_WINDOW')
      if (!shouldRemove) continue
      // Protected → pushRemove records conflict (fail closed). Research-only otherwise.
      if (
        !isProtectedTravelOption(obs) &&
        !isResearchStatus(obs.status)
      ) {
        continue
      }
      pushRemove(
        obs.externalId,
        role,
        hinted
          ? 'llm remove hint: obsolete out-of-window option'
          : 'out-of-window obsolete vs IN_WINDOW winner',
      )
    }
  }

  const llmReplaceHint = (externalId: string): boolean =>
    llmOps.some(
      (op) =>
        op.entityKind === 'travelOption' &&
        ((op.op === 'remove' && op.externalId === externalId) ||
          (op.op === 'supersede' &&
            op.supersedesExternalId === externalId &&
            op.externalId !== externalId)),
    )

  /**
   * A same-id flight moved to another day: a date-bound schedule may only move
   * with a schedule for the new day (its provenance then replaces the old one);
   * otherwise the rewrite is ignored and the current flight is left as is.
   */
  const flightDayMove = (
    c: OptView,
    p: OptView,
  ): 'same_day' | 'rescheduled' | 'unsupported' => {
    const fromDay = datePrefix(c.startAt)
    const toDay = datePrefix(p.startAt)
    if (
      c.externalId !== p.externalId ||
      !isDateBoundFlight(c) ||
      !fromDay ||
      !toDay ||
      fromDay === toDay
    ) {
      return 'same_day'
    }
    if (sourceUrlDay(p.sourceUrl) === toDay) {
      rescheduledFlightIds.add(p.externalId)
      return 'rescheduled'
    }
    warnings.push(
      `${p.externalId} moved ${fromDay}→${toDay} without a schedule for ${toDay} — the ${fromDay} schedule is not carried to another day`,
    )
    ignoredFlightRewriteIds.add(p.externalId)
    return 'unsupported'
  }

  /** Single-flight leg whose same-id rewrite was ignored: drop it if the leg moved off its day. */
  const settleIgnoredFlightRewrite = (
    c: OptView,
    role: 'flight_outbound' | 'flight_return',
    anchorMoved: boolean,
    anchor: string,
  ) => {
    if (anchorMoved && datePrefix(c.startAt) !== anchor) {
      pushRemove(
        c.externalId,
        role,
        `date-shift: ${role} schedule of ${datePrefix(c.startAt)} has no schedule for ${anchor}`,
      )
      return
    }
    keepProposedIds.add(c.externalId)
    preserveTemporalIds.add(c.externalId)
  }

  /**
   * Several options for the same flight leg are alternatives, matched as a set
   * (never by electing one "current" primary). Proposed alternatives update
   * (same id) or are added; a proposed copy of a current flight keeps the
   * current id; a proposed alternative outside the target window is dropped.
   * A current alternative the proposal omits is replaced when it is outside
   * the window, when the leg's anchor date moved and it is neither on the new
   * anchor day nor on a day of a genuinely new alternative, or when an
   * explicit remove/supersede op names it; otherwise
   * it is kept (no implicit delete). New alternatives next to kept in-window
   * ones on an unmoved anchor are ambiguous (replacement vs addition).
   */
  const reconcileFlightLeg = (
    role: 'flight_outbound' | 'flight_return',
    cur: OptView[],
    propAll: OptView[],
    anchorMoved: boolean,
    anchor: string,
  ) => {
    const matched = new Set<string>()
    const prop: OptView[] = []
    for (const p of propAll) {
      if (classifyWindow(p, window) !== 'OUT_OF_WINDOW') {
        prop.push(p)
        continue
      }
      if (currentById.has(p.externalId)) {
        matched.add(p.externalId)
        pushRemove(
          p.externalId,
          role,
          `proposed ${role} alternative outside window ${window.startDate}→${window.endDate}`,
        )
      } else {
        warnings.push(
          `proposed ${role} ${p.externalId} is outside window ${window.startDate}→${window.endDate} — dropped`,
        )
      }
    }
    const added: OptView[] = []
    for (const p of prop) {
      const sameId = cur.find((c) => c.externalId === p.externalId)
      if (sameId) {
        if (flightDayMove(sameId, p) === 'unsupported') continue
        matched.add(sameId.externalId)
        pushSupersede(sameId, p, role, `${role} alternative update`)
        continue
      }
      const dup = cur.find(
        (c) => !matched.has(c.externalId) && sameScheduledFlight(c, p),
      )
      if (dup) {
        matched.add(dup.externalId)
        keepProposedIds.add(dup.externalId)
        preserveTemporalIds.add(dup.externalId)
        warnings.push(
          `${p.externalId} repeats current ${role} ${dup.externalId} — keeping ${dup.externalId}`,
        )
        matching.push({
          role,
          action: 'keep_alt',
          from: p.externalId,
          to: dup.externalId,
          reason: 'proposed alternative is the same scheduled flight',
        })
        continue
      }
      added.push(p)
    }
    const coveredDays = new Set(
      [anchor, ...added.map((p) => datePrefix(p.startAt))].filter(Boolean),
    )
    const kept: OptView[] = []
    for (const c of cur) {
      if (matched.has(c.externalId)) continue
      const w = classifyWindow(c, window)
      const offNewSet =
        anchorMoved && prop.length > 0 && !coveredDays.has(datePrefix(c.startAt))
      if (w === 'OUT_OF_WINDOW' || offNewSet || llmReplaceHint(c.externalId)) {
        pushRemove(
          c.externalId,
          role,
          offNewSet
            ? `date-shift: ${role} alternatives replaced as a set`
            : w === 'OUT_OF_WINDOW'
              ? `obsolete ${role} alternative outside the window`
              : `llm remove/supersede op: obsolete ${role} alternative`,
        )
        continue
      }
      kept.push(c)
    }
    const keptInWindow = kept.filter(
      (c) => classifyWindow(c, window) === 'IN_WINDOW',
    )
    if (!anchorMoved && added.length && keptInWindow.length) {
      conflicts.push(
        `ambiguous ${role}: new ${added.map((p) => p.externalId).join(', ')} next to current ${keptInWindow.map((c) => c.externalId).join(', ')} — replacement or additional alternative?`,
      )
      return
    }
    for (const p of added) {
      pushAdd(
        p.externalId,
        role,
        anchorMoved ? `date-shift: new ${role} alternative` : `new ${role} alternative`,
      )
    }
    for (const c of kept) {
      keepProposedIds.add(c.externalId)
      preserveTemporalIds.add(c.externalId)
      matching.push({
        role,
        action: 'keep_alt',
        to: c.externalId,
        reason: `${role} alternative still valid — kept`,
      })
    }
  }

  const warnLegOffAnchor = (
    role: 'flight_outbound' | 'flight_return',
    cur: OptView[],
    anchorMoved: boolean,
    anchor: string,
  ) => {
    if (!anchorMoved) return
    const off = cur.filter((c) => {
      const d = datePrefix(c.startAt)
      return d && d !== anchor
    })
    if (!off.length) return
    warnings.push(
      `${role} ${off.map((c) => c.externalId).join(', ')} not on new date ${anchor} — kept because the proposal has no replacement (no implicit delete)`,
    )
  }

  // --- Flights outbound (window-aware) ---
  {
    const curAll = matchableCurrent(curRoles.get('flight_outbound') ?? [])
    const prop = propRoles.get('flight_outbound') ?? []
    const pick = pickWindowAwarePrimary(curAll, window, 'flight_outbound', {
      allowOutOfWindowPrimary: shift,
    })
    const anchorMoved = currentTrip.startDate !== proposedTrip.startDate

    if (prop.length > 1 || (prop.length === 1 && pick.status === 'ambiguous')) {
      reconcileFlightLeg(
        'flight_outbound',
        curAll,
        prop,
        anchorMoved,
        proposedTrip.startDate,
      )
    } else if (prop.length === 1 && pick.status === 'ok') {
      const c = pick.primary
      const p = prop[0]!
      if (flightDayMove(c, p) === 'unsupported') {
        settleIgnoredFlightRewrite(c, 'flight_outbound', anchorMoved, proposedTrip.startDate)
      } else if (isProtectedTravelOption(c) && c.externalId !== p.externalId) {
        conflicts.push(`cannot supersede protected outbound ${c.externalId}`)
      } else if (shift || c.externalId !== p.externalId) {
        pushSupersede(
          c,
          p,
          'flight_outbound',
          shift
            ? 'date-shift: window-aware outbound replacement'
            : 'window-aware outbound replacement',
        )
      } else {
        pushUpdate(
          p.externalId,
          'flight_outbound',
          'outbound IN_WINDOW unchanged id — preserve fields',
        )
        preserveTemporalIds.add(p.externalId)
      }
      absorbObsolete(pick.obsolete, 'flight_outbound', true)
    } else if (prop.length === 1 && pick.status === 'empty') {
      pushAdd(prop[0]!.externalId, 'flight_outbound', 'new outbound flight')
    } else if (prop.length === 0 && curAll.length > 0) {
      warnings.push(
        'proposed package has no outbound flight — leaving current outbound (no implicit delete)',
      )
      warnLegOffAnchor('flight_outbound', curAll, anchorMoved, proposedTrip.startDate)
      if (pick.status === 'ok') {
        keepProposedIds.add(pick.primary.externalId)
        preserveTemporalIds.add(pick.primary.externalId)
      }
    }
  }

  // --- Flights return (window-aware) ---
  {
    const curAll = matchableCurrent(curRoles.get('flight_return') ?? [])
    const propAll = propRoles.get('flight_return') ?? []
    const curPick = pickWindowAwarePrimary(curAll, window, 'flight_return', {
      allowOutOfWindowPrimary: shift,
    })
    const propPick = pickWindowAwarePrimary(propAll, window, 'flight_return', {
      allowOutOfWindowPrimary: false,
    })
    const anchorMoved = currentTrip.endDate !== proposedTrip.endDate

    if (
      propAll.length > 1 ||
      (propAll.length === 1 && curPick.status === 'ambiguous')
    ) {
      reconcileFlightLeg(
        'flight_return',
        curAll,
        propAll,
        anchorMoved,
        proposedTrip.endDate,
      )
    } else if (
      !conflicts.some((c) => /flight_return/.test(c)) &&
      propPick.status === 'ok' &&
      curPick.status === 'ok'
    ) {
      const curPrimary = curPick.primary
      const propPrimary = propPick.primary
      if (flightDayMove(curPrimary, propPrimary) === 'unsupported') {
        settleIgnoredFlightRewrite(curPrimary, 'flight_return', anchorMoved, proposedTrip.endDate)
      } else if (
        isProtectedTravelOption(curPrimary) &&
        curPrimary.externalId !== propPrimary.externalId
      ) {
        conflicts.push(
          `cannot supersede protected return ${curPrimary.externalId}`,
        )
      } else if (shift || curPrimary.externalId !== propPrimary.externalId) {
        pushSupersede(
          curPrimary,
          propPrimary,
          'flight_return',
          shift
            ? 'date-shift: window-aware return replacement'
            : 'window-aware return replacement',
        )
      } else {
        pushUpdate(
          propPrimary.externalId,
          'flight_return',
          'return IN_WINDOW unchanged id — preserve fields',
        )
        preserveTemporalIds.add(propPrimary.externalId)
      }
      absorbObsolete(curPick.obsolete, 'flight_return', true)
      for (const alt of curAll) {
        if (alt.externalId === curPrimary.externalId) continue
        if (removeCurrentIds.has(alt.externalId)) continue
        const propAlt = proposedById.get(alt.externalId)
        const altWindow = classifyWindow(propAlt ?? alt, window)
        if (propAlt && altWindow === 'IN_WINDOW') {
          if (alt.externalId !== propPrimary.externalId) {
            keepProposedIds.add(alt.externalId)
            matching.push({
              role: 'flight_return',
              action: 'keep_alt',
              to: alt.externalId,
              reason: 'return alternative still IN_WINDOW in proposal',
            })
          }
          continue
        }
        // Not in proposal, or proposed with OUT_OF_WINDOW / UNKNOWN dates
        if (
          altWindow === 'OUT_OF_WINDOW' ||
          llmRemoveHint(alt.externalId) ||
          (shift && !propAlt)
        ) {
          pushRemove(
            alt.externalId,
            'flight_return',
            llmRemoveHint(alt.externalId)
              ? 'llm remove hint: obsolete return'
              : 'out-of-window return vs IN_WINDOW/shift winner',
          )
        } else if (!propAlt) {
          warnings.push(
            `return alternative ${alt.externalId} not in proposal — not auto-removed (no implicit delete)`,
          )
        }
      }
    } else if (
      !conflicts.some((c) => /flight_return/.test(c)) &&
      propPick.status === 'ok' &&
      curPick.status === 'empty'
    ) {
      pushAdd(propPick.primary.externalId, 'flight_return', 'new return flight')
    } else if (
      !conflicts.some((c) => /flight_return/.test(c)) &&
      propPick.status === 'empty' &&
      curAll.length > 0
    ) {
      warnings.push(
        'proposed package has no return flight — leaving current returns (no implicit delete)',
      )
      warnLegOffAnchor('flight_return', curAll, anchorMoved, proposedTrip.endDate)
      if (curPick.status === 'ok') {
        keepProposedIds.add(curPick.primary.externalId)
        preserveTemporalIds.add(curPick.primary.externalId)
      }
    }
  }

  // --- Lodging candidates (additive research) ---
  // A new lodging the model explicitly adds while no op replaces the current
  // lodging is a researched alternative: it is added next to the current
  // lodging instead of competing with it for lodging_primary.
  const lodgingRoles = ['lodging_primary', 'lodging_fallback'] as const
  const curCandidates = lodgingRoles
    .flatMap((r) => curRoles.get(r) ?? [])
    .filter(
      (o) =>
        isLodgingCandidateNote(o.notes) &&
        o.status === 'researched' &&
        !isProtectedTravelOption(o),
    )
  const curCandidateIds = new Set(curCandidates.map((o) => o.externalId))
  const candidateIds = new Set<string>()
  {
    for (const r of lodgingRoles) {
      curRoles.set(
        r,
        (curRoles.get(r) ?? []).filter((o) => !curCandidateIds.has(o.externalId)),
      )
    }
    const curLodging = lodgingRoles.flatMap((r) =>
      matchableCurrent(curRoles.get(r) ?? []),
    )
    const explicitAdds = new Set(
      llmOps
        .filter((op) => op.op === 'add' && op.entityKind === 'travelOption')
        .map((op) => op.externalId),
    )
    const replacesCurrent = curLodging.some((c) => llmReplaceHint(c.externalId))
    const dropped = new Set<string>()
    if (curLodging.length > 0 && !replacesCurrent) {
      const currentTitles = new Set(curLodging.map((o) => normText(o.title).trim()))
      const candidateTitles = new Set(
        curCandidates.map((o) => normText(o.title).trim()),
      )
      for (const r of lodgingRoles) {
        for (const p of propRoles.get(r) ?? []) {
          if (!explicitAdds.has(p.externalId) || currentById.has(p.externalId)) continue
          if (p.logicalRole || p.verificationStatus === 'verified') continue
          if (isProtectedTravelOption(p)) continue
          const key = normText(p.title).trim()
          if (!key || currentTitles.has(key)) continue
          if (candidateTitles.has(key)) {
            dropped.add(p.externalId)
            warnings.push(
              `lodging candidate ${p.externalId} repeats "${p.title}" — not added twice`,
            )
            continue
          }
          candidateTitles.add(key)
          candidateIds.add(p.externalId)
        }
      }
    }
    for (const r of lodgingRoles) {
      propRoles.set(
        r,
        (propRoles.get(r) ?? []).filter(
          (p) =>
            !candidateIds.has(p.externalId) &&
            !dropped.has(p.externalId) &&
            !curCandidateIds.has(p.externalId),
        ),
      )
    }
  }

  // --- Lodging primary (window-aware) ---
  {
    const curAll = matchableCurrent(curRoles.get('lodging_primary') ?? [])
    let prop = [...(propRoles.get('lodging_primary') ?? [])]
    const curPick = pickWindowAwarePrimary(curAll, window, 'lodging_primary', {
      allowOutOfWindowPrimary: shift,
    })

    if (prop.length > 1) {
      const byFp = new Map<string, OptView>()
      for (const p of prop) {
        const fp = lodgingFingerprint(p)
        if (!byFp.has(fp)) byFp.set(fp, p)
        else {
          warnings.push(
            `collapsed duplicate lodging_primary fingerprint → keep ${byFp.get(fp)!.externalId}, drop ${p.externalId}`,
          )
        }
      }
      prop = [...byFp.values()]
    }

    if (prop.length > 1) {
      conflicts.push(
        `ambiguous lodging_primary in proposal: ${prop.map((p) => p.externalId).join(', ')} — need distinct logicalRole or single primary`,
      )
    } else if (curPick.status === 'ambiguous' && prop.length === 1) {
      conflicts.push(curPick.reason)
    } else if (prop.length === 1 && curPick.status === 'ok') {
      const c = curPick.primary
      const p = prop[0]!
      if (isProtectedTravelOption(c) && c.externalId !== p.externalId) {
        conflicts.push(`cannot supersede protected lodging ${c.externalId}`)
      } else {
        pushSupersede(
          c,
          p,
          'lodging_primary',
          shift
            ? 'date-shift: primary lodging replacement/update'
            : 'primary lodging replacement/update',
        )
        if (c.externalId === p.externalId && !shift) {
          preserveTemporalIds.add(p.externalId)
        }
      }
      absorbObsolete(curPick.obsolete, 'lodging_primary', true)
    } else if (prop.length === 1 && curPick.status === 'empty') {
      pushAdd(prop[0]!.externalId, 'lodging_primary', 'new primary lodging')
    } else if (prop.length === 0 && curAll.length > 0) {
      for (const c of curAll) {
        warnings.push(
          `no primary lodging in proposal — preserving current ${c.externalId}`,
        )
        keepProposedIds.add(c.externalId)
        preserveTemporalIds.add(c.externalId)
      }
    }
  }

  // --- Lodging fallback ---
  {
    const curAll = matchableCurrent(curRoles.get('lodging_fallback') ?? [])
    let prop = [...(propRoles.get('lodging_fallback') ?? [])]
    const curPick = pickWindowAwarePrimary(curAll, window, 'lodging_fallback', {
      allowOutOfWindowPrimary: shift,
    })

    if (prop.length > 1) {
      const byFp = new Map<string, OptView>()
      for (const p of prop) {
        const fp = lodgingFingerprint(p)
        if (!byFp.has(fp)) byFp.set(fp, p)
      }
      prop = [...byFp.values()]
    }
    if (prop.length > 1) {
      conflicts.push(
        `ambiguous lodging_fallback: ${prop.map((p) => p.externalId).join(', ')}`,
      )
    } else if (curPick.status === 'ambiguous' && prop.length === 1) {
      conflicts.push(curPick.reason)
    } else if (prop.length === 1 && curPick.status === 'ok') {
      if (
        isProtectedTravelOption(curPick.primary) &&
        curPick.primary.externalId !== prop[0]!.externalId
      ) {
        conflicts.push(
          `cannot supersede protected fallback ${curPick.primary.externalId}`,
        )
      } else {
        pushSupersede(
          curPick.primary,
          prop[0]!,
          'lodging_fallback',
          'fallback lodging replacement/update',
        )
        if (curPick.primary.externalId === prop[0]!.externalId) {
          preserveTemporalIds.add(prop[0]!.externalId)
        }
      }
      absorbObsolete(curPick.obsolete, 'lodging_fallback', true)
    } else if (prop.length === 1 && curPick.status === 'empty') {
      pushAdd(prop[0]!.externalId, 'lodging_fallback', 'add lodging fallback')
    } else if (prop.length === 0 && curAll.length > 0) {
      warnings.push(
        `no fallback lodging in proposal — preserving current fallback(s)`,
      )
      for (const c of curAll) {
        keepProposedIds.add(c.externalId)
        preserveTemporalIds.add(c.externalId)
      }
    }
  }

  for (const id of candidateIds) {
    pushAdd(
      id,
      'lodging_candidate',
      'researched lodging candidate — current lodging kept',
    )
  }
  for (const c of curCandidates) {
    const p = proposedById.get(c.externalId)
    if (p) {
      pushSupersede(c, p, 'lodging_candidate', 'lodging candidate update')
    } else if (!llmRemoveHint(c.externalId)) {
      keepProposedIds.add(c.externalId)
      preserveTemporalIds.add(c.externalId)
    }
  }

  // --- Ground transfer ---
  {
    const cur = matchableCurrent(curRoles.get('ground_transfer') ?? [])
    const prop = propRoles.get('ground_transfer') ?? []
    if (prop.length > 1) {
      conflicts.push(
        `ambiguous ground_transfer in proposal: ${prop.map((p) => p.externalId).join(', ')}`,
      )
    } else if (prop.length === 1 && cur.length === 1) {
      if (
        isProtectedTravelOption(cur[0]!) &&
        cur[0]!.externalId !== prop[0]!.externalId
      ) {
        conflicts.push(`cannot supersede protected transfer ${cur[0]!.externalId}`)
      } else {
        pushSupersede(
          cur[0]!,
          prop[0]!,
          'ground_transfer',
          'ground transfer update/preserve',
        )
        if (cur[0]!.externalId === prop[0]!.externalId) {
          preserveTemporalIds.add(prop[0]!.externalId)
        }
      }
    } else if (prop.length === 1 && cur.length === 0) {
      pushAdd(prop[0]!.externalId, 'ground_transfer', 'new ground transfer')
    } else if (prop.length === 0 && cur.length === 1) {
      warnings.push(
        `ground transfer ${cur[0]!.externalId} omitted from proposal — preserving (no implicit delete)`,
      )
      keepProposedIds.add(cur[0]!.externalId)
      preserveTemporalIds.add(cur[0]!.externalId)
    } else if (prop.length === 0 && cur.length > 1) {
      warnings.push(
        'multiple ground transfers omitted from proposal — preserving all (no implicit delete)',
      )
      for (const c of cur) {
        keepProposedIds.add(c.externalId)
        preserveTemporalIds.add(c.externalId)
      }
    }
  }

  // Absorb remaining validated llm remove hints (OUT_OF_WINDOW / not proposed)
  for (const hint of llmOps) {
    if (hint.op !== 'remove' || hint.entityKind !== 'travelOption') continue
    if (removeCurrentIds.has(hint.externalId)) continue
    const cur = currentById.get(hint.externalId)
    if (!cur) continue
    if (keepProposedIds.has(hint.externalId)) continue
    if (proposedById.has(hint.externalId)) continue
    const role = inferLogicalRole(cur, currentTrip)
    const w = classifyWindow(cur, window)
    if (w === 'IN_WINDOW') {
      warnings.push(
        `llm remove hint ignored for IN_WINDOW ${hint.externalId} (no auto-delete of vigente)`,
      )
      continue
    }
    // Protected → conflict via pushRemove; research statuses otherwise
    if (
      !isProtectedTravelOption(cur) &&
      !isResearchStatus(cur.status)
    ) {
      continue
    }
    pushRemove(
      hint.externalId,
      role,
      'llm remove hint validated for obsolete option',
    )
  }

  // An update op names a current option but the package carries no values for
  // it. Without a window shift nothing derives the change → review. With a
  // shift, window-dependent dates are realigned below.
  const payloadlessUpdates = new Set<string>()
  for (const hint of llmOps) {
    if (hint.op !== 'update' || hint.entityKind !== 'travelOption') continue
    if (!currentById.has(hint.externalId) || proposedById.has(hint.externalId)) continue
    if (removeCurrentIds.has(hint.externalId)) continue
    if (!shift) {
      conflicts.push(
        `update op for ${hint.externalId} has no package entry — the intended change cannot be derived (review)`,
      )
    } else {
      payloadlessUpdates.add(hint.externalId)
    }
  }

  if (conflicts.length) {
    return {
      status: 'review_required',
      ops: [],
      package: proposedPackage,
      warnings,
      conflicts,
      matching,
    }
  }

  // Normalize package: winners + field preservation from current
  const normalizedOptions: PackageTravelOption[] = []
  const seen = new Set<string>()

  const pushPkgOpt = (o: PackageTravelOption) => {
    if (seen.has(o.externalId)) return
    normalizedOptions.push(o)
    seen.add(o.externalId)
  }

  for (const id of keepProposedIds) {
    const fromProp = proposedPackage.travelOptions.find(
      (o) => o.externalId === id,
    )
    const cur = currentOptions.find(
      (o) => o.tripId === tripId && (o.externalId ?? o.id) === id,
    )
    if (cur && ignoredFlightRewriteIds.has(id)) {
      pushPkgOpt(currentToPackageOption(cur))
      continue
    }
    if (fromProp && cur) {
      if (rescheduledFlightIds.has(id)) {
        const merged = mergePreservedPackageOption(cur, fromProp, {
          allowTemporalReplace: true,
          changedFields: RESCHEDULED_FLIGHT_FIELDS,
        })
        const hintDay = merged.notes?.match(DATE_HINT_RE)?.[2]
        pushPkgOpt({
          ...merged,
          title:
            buildFlightScheduleTitle(merged) ??
            (cleanProposedText(fromProp.title)?.trim() || merged.title),
          notes:
            hintDay && hintDay !== datePrefix(merged.startAt)
              ? merged.notes!.replace(DATE_HINT_RE, '').replace(/\s+/g, ' ').trim() || undefined
              : merged.notes,
        })
        continue
      }
      pushPkgOpt(
        mergePreservedPackageOption(cur, fromProp, {
          allowTemporalReplace: !preserveTemporalIds.has(id) && shift,
          targetTripWindow: shift
            ? { startDate: window.startDate, endDate: window.endDate }
            : undefined,
          // Ask Travel package apply has no per-field mask today; preserve-by-default.
        }),
      )
      continue
    }
    if (fromProp) {
      pushPkgOpt(scrubNewPackageOption(fromProp))
      continue
    }
    if (cur) {
      pushPkgOpt(currentToPackageOption(cur))
    }
  }

  for (const o of proposedPackage.travelOptions) {
    if (seen.has(o.externalId)) continue
    const role = inferProposedRole(toView(o, o.externalId), proposedTrip, legs)
    if (role === 'other') pushPkgOpt(scrubNewPackageOption(o))
  }

  for (let i = 0; i < normalizedOptions.length; i++) {
    const o = normalizedOptions[i]!
    const srcDay = sourceUrlDay(o.sourceUrl)
    const day = datePrefix(o.startAt)
    if (o.type !== 'flight' || !srcDay || !day || srcDay === day) continue
    warnings.push(
      `${o.externalId} departs ${day} but its source is for ${srcDay} — provenance dropped, not a published schedule for ${day}`,
    )
    normalizedOptions[i] = {
      ...o,
      sourceType: 'agent',
      sourceUrl: undefined,
      checkedAt: undefined,
      verificationStatus: 'unverified',
    }
  }

  for (let i = 0; i < normalizedOptions.length; i++) {
    const o = normalizedOptions[i]!
    if (!candidateIds.has(o.externalId) && !curCandidateIds.has(o.externalId)) continue
    if (isLodgingCandidateNote(o.notes)) continue
    normalizedOptions[i] = {
      ...o,
      notes: o.notes ? `${o.notes}\n${LODGING_CANDIDATE_NOTE}` : LODGING_CANDIDATE_NOTE,
    }
  }

  // Window-dependent components kept from the current trip must follow an
  // explicit window shift (or block Apply) — never stay silently on old dates.
  if (shift) {
    for (let i = 0; i < normalizedOptions.length; i++) {
      const o = normalizedOptions[i]!
      const cur = currentById.get(o.externalId)
      if (!cur || curCandidateIds.has(o.externalId)) continue
      const role = inferLogicalRole(cur, currentTrip)
      if (
        role !== 'lodging_primary' &&
        role !== 'lodging_fallback' &&
        role !== 'ground_transfer'
      ) {
        continue
      }
      const fit = fitToShiftedWindow(
        { ...o, status: cur.status, bookingId: cur.bookingId },
        role,
        currentTrip,
        window,
      )
      if (fit.kind === 'conflict') {
        conflicts.push(fit.reason)
        continue
      }
      if (fit.kind === 'keep') {
        if (payloadlessUpdates.has(o.externalId)) {
          warnings.push(
            `update op for ${o.externalId} has no package entry — no window-dependent date to move; kept as is`,
          )
        }
        continue
      }
      const next = { ...o, ...fit.patch }
      if (o.type === 'lodging') {
        next.title = syncLodgingNightsInTitle(next.title, next.startAt, next.endAt)
      }
      normalizedOptions[i] = next
      if (!ops.some((op) => op.externalId === o.externalId && op.op !== 'remove')) {
        ops.push({
          op: 'update',
          entityKind: 'travelOption',
          externalId: o.externalId,
          note: fit.reason,
        })
      }
      matching.push({ role, action: 'realign', to: o.externalId, reason: fit.reason })
    }
    for (const id of payloadlessUpdates) {
      if (!seen.has(id)) {
        warnings.push(
          `update op for ${id} has no package entry and is not window-dependent — kept as is`,
        )
      }
    }
    if (conflicts.length) {
      return {
        status: 'review_required',
        ops: [],
        package: proposedPackage,
        warnings,
        conflicts,
        matching,
      }
    }
  }

  const canonicalOps = canonicalOpOrder(ops)

  const normalizedPkg: TripPackageV1 = {
    ...proposedPackage,
    travelOptions: normalizedOptions,
  }

  try {
    validateMutationOps({
      pkg: normalizedPkg,
      tripId,
      ops: canonicalOps,
      existingOptions: currentOptions,
    })
  } catch (e) {
    if (
      e instanceof PackageMutationConflictError ||
      e instanceof PackageMutationValidationError
    ) {
      return {
        status: 'review_required',
        ops: [],
        package: proposedPackage,
        warnings,
        conflicts: [
          ...conflicts,
          e instanceof PackageMutationConflictError
            ? e.conflicts.join('; ')
            : e.details.join('; '),
        ],
        matching,
      }
    }
    throw e
  }

  return {
    status: 'ok',
    ops: canonicalOps,
    package: normalizedPkg,
    warnings,
    conflicts: [],
    matching,
  }
}
