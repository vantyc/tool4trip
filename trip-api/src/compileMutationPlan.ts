import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import { extractIataCode } from './airportArrivalPolicy.ts'
import {
  isProtectedTravelOption,
  PackageMutationConflictError,
  PackageMutationValidationError,
  validateMutationOps,
} from './packageMutation.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
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

function groupByRole(
  opts: OptView[],
  trip: { startDate: string; endDate: string; destination?: string },
): Map<LogicalRole, OptView[]> {
  const map = new Map<LogicalRole, OptView[]>()
  for (const o of opts) {
    const role = inferLogicalRole(o, trip)
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

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && !v.trim())
}

/** Proposed text with U+0000 is treated as degraded (prefer current). */
function preferText(
  proposed: string | undefined,
  current: string | undefined,
): string | undefined {
  if (proposed !== undefined && proposed.includes('\u0000')) {
    return current ?? proposed.replaceAll('\u0000', '')
  }
  if (!isBlank(proposed)) return proposed
  return current
}

function isPlaceholderTitle(title: string): boolean {
  return !title.trim() || PLACEHOLDER_TITLE.test(title.trim())
}

const WEAK_SOURCE: Record<string, number> = {
  agent: 1,
  other: 1,
  imported: 2,
  cursor: 2,
  manual: 3,
  flight_schedule: 4,
}

/**
 * Merge proposed fields onto a conserved current entity.
 * Degraded / missing proposal fields never wipe persisted identity, temporal,
 * or provenance data unless the proposal carries an explicit replacement.
 */
export function mergePreservedPackageOption(
  current: TravelOption,
  proposed: PackageTravelOption,
  opts?: { allowTemporalReplace?: boolean },
): PackageTravelOption {
  const allowTemporal = opts?.allowTemporalReplace ?? false
  const curStart = datePrefix(current.startAt)
  const propStart = datePrefix(proposed.startAt)
  const curEnd = datePrefix(current.endAt)
  const propEnd = datePrefix(proposed.endAt)

  const explicitTemporal =
    allowTemporal ||
    (Boolean(propStart) && Boolean(curStart) && propStart !== curStart) ||
    (Boolean(propEnd) && Boolean(curEnd) && propEnd !== curEnd) ||
    (Boolean(propStart) && !curStart) ||
    (Boolean(propEnd) && !curEnd)

  const title =
    (isPlaceholderTitle(proposed.title) || proposed.title.includes('\u0000')) &&
    !isPlaceholderTitle(current.title)
      ? current.title
      : proposed.title.trim()
        ? proposed.title.includes('\u0000')
          ? proposed.title.replaceAll('\u0000', '')
          : proposed.title
        : current.title

  const startAt = explicitTemporal
    ? proposed.startAt ?? current.startAt
    : current.startAt ?? proposed.startAt
  const endAt = explicitTemporal
    ? proposed.endAt ?? current.endAt
    : current.endAt ?? proposed.endAt

  const curSrcRank = WEAK_SOURCE[current.sourceType ?? ''] ?? 0
  const propSrcRank = WEAK_SOURCE[proposed.sourceType ?? ''] ?? 0
  const sourceType =
    propSrcRank >= curSrcRank && proposed.sourceType
      ? proposed.sourceType
      : ((current.sourceType as PackageTravelOption['sourceType']) ??
        proposed.sourceType ??
        'agent')

  const sourceUrl = preferText(proposed.sourceUrl, current.sourceUrl)
  const provider = preferText(proposed.provider, current.provider)
  const checkedAt = preferText(proposed.checkedAt, current.checkedAt)
  const verificationStatus =
    proposed.verificationStatus ?? current.verificationStatus

  const origin = preferText(proposed.origin, current.origin)
  const destination = preferText(proposed.destination, current.destination)
  const address = preferText(proposed.address, current.address)
  const phone = preferText(proposed.phone, current.phone)
  const description = preferText(proposed.description, current.description)
  const notes = preferText(proposed.notes, current.notes)

  const status =
    proposed.status === 'shortlisted' || proposed.status === 'researched'
      ? proposed.status
      : current.status === 'shortlisted' || current.status === 'researched'
        ? current.status
        : 'researched'

  return {
    externalId: proposed.externalId,
    type: proposed.type || (current.type as PackageTravelOption['type']),
    status,
    title,
    provider,
    description,
    startAt,
    endAt,
    origin,
    destination,
    address,
    phone,
    priceObserved: proposed.priceObserved ?? current.priceObserved,
    currency: (proposed.currency ??
      current.currency) as PackageTravelOption['currency'],
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
  const propRoles = groupByRole(proposedViews, proposedTrip)

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

  // --- Flights outbound (window-aware) ---
  {
    const curAll = matchableCurrent(curRoles.get('flight_outbound') ?? [])
    const prop = propRoles.get('flight_outbound') ?? []
    const pick = pickWindowAwarePrimary(curAll, window, 'flight_outbound', {
      allowOutOfWindowPrimary: shift,
    })

    if (prop.length > 1) {
      conflicts.push(
        `ambiguous flight_outbound in proposal: ${prop.map((p) => p.externalId).join(', ')}`,
      )
    } else if (pick.status === 'ambiguous') {
      conflicts.push(pick.reason)
    } else if (prop.length === 1 && pick.status === 'ok') {
      const c = pick.primary
      const p = prop[0]!
      if (isProtectedTravelOption(c) && c.externalId !== p.externalId) {
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

    if (propPick.status === 'ambiguous') {
      conflicts.push(propPick.reason)
    }

    if (
      !conflicts.some((c) => /flight_return/.test(c)) &&
      propPick.status === 'ok' &&
      curPick.status === 'ok'
    ) {
      const curPrimary = curPick.primary
      const propPrimary = propPick.primary
      if (
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
      if (curPick.status === 'ok') {
        keepProposedIds.add(curPick.primary.externalId)
        preserveTemporalIds.add(curPick.primary.externalId)
      }
    } else if (curPick.status === 'ambiguous') {
      conflicts.push(curPick.reason)
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

  const canonicalOps = canonicalOpOrder(ops)

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
    if (fromProp && cur) {
      pushPkgOpt(
        mergePreservedPackageOption(cur, fromProp, {
          allowTemporalReplace: !preserveTemporalIds.has(id) && shift,
        }),
      )
      continue
    }
    if (fromProp) {
      pushPkgOpt(fromProp)
      continue
    }
    if (cur) {
      pushPkgOpt(currentToPackageOption(cur))
    }
  }

  for (const o of proposedPackage.travelOptions) {
    if (seen.has(o.externalId)) continue
    const role = inferLogicalRole(toView(o, o.externalId), proposedTrip)
    if (role === 'other') pushPkgOpt(o)
  }

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
