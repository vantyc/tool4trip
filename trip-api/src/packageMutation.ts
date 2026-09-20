import type pg from 'pg'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import { agentOpRecordSchema } from '../../shared/agentContracts.ts'
import {
  USER_DECISION_STATUSES,
  checklistEntityId,
  itineraryEntityId,
  noteEntityId,
  optionEntityId,
  type TripPackageV1,
} from './tripPackage.ts'
import type { TravelOption } from './domainTypes.ts'
import { store } from './store.ts'

export class PackageMutationConflictError extends Error {
  readonly code = 'mutation_conflict'
  readonly conflicts: string[]
  constructor(conflicts: string[]) {
    super(conflicts.join('; ') || 'mutation conflict')
    this.name = 'PackageMutationConflictError'
    this.conflicts = conflicts
  }
}

export class PackageMutationValidationError extends Error {
  readonly code = 'mutation_invalid'
  readonly details: string[]
  constructor(details: string[]) {
    super(details.join('; ') || 'mutation invalid')
    this.name = 'PackageMutationValidationError'
    this.details = details
  }
}

function sanitizeExt(externalId: string): string {
  return externalId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)
}

/**
 * Derived entity externalIds / ids that are formula-linked to a travelOption
 * externalId (airport-arrival policy + chk-airport). No title/date heuristics.
 */
export function derivedEntitiesForTravelOption(
  packageId: string,
  flightExternalId: string,
): {
  itineraryExternalIds: string[]
  checklistExternalIds: string[]
  itineraryEntityIds: string[]
  checklistEntityIds: string[]
  reminderIds: string[]
} {
  const safe = sanitizeExt(flightExternalId)
  const itineraryExternalIds = [
    `airport-arrival-desk-${safe}`,
    `airport-arrival-online-${safe}`,
  ]
  const checklistExternalIds = [`chk-airport-${safe}`]
  const itineraryEntityIds = itineraryExternalIds.map((e) =>
    itineraryEntityId(packageId, e),
  )
  const checklistEntityIds = checklistExternalIds.map((e) =>
    checklistEntityId(packageId, e),
  )
  const reminderIds = itineraryEntityIds.map((id) => `rem-${id}`)
  return {
    itineraryExternalIds,
    checklistExternalIds,
    itineraryEntityIds,
    checklistEntityIds,
    reminderIds,
  }
}

export function isProtectedTravelOption(o: {
  status?: string
  bookingId?: string | null
}): boolean {
  const status = o.status ?? ''
  if ((USER_DECISION_STATUSES as readonly string[]).includes(status)) return true
  if (o.bookingId != null && String(o.bookingId).trim() !== '') return true
  return false
}

export type ParsedImportBody = {
  rawPackage: unknown
  ops: AgentOpRecord[]
}

/**
 * Accept legacy raw TripPackage OR `{ package, ops }` Apply body.
 * Absence of ops → upsert-only (no deletes) — partial mutations stay safe.
 */
export function parseImportBody(body: unknown): ParsedImportBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { rawPackage: body, ops: [] }
  }
  const rec = body as Record<string, unknown>
  const nested = rec.package
  const looksWrapped =
    nested &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    ('schemaVersion' in (nested as object) ||
      'travelOptions' in (nested as object) ||
      'trip' in (nested as object))

  if (looksWrapped) {
    const parsed = agentOpRecordSchema.array().safeParse(rec.ops ?? [])
    if (!parsed.success) {
      throw new PackageMutationValidationError([
        `ops schema: ${parsed.error.message.slice(0, 500)}`,
      ])
    }
    return { rawPackage: nested, ops: parsed.data }
  }
  return { rawPackage: body, ops: [] }
}

