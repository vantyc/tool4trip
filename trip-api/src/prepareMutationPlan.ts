/**
 * Shared pre-write mutation preparation used by compile-preview and Apply.
 * Deterministic, no DB writes.
 */
import { createHash } from 'node:crypto'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import {
  enrichTripPackageAirportArrivals,
} from './airportArrivalEnrich.ts'
import { compileMutationPlan } from './compileMutationPlan.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
import {
  PackageMutationValidationError,
  isProtectedTravelOption,
  validateMutationOps,
} from './packageMutation.ts'
import {
  sanitizeForPostgres,
  type PostgresSanitizeEvent,
} from './postgresSanitize.ts'
import {
  validateTripPackage,
  type PackageTravelOption,
  type TripPackageV1,
} from './tripPackage.ts'

export type CanonicalDiffKind = 'remove' | 'add' | 'update' | 'keep'

export type CanonicalDiffFieldChange = {
  field: string
  before: unknown
  after: unknown
}

export type CanonicalDiffLine = {
  kind: CanonicalDiffKind
  entityKind: 'travelOption' | 'trip'
  externalId: string
  fields?: CanonicalDiffFieldChange[]
  note?: string
}

export type PrepareMutationPlanInput = {
  tripId: string
  currentTrip: Trip | undefined
  currentOptions: TravelOption[]
  rawPackage: unknown
  llmOps: AgentOpRecord[]
  /** When true, log-style sanitize events are returned (caller may log). */
  collectSanitizeEvents?: boolean
}

export type PrepareMutationPlanResult = {
  status: 'ok' | 'review_required'
  conflicts: string[]
  warnings: string[]
  canonicalOps: AgentOpRecord[]
  normalizedPackage: TripPackageV1
  fingerprint: string
  planHash: string
  diff: CanonicalDiffLine[]
  sanitizeEvents: PostgresSanitizeEvent[]
  /** True when compiler ran (existing trip with options). */
  compiled: boolean
  matching: ReturnType<typeof compileMutationPlan>['matching']
}

const OPTION_COMPARE_FIELDS = [
  'title',
  'notes',
  'startAt',
  'endAt',
  'origin',
  'destination',
  'provider',
  'sourceType',
  'sourceUrl',
  'checkedAt',
  'verificationStatus',
  'status',
  'description',
  'address',
  'phone',
  'type',
] as const

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

function optionFingerprintSlice(o: TravelOption): Record<string, unknown> {
  return {
    externalId: o.externalId ?? o.id,
    type: o.type,
    status: o.status,
    title: o.title,
    notes: o.notes ?? null,
    startAt: o.startAt ?? null,
    endAt: o.endAt ?? null,
    origin: o.origin ?? null,
    destination: o.destination ?? null,
    sourceType: o.sourceType ?? null,
    sourceUrl: o.sourceUrl ?? null,
    provider: o.provider ?? null,
    checkedAt: o.checkedAt ?? null,
    verificationStatus: o.verificationStatus ?? null,
    bookingId: o.bookingId ?? null,
    updatedAt: o.updatedAt,
    protected: isProtectedTravelOption(o),
  }
}

/**
 * Deterministic fingerprint of current trip + travelOptions.
 * Includes entity updatedAt so lodge/transfer-only PUTs invalidate preview.
 */
export function computeStateFingerprint(
  trip: Trip | undefined,
  options: TravelOption[],
): string {
  const tripSlice = trip
    ? {
        id: trip.id,
        startDate: trip.startDate,
        endDate: trip.endDate,
        title: trip.title,
        destination: trip.destination ?? null,
        timezone: trip.timezone,
        updatedAt: trip.updatedAt,
      }
    : null

  const opts = [...options]
    .map(optionFingerprintSlice)
    .sort((a, b) =>
      String(a.externalId).localeCompare(String(b.externalId)),
    )

  return sha256Hex(stableStringify({ trip: tripSlice, travelOptions: opts }))
}

