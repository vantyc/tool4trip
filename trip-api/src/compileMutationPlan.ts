import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import { extractIataCode } from './airportArrivalPolicy.ts'
import {
  isProtectedTravelOption,
  PackageMutationConflictError,
  PackageMutationValidationError,
  validateMutationOps,
} from './packageMutation.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
import type { PackageTravelOption, TripPackageV1 } from './tripPackage.ts'

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

export type CompiledMutationPlan = {
  status: 'ok' | 'review_required'
  /** Canonical ops for Apply (validated, deduped, ordered) */
  ops: AgentOpRecord[]
  /** Package normalized for upsert (deduped winners per role) */
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
  bookingId?: string | null
  logicalRole?: LogicalRole | string
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
  const r = o as PackageTravelOption & TravelOption & { logicalRole?: string }
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
    bookingId: 'bookingId' in r ? r.bookingId : undefined,
    logicalRole: r.logicalRole,
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
    // destination trip city default → primary
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
    // Route heuristic for CDMX↔GDL trips
    if (ori === 'MEX' && (dest === 'GDL' || dest === 'BJX')) return 'flight_outbound'
    if ((ori === 'GDL' || ori === 'BJX') && dest === 'MEX') return 'flight_return'
    // Date-in-window heuristic
    if (day && day === trip.startDate) return 'flight_outbound'
    if (day && day === trip.endDate) return 'flight_return'
    // Near start vs near end
    if (day && trip.startDate && trip.endDate) {
      if (day <= trip.startDate) return 'flight_outbound'
      if (day >= trip.endDate) return 'flight_return'
      // mid-window return alternatives
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

function preferReturnPrimary(opts: OptView[]): OptView | undefined {
  if (!opts.length) return undefined
  const shortlisted = opts.filter((o) => o.status === 'shortlisted')
  if (shortlisted.length === 1) return shortlisted[0]
  // latest startAt among returns = preferred return day
  const sorted = [...opts].sort((a, b) =>
    datePrefix(b.startAt).localeCompare(datePrefix(a.startAt)),
  )
  return sorted[0]
}

function returnAlternatives(opts: OptView[], primary?: OptView): OptView[] {
  if (!primary) return opts.filter((o) => o.status === 'researched')
  return opts.filter((o) => o.externalId !== primary.externalId)
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
  // dedupe identical
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
    llmOps = [],
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

  const shift = datesShifted(currentTrip, proposedTrip)

  const currentViews = currentOptions
    .filter((o) => o.tripId === tripId)
    .map((o) => toView(o, o.externalId ?? o.id))
  const proposedViews = proposedPackage.travelOptions.map((o) =>
    toView(o, o.externalId),
  )

  const curRoles = groupByRole(currentViews, currentTrip)
  const propRoles = groupByRole(proposedViews, proposedTrip)

  const proposedById = new Map(proposedViews.map((o) => [o.externalId, o]))
  const currentById = new Map(currentViews.map((o) => [o.externalId, o]))

  // Track which proposed externalIds are winners (kept in normalized package)
  const keepProposedIds = new Set<string>()
  // Current ids removed via supersede/remove
  const removeCurrentIds = new Set<string>()

  const pushSupersede = (from: OptView, to: OptView, role: LogicalRole, reason: string) => {
    if (from.externalId === to.externalId) {
      ops.push({
        op: 'update',
        entityKind: 'travelOption',
        externalId: to.externalId,
        note: reason,
      })
      keepProposedIds.add(to.externalId)
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
    ops.push({
      op: 'remove',
      entityKind: 'travelOption',
      externalId: id,
      note: reason,
    })
    removeCurrentIds.add(id)
    matching.push({ role, action: 'remove', from: id, reason })
  }

  // --- Flights outbound ---
  {
    const cur = matchableCurrent(curRoles.get('flight_outbound') ?? [])
    const prop = propRoles.get('flight_outbound') ?? []
    if (prop.length > 1) {
      conflicts.push(
        `ambiguous flight_outbound in proposal: ${prop.map((p) => p.externalId).join(', ')}`,
      )
    } else if (prop.length === 1 && cur.length === 1) {
      const c = cur[0]!
      const p = prop[0]!
      if (isProtectedTravelOption(c)) {
        conflicts.push(`cannot supersede protected outbound ${c.externalId}`)
      } else if (shift || c.externalId !== p.externalId) {
        pushSupersede(
          c,
          p,
          'flight_outbound',
          shift
            ? 'date-shift: unique outbound flight replacement'
            : 'unique outbound flight replacement',
        )
      } else {
        pushUpdate(p.externalId, 'flight_outbound', 'outbound unchanged id')
      }
    } else if (prop.length === 1 && cur.length === 0) {
      pushAdd(prop[0]!.externalId, 'flight_outbound', 'new outbound flight')
    } else if (prop.length === 1 && cur.length > 1) {
      conflicts.push(
        `ambiguous current flight_outbound: ${cur.map((c) => c.externalId).join(', ')}`,
      )
    } else if (prop.length === 0 && cur.length > 0) {
      warnings.push(
        'proposed package has no outbound flight — leaving current outbound (no implicit delete)',
      )
    }
  }

  // --- Flights return (preferred + alternatives) ---
  {
    const curAll = matchableCurrent(curRoles.get('flight_return') ?? [])
    const propAll = propRoles.get('flight_return') ?? []
    const curPrimary = preferReturnPrimary(curAll)
    const curAlts = returnAlternatives(curAll, curPrimary)

    const propInWindow = propAll.filter((p) => {
      const d = datePrefix(p.startAt)
      return (
        Boolean(d) &&
        d >= proposedTrip.startDate &&
        d <= proposedTrip.endDate
      )
    })
    const propPrimary = preferReturnPrimary(
      propInWindow.length ? propInWindow : propAll.filter((p) => {
        const d = datePrefix(p.startAt)
        return !d || (d >= proposedTrip.startDate && d <= proposedTrip.endDate)
      }),
    )

    // Ambiguous only if ≥2 in-window returns without a single shortlisted winner
    if (propInWindow.length > 1) {
      const shortlisted = propInWindow.filter((p) => p.status === 'shortlisted')
      if (shortlisted.length !== 1) {
        conflicts.push(
          `ambiguous flight_return in proposal: ${propInWindow.map((p) => p.externalId).join(', ')}`,
        )
      }
    }

    if (
      !conflicts.some((c) => /flight_return/.test(c)) &&
      propPrimary &&
      curPrimary
    ) {
      if (isProtectedTravelOption(curPrimary)) {
        conflicts.push(
          `cannot supersede protected return ${curPrimary.externalId}`,
        )
      } else {
        pushSupersede(
          curPrimary,
          propPrimary,
          'flight_return',
          shift
            ? 'date-shift: unique preferred return replacement'
            : 'unique preferred return replacement',
        )
        if (shift) {
          for (const alt of curAlts) {
            const propAlt = proposedById.get(alt.externalId)
            const altDay = datePrefix(propAlt?.startAt ?? alt.startAt)
            const inNewWindow =
              Boolean(altDay) &&
              altDay >= proposedTrip.startDate &&
              altDay <= proposedTrip.endDate
            const llmRemove = llmOps.some(
              (op) =>
                op.op === 'remove' &&
                op.entityKind === 'travelOption' &&
                op.externalId === alt.externalId,
            )
            if (!inNewWindow) {
              pushRemove(
                alt.externalId,
                'flight_return',
                'date-shift: return alternative outside new trip window',
              )
              continue
            }
            if (!propAlt && llmRemove) {
              pushRemove(
                alt.externalId,
                'flight_return',
                'llm remove hint validated: obsolete return alternative',
              )
              continue
            }
            if (!propAlt) {
              warnings.push(
                `return alternative ${alt.externalId} still in new window and not in proposal — not auto-removed (no implicit delete)`,
              )
            } else if (propAlt.externalId !== propPrimary.externalId) {
              keepProposedIds.add(alt.externalId)
              matching.push({
                role: 'flight_return',
                action: 'keep_alt',
                to: alt.externalId,
                reason: 'return alternative still in new window',
              })
            }
          }
        }
      }
    } else if (
      !conflicts.some((c) => /flight_return/.test(c)) &&
      propPrimary &&
      !curPrimary
    ) {
      pushAdd(propPrimary.externalId, 'flight_return', 'new return flight')
    } else if (
      !conflicts.some((c) => /flight_return/.test(c)) &&
      !propPrimary &&
      curAll.length > 0
    ) {
      warnings.push(
        'proposed package has no return flight — leaving current returns (no implicit delete)',
      )
    }
  }

  // --- Lodging primary ---
  {
    const cur = matchableCurrent(curRoles.get('lodging_primary') ?? [])
    let prop = [...(propRoles.get('lodging_primary') ?? [])]

    // Collapse identical fingerprints
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
    } else if (prop.length === 1 && cur.length === 1) {
      const c = cur[0]!
      const p = prop[0]!
      if (isProtectedTravelOption(c)) {
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
      }
    } else if (prop.length === 1 && cur.length === 0) {
      pushAdd(prop[0]!.externalId, 'lodging_primary', 'new primary lodging')
    } else if (prop.length === 1 && cur.length > 1) {
      conflicts.push(
        `ambiguous current lodging_primary: ${cur.map((c) => c.externalId).join(', ')}`,
      )
    } else if (prop.length === 0 && cur.length > 0) {
      for (const c of cur) {
        warnings.push(
          `no primary lodging in proposal — preserving current ${c.externalId}`,
        )
        keepProposedIds.add(c.externalId)
      }
    }
  }

  // --- Lodging fallback ---
  {
    const cur = matchableCurrent(curRoles.get('lodging_fallback') ?? [])
    let prop = [...(propRoles.get('lodging_fallback') ?? [])]
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
    } else if (prop.length === 1 && cur.length === 1) {
      if (isProtectedTravelOption(cur[0]!)) {
        conflicts.push(`cannot supersede protected fallback ${cur[0]!.externalId}`)
      } else {
        pushSupersede(
          cur[0]!,
          prop[0]!,
          'lodging_fallback',
          'fallback lodging replacement/update',
        )
      }
    } else if (prop.length === 1 && cur.length === 0) {
      pushAdd(prop[0]!.externalId, 'lodging_fallback', 'add lodging fallback')
    } else if (prop.length === 0 && cur.length > 0) {
      warnings.push(
        `no fallback lodging in proposal — preserving current fallback(s)`,
      )
      for (const c of cur) keepProposedIds.add(c.externalId)
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
      if (isProtectedTravelOption(cur[0]!)) {
        conflicts.push(`cannot supersede protected transfer ${cur[0]!.externalId}`)
      } else {
        pushSupersede(
          cur[0]!,
          prop[0]!,
          'ground_transfer',
          'ground transfer update/preserve',
        )
      }
    } else if (prop.length === 1 && cur.length === 0) {
      pushAdd(prop[0]!.externalId, 'ground_transfer', 'new ground transfer')
    } else if (prop.length === 0 && cur.length === 1) {
      warnings.push(
        `ground transfer ${cur[0]!.externalId} omitted from proposal — preserving (no implicit delete)`,
      )
      keepProposedIds.add(cur[0]!.externalId)
    } else if (prop.length === 0 && cur.length > 1) {
      warnings.push(
        'multiple ground transfers omitted from proposal — preserving all (no implicit delete)',
      )
      for (const c of cur) keepProposedIds.add(c.externalId)
    }
  }

  // Absorb validated llm remove hints for entities already marked OR explicit alt removes
  for (const hint of llmOps) {
    if (hint.op === 'noop') continue
    if (hint.op === 'remove' && hint.entityKind === 'travelOption') {
      if (removeCurrentIds.has(hint.externalId)) continue // already planned
      const cur = currentById.get(hint.externalId)
      if (!cur) continue
      if (!isResearchStatus(cur.status)) continue
      if (isProtectedTravelOption(cur)) continue
      if (keepProposedIds.has(hint.externalId)) continue
      if (proposedById.has(hint.externalId)) continue
      const role = inferLogicalRole(cur, currentTrip)
      if (role === 'flight_return' && shift) {
        pushRemove(
          hint.externalId,
          role,
          'llm remove hint validated for obsolete return alternative',
        )
      }
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

  const canonicalOps = canonicalOpOrder(ops)

  // Normalize package: role winners + preserved currents + unmanaged "other"
  const normalizedOptions: PackageTravelOption[] = []
  const seen = new Set<string>()

  const pushPkgOpt = (o: PackageTravelOption) => {
    if (seen.has(o.externalId)) return
    normalizedOptions.push(o)
    seen.add(o.externalId)
  }

  for (const id of keepProposedIds) {
    const fromProp = proposedPackage.travelOptions.find((o) => o.externalId === id)
    if (fromProp) {
      pushPkgOpt(fromProp)
      continue
    }
    const cur = currentOptions.find((o) => o.externalId === id)
    if (!cur) continue
    pushPkgOpt({
      externalId: id,
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
    })
  }

  // Preserve unmanaged proposed options (events, activities, etc.)
  for (const o of proposedPackage.travelOptions) {
    if (seen.has(o.externalId)) continue
    const role = inferLogicalRole(toView(o, o.externalId), proposedTrip)
    if (role === 'other') pushPkgOpt(o)
  }

  const normalizedPkg: TripPackageV1 = {
    ...proposedPackage,
    travelOptions: normalizedOptions,
  }

  // Final validate against existing (fail closed)
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