function packageExtIds(pkg: TripPackageV1, kind: AgentOpRecord['entityKind']): Set<string> {
  switch (kind) {
    case 'travelOption':
      return new Set(pkg.travelOptions.map((o) => o.externalId))
    case 'itineraryItem':
      return new Set(pkg.itineraryItems.map((o) => o.externalId))
    case 'checklistItem':
      return new Set(pkg.checklistItems.map((o) => o.externalId))
    case 'note':
      return new Set(pkg.notes.map((o) => o.externalId))
    default:
      return new Set()
  }
}

export type MutationValidationOk = {
  ok: true
  /** externalIds to delete after upsert (remove + supersede targets) */
  deleteTravelOptionExternalIds: string[]
  deleteItineraryExternalIds: string[]
  deleteChecklistExternalIds: string[]
  deleteNoteExternalIds: string[]
}

/**
 * Validate ops against package + existing trip options. No writes.
 * Fails closed on protected entities / wrong trip / missing supersede target in package.
 * Rejects contradictory / duplicate mutation targets before any write.
 */
export function validateMutationOps(args: {
  pkg: TripPackageV1
  tripId: string
  ops: AgentOpRecord[]
  existingOptions: TravelOption[]
}): MutationValidationOk {
  const { pkg, tripId, ops, existingOptions } = args
  const details: string[] = []
  const conflicts: string[] = []

  const byExt = new Map<string, TravelOption>()
  for (const o of existingOptions) {
    if (o.tripId !== tripId) continue
    if (o.externalId) byExt.set(o.externalId, o)
  }

  const pkgTravelIds = packageExtIds(pkg, 'travelOption')

  // --- Deterministic contradiction scan (order-independent) ---
  type Touch = { op: string; index: number }
  const touchesNew = new Map<string, Touch[]>() // externalId (new/target)
  const touchesOld = new Map<string, Touch[]>() // remove target or supersedesExternalId

  const pushTouch = (map: Map<string, Touch[]>, id: string, touch: Touch) => {
    const arr = map.get(id) ?? []
    arr.push(touch)
    map.set(id, arr)
  }

  for (const [i, op] of ops.entries()) {
    if (op.op === 'noop' || op.entityKind !== 'travelOption') continue
    if (op.op === 'add' || op.op === 'update' || op.op === 'supersede') {
      pushTouch(touchesNew, op.externalId, { op: op.op, index: i })
    }
    if (op.op === 'remove') {
      pushTouch(touchesOld, op.externalId, { op: 'remove', index: i })
    }
    if (op.op === 'supersede' && op.supersedesExternalId) {
      pushTouch(touchesOld, op.supersedesExternalId, {
        op: 'supersede',
        index: i,
      })
    }
  }

  for (const [id, list] of touchesOld) {
    const removes = list.filter((t) => t.op === 'remove')
    const supersedes = list.filter((t) => t.op === 'supersede')
    if (removes.length + supersedes.length > 1) {
      details.push(
        `contradictory/duplicate ops on ${id}: ${list.map((t) => `${t.op}@${t.index}`).join(', ')}`,
      )
    }
    // remove + update/add/supersede(new) on same id
    const asNew = touchesNew.get(id) ?? []
    if (removes.length && asNew.length) {
      details.push(
        `contradictory ops on ${id}: remove together with ${asNew.map((t) => t.op).join(',')}`,
      )
    }
  }

  for (const [id, list] of touchesNew) {
    const kinds = new Set(list.map((t) => t.op))
    if (kinds.size > 1) {
      details.push(
        `contradictory ops on new target ${id}: ${[...kinds].join('+')}`,
      )
    }
    if (list.length > 1 && kinds.size === 1 && !kinds.has('update')) {
      // duplicate add/supersede of same new id
      details.push(
        `duplicate ops on ${id}: ${list.map((t) => `${t.op}@${t.index}`).join(', ')}`,
      )
    }
  }

  // remove must not target an entity that the same proposal is upserting (newly added / updated in package)
  for (const [i, op] of ops.entries()) {
    if (op.op !== 'remove' || op.entityKind !== 'travelOption') continue
    if (pkgTravelIds.has(op.externalId)) {
      details.push(
        `ops[${i}] remove ${op.externalId}: cannot remove an entity present in the same package (use supersede or omit from package + remove only for obsolete research)`,
      )
    }
  }

  const deleteTravel = new Set<string>()
  const deleteItin = new Set<string>()
  const deleteChk = new Set<string>()
  const deleteNote = new Set<string>()

  // Process in stable order: sort by index (already sequential) — deterministic
  const ordered = ops.map((op, index) => ({ op, index }))

  for (const { op, index: i } of ordered) {
    if (op.op === 'noop') continue
    const label = `ops[${i}] ${op.op} ${op.entityKind}:${op.externalId}`

    if (op.entityKind !== 'travelOption') {
      // Phase 1: execute travelOption mutations; other kinds validated lightly
      if (op.op === 'add' || op.op === 'update' || op.op === 'supersede') {
        if (!packageExtIds(pkg, op.entityKind).has(op.externalId)) {
          details.push(
            `${label}: externalId must appear in package.${op.entityKind}s`,
          )
        }
      }
      if (op.op === 'remove') {
        if (op.entityKind === 'itineraryItem') deleteItin.add(op.externalId)
        else if (op.entityKind === 'checklistItem') deleteChk.add(op.externalId)
        else if (op.entityKind === 'note') deleteNote.add(op.externalId)
      }
      if (op.op === 'supersede' && op.supersedesExternalId) {
        if (op.entityKind === 'itineraryItem') {
          deleteItin.add(op.supersedesExternalId)
        } else if (op.entityKind === 'checklistItem') {
          deleteChk.add(op.supersedesExternalId)
        } else if (op.entityKind === 'note') {
          deleteNote.add(op.supersedesExternalId)
        }
      }
      continue
    }

    if (op.op === 'add' || op.op === 'update' || op.op === 'supersede') {
      if (!pkgTravelIds.has(op.externalId)) {
        details.push(
          `${label}: new externalId must appear in package.travelOptions`,
        )
      }
    }

    if (op.op === 'remove') {
      const existing = byExt.get(op.externalId)
      if (existing) {
        if (existing.packageId && existing.packageId !== pkg.packageId) {
          details.push(
            `${label}: option belongs to package ${existing.packageId}, not ${pkg.packageId}`,
          )
        }
        if (existing.tripId !== tripId) {
          details.push(`${label}: option tripId mismatch`)
        }
        if (isProtectedTravelOption(existing)) {
          conflicts.push(
            `${label}: protected status=${existing.status}` +
              (existing.bookingId ? ` bookingId=${existing.bookingId}` : ''),
          )
        } else {
          deleteTravel.add(op.externalId)
        }
      }
      // already absent → idempotent (no error)
    }

    if (op.op === 'supersede') {
      const oldId = op.supersedesExternalId!
      if (pkgTravelIds.has(oldId)) {
        details.push(
          `${label}: supersedesExternalId ${oldId} must not also appear in package.travelOptions`,
        )
      }
      const existing = byExt.get(oldId)
      if (existing) {
        if (existing.packageId && existing.packageId !== pkg.packageId) {
          details.push(
            `${label}: superseded option package mismatch (${existing.packageId})`,
          )
        }
        if (existing.tripId !== tripId) {
          details.push(`${label}: superseded option tripId mismatch`)
        }
        if (isProtectedTravelOption(existing)) {
          conflicts.push(
            `${label}: cannot supersede protected ${oldId} (status=${existing.status}` +
              (existing.bookingId ? ` bookingId=${existing.bookingId}` : '') +
              ')',
          )
        } else {
          deleteTravel.add(oldId)
        }
      }
      // already absent → idempotent
    }
  }

  if (conflicts.length) throw new PackageMutationConflictError(conflicts)
  if (details.length) throw new PackageMutationValidationError(details)

  // Deterministic delete set (sorted)
  return {
    ok: true,
    deleteTravelOptionExternalIds: [...deleteTravel].sort(),
    deleteItineraryExternalIds: [...deleteItin].sort(),
    deleteChecklistExternalIds: [...deleteChk].sort(),
    deleteNoteExternalIds: [...deleteNote].sort(),
  }
}