function packagePlanSlice(pkg: TripPackageV1): unknown {
  const sortOpts = (list: PackageTravelOption[]) =>
    [...list]
      .map((o) => ({
        externalId: o.externalId,
        type: o.type,
        status: o.status,
        title: o.title,
        notes: o.notes ?? null,
        startAt: o.startAt ?? null,
        endAt: o.endAt ?? null,
        origin: o.origin ?? null,
        destination: o.destination ?? null,
        sourceType: o.sourceType ?? null,
        sourceUrl: o.sourceUrl ?? null,
        provider: o.provider ?? null,
        checkedAt: o.checkedAt ?? null,
        verificationStatus: o.verificationStatus ?? null,
        description: o.description ?? null,
        address: o.address ?? null,
        phone: o.phone ?? null,
        logicalRole: o.logicalRole ?? null,
      }))
      .sort((a, b) => a.externalId.localeCompare(b.externalId))

  return {
    trip: {
      id: pkg.trip.id ?? null,
      title: pkg.trip.title,
      destination: pkg.trip.destination ?? null,
      startDate: pkg.trip.startDate,
      endDate: pkg.trip.endDate,
      timezone: pkg.trip.timezone,
    },
    travelOptions: sortOpts(pkg.travelOptions),
  }
}

function opsPlanSlice(ops: AgentOpRecord[]): unknown {
  return [...ops]
    .map((o) => ({
      op: o.op,
      entityKind: o.entityKind,
      externalId: o.externalId,
      supersedesExternalId: o.supersedesExternalId ?? null,
    }))
    .sort((a, b) => {
      const ka = `${a.op}|${a.entityKind}|${a.externalId}|${a.supersedesExternalId ?? ''}`
      const kb = `${b.op}|${b.entityKind}|${b.externalId}|${b.supersedesExternalId ?? ''}`
      return ka.localeCompare(kb)
    })
}

/** Deterministic hash of canonical ops + normalized package. */
export function computePlanHash(
  canonicalOps: AgentOpRecord[],
  normalizedPackage: TripPackageV1,
): string {
  return sha256Hex(
    stableStringify({
      ops: opsPlanSlice(canonicalOps),
      package: packagePlanSlice(normalizedPackage),
    }),
  )
}

function normVal(v: unknown): unknown {
  if (v === undefined) return null
  return v
}

function fieldChanges(
  before: TravelOption,
  after: PackageTravelOption,
): CanonicalDiffFieldChange[] {
  const changes: CanonicalDiffFieldChange[] = []
  for (const field of OPTION_COMPARE_FIELDS) {
    const b = normVal((before as Record<string, unknown>)[field])
    const a = normVal((after as Record<string, unknown>)[field])
    if (stableStringify(b) !== stableStringify(a)) {
      changes.push({ field, before: b, after: a })
    }
  }
  return changes
}

/**
 * Diff CURRENT vs NORMALIZED canonical desired state (+ remove/supersede ops).
 * Does not surface RAW-discarded noise.
 *
 * Supersede NEW → OLD is rendered as REMOVE(OLD) + ADD(NEW) so the preview
 * shows exactly what Apply will delete and create.
 */
