/**
 * Merge component-action patches into a TripPackage without regenerating.
 */
import type {
  ApplyComponentActionInput,
  ComponentActionResult,
  EntityPatch,
  SharedTripPackageV1,
} from '../../../shared/agentContracts'
import { enrichTripPackageAirportArrivals } from '../airportArrivalEnrich'
import type { TripPackageV1 } from '../tripPackage'

export class StaleRevisionError extends Error {
  readonly code = 'stale_revision'
  readonly expected: number
  readonly actual: number
  constructor(expected: number, actual: number) {
    super(
      `El viaje cambió (revisión ${actual} ≠ ${expected}). Vuelve a generar la acción.`,
    )
    this.name = 'StaleRevisionError'
    this.expected = expected
    this.actual = actual
  }
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function appendHistoryNotes(
  notes: unknown,
  entries: EntityPatch['provenanceHistoryAppend'],
): string | undefined {
  const lines = (entries ?? []).map(
    (e) =>
      `[provenance:${e.event}] ${e.at} ${e.sourceType}/${e.verificationStatus} fields=${e.fields.join(',')}: ${e.note}`,
  )
  const prev = typeof notes === 'string' ? notes.trim() : ''
  if (!lines.length) return prev || undefined
  return prev ? `${prev}\n${lines.join('\n')}` : lines.join('\n')
}

function applyPatchToOption(
  opt: Record<string, unknown>,
  patch: EntityPatch,
): Record<string, unknown> {
  const after = { ...asRec(patch.after) }
  after.externalId = patch.componentId
  after.notes = appendHistoryNotes(after.notes, patch.provenanceHistoryAppend)
  // Ensure provenance stamp fields win
  after.sourceType = patch.provenance.sourceType
  after.verificationStatus = patch.provenance.verificationStatus
  if (patch.provenance.sourceUrl) after.sourceUrl = patch.provenance.sourceUrl
  else if (patch.provenance.sourceType === 'manual') delete after.sourceUrl
  if (patch.provenance.checkedAt) after.checkedAt = patch.provenance.checkedAt
  return { ...opt, ...after, externalId: patch.componentId }
}

/**
 * Apply only explicitly accepted patches / impacts / alternatives.
 * Throws StaleRevisionError when currentRevision !== result.baseRevision.
 */
export function mergeComponentActionIntoPackage(
  pkgIn: SharedTripPackageV1 | TripPackageV1,
  input: ApplyComponentActionInput,
): SharedTripPackageV1 {
  const result = input.result
  if (input.currentRevision !== result.baseRevision) {
    throw new StaleRevisionError(result.baseRevision, input.currentRevision)
  }

  const pkg = structuredClone(pkgIn) as SharedTripPackageV1
  const acceptedPatches = new Set(input.acceptedPatchComponentIds)
  const acceptedImpacts = new Set(input.acceptedImpactIds)
  const acceptedAlts = new Set(input.acceptedAlternativeIds)

  const patchesToApply: EntityPatch[] = []
  for (const p of result.patches) {
    if (acceptedPatches.has(p.componentId)) patchesToApply.push(p)
  }
  for (const imp of result.impacts) {
    if (!acceptedImpacts.has(imp.impactId)) continue
    if (imp.suggestedPatch) patchesToApply.push(imp.suggestedPatch)
  }

  const options = [...(pkg.travelOptions ?? [])] as Record<string, unknown>[]
  const itinerary = [...(pkg.itineraryItems ?? [])] as Record<string, unknown>[]
  const checklist = [...(pkg.checklistItems ?? [])] as Record<string, unknown>[]
  const notes = [...(pkg.notes ?? [])] as Record<string, unknown>[]

  const bump = (
    arr: Record<string, unknown>[],
    patch: EntityPatch,
  ): Record<string, unknown>[] => {
    const idx = arr.findIndex(
      (o) => String(o.externalId) === patch.componentId,
    )
    if (patch.op === 'add' || idx < 0) {
      return [...arr, applyPatchToOption({}, patch)]
    }
    const next = [...arr]
    next[idx] = applyPatchToOption(asRec(next[idx]), patch)
    return next
  }

  let nextOptions = options
  let nextItin = itinerary
  let nextChk = checklist
  let nextNotes = notes

  for (const p of patchesToApply) {
    if (p.componentKind === 'travelOption') nextOptions = bump(nextOptions, p)
    else if (p.componentKind === 'itineraryItem') nextItin = bump(nextItin, p)
    else if (p.componentKind === 'checklistItem') nextChk = bump(nextChk, p)
    else if (p.componentKind === 'note') nextNotes = bump(nextNotes, p)
  }

  // Add accepted researched alternatives (never auto-promote)
  for (const alt of result.alternatives) {
    if (!acceptedAlts.has(alt.provisionalExternalId)) continue
    if (nextOptions.some((o) => o.externalId === alt.provisionalExternalId)) {
      continue
    }
    nextOptions.push({ ...alt.option } as Record<string, unknown>)
  }

  // Promote lifecycle: researched alt → shortlisted; demote previous target
  if (input.promoteAlternativeId) {
    const altId = input.promoteAlternativeId
    const altIdx = nextOptions.findIndex((o) => o.externalId === altId)
    const targetId = result.target.componentId
    const targetIdx = nextOptions.findIndex((o) => o.externalId === targetId)
    if (altIdx >= 0) {
      const alt = { ...asRec(nextOptions[altIdx]) }
      alt.status = 'shortlisted'
      const hist = `[provenance:promote_alternative] ${new Date().toISOString()} agent/${alt.verificationStatus ?? 'estimated'} fields=status: Promovida como selección preferida`
      alt.notes = alt.notes ? `${alt.notes}\n${hist}` : hist
      nextOptions[altIdx] = alt
      if (targetIdx >= 0 && targetIdx !== altIdx) {
        const prev = { ...asRec(nextOptions[targetIdx]) }
        prev.status = 'researched'
        prev.notes = [
          typeof prev.notes === 'string' ? prev.notes : '',
          'Alternativa — dejó de ser la selección preferida tras promoción.',
        ]
          .filter(Boolean)
          .join('\n')
        nextOptions[targetIdx] = prev
      }
    }
  }

  pkg.travelOptions = nextOptions as SharedTripPackageV1['travelOptions']
  pkg.itineraryItems = nextItin as SharedTripPackageV1['itineraryItems']
  pkg.checklistItems = nextChk as SharedTripPackageV1['checklistItems']
  pkg.notes = nextNotes as SharedTripPackageV1['notes']
  pkg.revision = result.expectedRevisionOnApply

  // Policy-only airport enrich when a flight startAt patch was accepted
  const flightTouched = patchesToApply.some(
    (p) =>
      p.componentKind === 'travelOption' &&
      p.changedFields.includes('startAt'),
  )
  if (flightTouched) {
    return enrichTripPackageAirportArrivals(pkg as TripPackageV1) as SharedTripPackageV1
  }
  return pkg
}

/** Build promote-preview result from an existing RESEARCH result + chosen alt. */
export function buildPromotePreview(
  researchResult: ComponentActionResult,
  alternativeId: string,
): ComponentActionResult {
  const alt = researchResult.alternatives.find(
    (a) => a.provisionalExternalId === alternativeId,
  )
  if (!alt) {
    throw new Error(`Alternativa no encontrada: ${alternativeId}`)
  }
  const targetId = researchResult.target.componentId
  return {
    ...researchResult,
    resultId: `${researchResult.resultId}-promote-${alternativeId}`,
    operation: 'RESEARCH_REPLAN',
    narrative: `Promover «${alt.summary}» como opción preferida (sustituye el estatus shortlisted de ${targetId}).`,
    diffSummary: [
      {
        entityKind: 'travelOption',
        entityRef: alternativeId,
        op: 'update',
        before: 'researched (alternativa)',
        after: 'shortlisted (preferida)',
        note: 'Usar esta opción',
      },
      {
        entityKind: 'travelOption',
        entityRef: targetId,
        op: 'update',
        before: 'shortlisted',
        after: 'researched (alternativa)',
        note: 'Demote tras promoción',
      },
    ],
    // Ensure alt is addable if not yet in package
    alternatives: [alt],
    patches: [],
    impacts: researchResult.impacts,
    ops: [
      {
        op: 'add',
        entityKind: 'travelOption',
        externalId: alternativeId,
        note: 'promoción pendiente de confirmación',
      },
    ],
  }
}