/** Expand travelOption deletions with formula-derived airport entities. */
export function expandDerivedDeletes(
  packageId: string,
  flightExternalIds: string[],
): {
  itineraryEntityIds: string[]
  checklistEntityIds: string[]
  reminderIds: string[]
} {
  const itineraryEntityIds = new Set<string>()
  const checklistEntityIds = new Set<string>()
  const reminderIds = new Set<string>()
  for (const ext of flightExternalIds) {
    const d = derivedEntitiesForTravelOption(packageId, ext)
    for (const id of d.itineraryEntityIds) itineraryEntityIds.add(id)
    for (const id of d.checklistEntityIds) checklistEntityIds.add(id)
    for (const id of d.reminderIds) reminderIds.add(id)
  }
  return {
    itineraryEntityIds: [...itineraryEntityIds],
    checklistEntityIds: [...checklistEntityIds],
    reminderIds: [...reminderIds],
  }
}

/**
 * Delete validated travelOptions + formula-derived airport entities.
 * Call AFTER package upsert, inside the same transaction.
 */
export async function executeValidatedDeletes(
  client: pg.PoolClient,
  args: {
    pkg: TripPackageV1
    tripId: string
    plan: MutationValidationOk
  },
): Promise<{ removedOptions: number; removedDerived: number }> {
  const { pkg, tripId, plan } = args
  let removedOptions = 0
  let removedDerived = 0

  const derived = expandDerivedDeletes(
    pkg.packageId,
    plan.deleteTravelOptionExternalIds,
  )

  for (const ext of plan.deleteTravelOptionExternalIds) {
    const id = optionEntityId(pkg.packageId, ext)
    const existing = await store.getTravelOption(client, id)
    if (!existing) continue
    if (existing.tripId !== tripId) {
      throw new PackageMutationValidationError([
        `refuse delete ${ext}: trip mismatch`,
      ])
    }
    if (isProtectedTravelOption(existing)) {
      throw new PackageMutationConflictError([
        `refuse delete ${ext}: became protected during apply`,
      ])
    }
    await store.deleteTravelOption(client, id)
    removedOptions += 1
  }

  for (const id of derived.itineraryEntityIds) {
    const item = await store.getItineraryItem(client, id)
    if (!item) continue
    if (item.tripId !== tripId) continue
    if (item.bookingId) continue
    const rems = await store.listRemindersByItem(client, id)
    for (const r of rems) {
      if (r.tripId === tripId) {
        await store.deleteReminder(client, r.id)
        removedDerived += 1
      }
    }
    const remId = `rem-${id}`
    if (await store.getReminder(client, remId)) {
      await store.deleteReminder(client, remId)
      removedDerived += 1
    }
    await store.deleteItineraryItem(client, id)
    removedDerived += 1
  }

  for (const id of derived.checklistEntityIds) {
    const item = await store.getChecklistItem(client, id)
    if (!item) continue
    if (item.tripId !== tripId) continue
    await store.deleteChecklistItem(client, id)
    removedDerived += 1
  }

  for (const remId of derived.reminderIds) {
    const r = await store.getReminder(client, remId)
    if (r && r.tripId === tripId) {
      await store.deleteReminder(client, remId)
      removedDerived += 1
    }
  }

  // Explicit itinerary/checklist/note removes from ops
  for (const ext of plan.deleteItineraryExternalIds) {
    const id = itineraryEntityId(pkg.packageId, ext)
    const item = await store.getItineraryItem(client, id)
    if (!item || item.tripId !== tripId) continue
    if (item.bookingId) {
      throw new PackageMutationConflictError([
        `cannot remove itinerary ${ext}: has bookingId`,
      ])
    }
    const rems = await store.listRemindersByItem(client, id)
    for (const r of rems) {
      if (r.tripId === tripId) await store.deleteReminder(client, r.id)
    }
    await store.deleteItineraryItem(client, id)
    removedDerived += 1
  }
  for (const ext of plan.deleteChecklistExternalIds) {
    const id = checklistEntityId(pkg.packageId, ext)
    const item = await store.getChecklistItem(client, id)
    if (!item || item.tripId !== tripId) continue
    await store.deleteChecklistItem(client, id)
    removedDerived += 1
  }
  for (const ext of plan.deleteNoteExternalIds) {
    const id = noteEntityId(pkg.packageId, ext)
    const item = await store.getNote(client, id)
    if (!item || item.tripId !== tripId) continue
    await store.deleteNote(client, id)
    removedDerived += 1
  }

  return { removedOptions, removedDerived }
}