export function buildCanonicalDiff(args: {
  currentTrip: Trip | undefined
  currentOptions: TravelOption[]
  normalizedPackage: TripPackageV1
  canonicalOps: AgentOpRecord[]
}): CanonicalDiffLine[] {
  const { currentTrip, currentOptions, normalizedPackage, canonicalOps } = args
  const lines: CanonicalDiffLine[] = []
  const currentByExt = new Map(
    currentOptions.map((o) => [o.externalId ?? o.id, o]),
  )

  /** Old externalIds deleted by explicit remove OR supersede. */
  const removedExt = new Map<string, string | undefined>()
  for (const o of canonicalOps) {
    if (o.entityKind !== 'travelOption') continue
    if (o.op === 'remove') {
      removedExt.set(o.externalId, undefined)
    } else if (o.op === 'supersede' && o.supersedesExternalId) {
      removedExt.set(o.supersedesExternalId, o.externalId)
    }
  }

  for (const ext of [...removedExt.keys()].sort()) {
    const cur = currentByExt.get(ext)
    const replacedBy = removedExt.get(ext)
    lines.push({
      kind: 'remove',
      entityKind: 'travelOption',
      externalId: ext,
      note: replacedBy
        ? `reemplazado por ${replacedBy}${cur?.title ? ` · ${cur.title}` : ''}`
        : cur?.title,
      fields: cur
        ? [{ field: 'title', before: cur.title, after: null }]
        : undefined,
    })
  }

  // Trip header changes (desired from package vs current)
  if (currentTrip) {
    const tripFields: CanonicalDiffFieldChange[] = []
    const pairs: [string, unknown, unknown][] = [
      ['title', currentTrip.title, normalizedPackage.trip.title],
      [
        'destination',
        currentTrip.destination ?? null,
        normalizedPackage.trip.destination ?? null,
      ],
      ['startDate', currentTrip.startDate, normalizedPackage.trip.startDate],
      ['endDate', currentTrip.endDate, normalizedPackage.trip.endDate],
      ['timezone', currentTrip.timezone, normalizedPackage.trip.timezone],
    ]
    for (const [field, before, after] of pairs) {
      if (stableStringify(before) !== stableStringify(after)) {
        tripFields.push({ field, before, after })
      }
    }
    if (tripFields.length) {
      lines.push({
        kind: 'update',
        entityKind: 'trip',
        externalId: currentTrip.id,
        fields: tripFields,
      })
    }
  }

  const normalized = [...normalizedPackage.travelOptions].sort((a, b) =>
    a.externalId.localeCompare(b.externalId),
  )

  for (const next of normalized) {
    if (removedExt.has(next.externalId)) continue
    const cur = currentByExt.get(next.externalId)
    if (!cur) {
      lines.push({
        kind: 'add',
        entityKind: 'travelOption',
        externalId: next.externalId,
        note: next.title,
        fields: [{ field: 'title', before: null, after: next.title }],
      })
      continue
    }
    const changes = fieldChanges(cur, next)
    if (changes.length === 0) {
      // Pure keep — omit from default noise (tests can still assert absence of false updates)
      continue
    }
    lines.push({
      kind: 'update',
      entityKind: 'travelOption',
      externalId: next.externalId,
      note: next.title,
      fields: changes,
    })
  }

  return lines
}

/**
 * Pre-write preparation shared by compile-preview and import-package.
 * No persistence side effects.
 */
export function prepareMutationPlan(
  input: PrepareMutationPlanInput,
): PrepareMutationPlanResult {
  const {
    tripId,
    currentTrip,
    currentOptions,
    rawPackage,
    llmOps,
  } = input

  const fingerprint = computeStateFingerprint(currentTrip, currentOptions)

  const validated = validateTripPackage(rawPackage)
  if (!validated.ok) {
    return {
      status: 'review_required',
      conflicts: validated.errors.map((e) => `${e.path}: ${e.message}`),
      warnings: [],
      canonicalOps: [],
      normalizedPackage: rawPackage as TripPackageV1,
      fingerprint,
      planHash: '',
      diff: [],
      sanitizeEvents: [],
      compiled: false,
      matching: [],
    }
  }

  let pkg = enrichTripPackageAirportArrivals(validated.package)
  let opsForApply = llmOps
  let warnings: string[] = []
  let conflicts: string[] = []
  let matching: PrepareMutationPlanResult['matching'] = []
  let compiled = false
  let status: 'ok' | 'review_required' = 'ok'

  if (currentTrip && currentOptions.length > 0) {
    compiled = true
    const plan = compileMutationPlan({
      tripId,
      currentTrip,
      currentOptions,
      proposedPackage: pkg,
      llmOps,
    })
    warnings = plan.warnings
    conflicts = plan.conflicts
    matching = plan.matching
    status = plan.status
    if (plan.status === 'ok') {
      pkg = enrichTripPackageAirportArrivals(plan.package)
      opsForApply = plan.ops
    } else {
      const fingerprintOnly = fingerprint
      return {
        status: 'review_required',
        conflicts: conflicts.length
          ? conflicts
          : ['mutation plan requires review'],
        warnings,
        canonicalOps: [],
        normalizedPackage: pkg,
        fingerprint: fingerprintOnly,
        planHash: '',
        diff: [],
        sanitizeEvents: [],
        compiled: true,
        matching,
      }
    }
  }

  const sanitized = sanitizeForPostgres(pkg, '$.package')
  pkg = sanitized.value

  try {
    validateMutationOps({
      pkg,
      tripId,
      ops: opsForApply,
      existingOptions: currentOptions,
    })
  } catch (e) {
    if (e instanceof PackageMutationValidationError) {
      return {
        status: 'review_required',
        conflicts: e.details,
        warnings,
        canonicalOps: opsForApply,
        normalizedPackage: pkg,
        fingerprint,
        planHash: '',
        diff: [],
        sanitizeEvents: sanitized.events,
        compiled,
        matching,
      }
    }
    throw e
  }

  const planHash = computePlanHash(opsForApply, pkg)
  const diff = buildCanonicalDiff({
    currentTrip,
    currentOptions,
    normalizedPackage: pkg,
    canonicalOps: opsForApply,
  })

  return {
    status,
    conflicts: [],
    warnings,
    canonicalOps: opsForApply,
    normalizedPackage: pkg,
    fingerprint,
    planHash,
    diff,
    sanitizeEvents: sanitized.events,
    compiled,
    matching,
  }
}

export class PreviewGateError extends Error {
  readonly code: 'preview_stale' | 'plan_changed' | 'fingerprint_required'
  readonly currentFingerprint?: string
  readonly expectedFingerprint?: string
  readonly currentPlanHash?: string
  readonly expectedPlanHash?: string
  constructor(
    code: PreviewGateError['code'],
    message: string,
    extra?: Partial<
      Pick<
        PreviewGateError,
        | 'currentFingerprint'
        | 'expectedFingerprint'
        | 'currentPlanHash'
        | 'expectedPlanHash'
      >
    >,
  ) {
    super(message)
    this.name = 'PreviewGateError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** Pure gate used by Apply (and tests). No I/O. */
export function enforcePreviewGate(
  prepared: PrepareMutationPlanResult,
  opts: {
    expectedFingerprint?: string
    expectedPlanHash?: string
    requirePreviewGate?: boolean
    /** Existing trip with options — Ask Travel requires fingerprint. */
    existingTripWithOptions: boolean
  },
): void {
  const expectedFingerprint = opts.expectedFingerprint?.trim() || undefined
  const expectedPlanHash = opts.expectedPlanHash?.trim() || undefined

  if (
    opts.requirePreviewGate &&
    opts.existingTripWithOptions &&
    !expectedFingerprint
  ) {
    throw new PreviewGateError(
      'fingerprint_required',
      'expectedFingerprint required when requirePreviewGate=true',
    )
  }
  if (expectedFingerprint && prepared.fingerprint !== expectedFingerprint) {
    throw new PreviewGateError('preview_stale', 'preview_stale', {
      currentFingerprint: prepared.fingerprint,
      expectedFingerprint,
    })
  }
  if (prepared.status === 'review_required') {
    return
  }
  if (
    expectedPlanHash &&
    prepared.planHash &&
    prepared.planHash !== expectedPlanHash
  ) {
    throw new PreviewGateError('plan_changed', 'plan_changed', {
      currentPlanHash: prepared.planHash,
      expectedPlanHash,
    })
  }
}