/**
 * In-memory apply of option-level mutation for unit tests (no DB).
 * Models: upsert package options, then delete remove/supersede targets.
 */
export function applyMutationInMemory(args: {
  tripId: string
  packageId: string
  existing: TravelOption[]
  packageOptions: Array<{
    externalId: string
    type: string
    status: string
    title: string
    startAt?: string
    endAt?: string
    sourceType?: string
    sourceUrl?: string
    provider?: string
    verificationStatus?: string
    notes?: string
  }>
  ops: AgentOpRecord[]
}): {
  options: TravelOption[]
  removedExternalIds: string[]
} {
  const pkgStub = {
    packageId: args.packageId,
    travelOptions: args.packageOptions.map((o) => ({
      externalId: o.externalId,
    })),
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  } as unknown as TripPackageV1

  const plan = validateMutationOps({
    pkg: {
      ...pkgStub,
      schemaVersion: 1,
      revision: 1,
      generatedAt: '2026-09-20T00:00:00Z',
      trip: {
        id: args.tripId,
        title: 't',
        startDate: '2026-09-25',
        endDate: '2026-09-28',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      travelOptions: args.packageOptions.map((o) => ({
        externalId: o.externalId,
        type: o.type as TravelOption['type'],
        status: o.status as 'researched' | 'shortlisted',
        title: o.title,
        startAt: o.startAt,
        endAt: o.endAt,
        sourceType: o.sourceType as TravelOption['sourceType'],
        sourceUrl: o.sourceUrl,
        provider: o.provider,
        verificationStatus: o.verificationStatus as TravelOption['verificationStatus'],
        notes: o.notes,
      })),
    },
    tripId: args.tripId,
    ops: args.ops,
    existingOptions: args.existing,
  })

  const now = '2026-09-20T06:00:00.000Z'
  const map = new Map<string, TravelOption>()
  for (const o of args.existing) {
    if (o.tripId === args.tripId) map.set(o.externalId ?? o.id, o)
  }
  for (const incoming of args.packageOptions) {
    const id = optionEntityId(args.packageId, incoming.externalId)
    const prev = map.get(incoming.externalId)
    map.set(incoming.externalId, {
      id,
      tripId: args.tripId,
      type: incoming.type as TravelOption['type'],
      status: (prev && isProtectedTravelOption(prev)
        ? prev.status
        : incoming.status) as TravelOption['status'],
      title: incoming.title,
      startAt: incoming.startAt,
      endAt: incoming.endAt,
      sourceType: incoming.sourceType as TravelOption['sourceType'],
      sourceUrl: incoming.sourceUrl,
      provider: incoming.provider,
      verificationStatus:
        incoming.verificationStatus as TravelOption['verificationStatus'],
      notes: incoming.notes,
      externalId: incoming.externalId,
      packageId: args.packageId,
      bookingId: prev?.bookingId,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      syncStatus: 'synced',
    })
  }
  const removedExternalIds: string[] = []
  for (const ext of plan.deleteTravelOptionExternalIds) {
    if (map.has(ext)) {
      map.delete(ext)
      removedExternalIds.push(ext)
    }
  }
  return { options: [...map.values()], removedExternalIds }
}
