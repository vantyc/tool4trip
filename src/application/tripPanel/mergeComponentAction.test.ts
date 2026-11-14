import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ComponentActionResult, SharedTripPackageV1 } from '../../../shared/agentContracts'
import {
  forceUserSuppliedProvenance,
  resolveOperationFromIntent,
} from '../../../travel-agent/src/agent/componentAction.ts'
import {
  buildPromotePreview,
  mergeComponentActionIntoPackage,
  StaleRevisionError,
} from './mergeComponentAction.ts'

function basePkg(): SharedTripPackageV1 {
  return {
    schemaVersion: 1,
    packageId: 'pkg-1',
    revision: 2,
    trip: {
      id: 't1',
      title: 'Test',
      startDate: '2026-09-19',
      endDate: '2026-09-22',
      timezone: 'America/Mexico_City',
      goals: [],
      status: 'planned',
    },
    travelOptions: [
      {
        externalId: 'flt-out',
        type: 'flight',
        status: 'shortlisted',
        title: 'MEX → GDL',
        origin: 'MEX',
        destination: 'GDL',
        verificationStatus: 'estimated',
        sourceType: 'agent',
      },
    ],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  }
}

function editResult(): ComponentActionResult {
  return {
    resultId: 'r1',
    createdAt: '2026-09-19T12:00:00Z',
    operation: 'EDIT',
    actionIntent: 'adjust',
    target: {
      componentId: 'flt-out',
      componentKind: 'travelOption',
      componentType: 'flight',
    },
    baseRevision: 2,
    expectedRevisionOnApply: 3,
    narrative: 'Hora aportada por el viajero',
    warnings: [],
    diffSummary: [],
    patches: [
      {
        componentId: 'flt-out',
        componentKind: 'travelOption',
        op: 'update',
        before: { externalId: 'flt-out' },
        after: {
          externalId: 'flt-out',
          type: 'flight',
          title: 'MEX → GDL',
          startAt: '2026-09-19T19:40:00-06:00',
          sourceType: 'manual',
          verificationStatus: 'unverified',
          notes: 'Dato del viajero: sale a las 19:40',
        },
        changedFields: ['startAt', 'notes', 'sourceType', 'verificationStatus'],
        provenance: {
          sourceType: 'manual',
          verificationStatus: 'unverified',
          note: 'Dato del viajero',
        },
        provenanceHistoryAppend: [
          {
            at: '2026-09-19T12:00:00Z',
            event: 'user_edit',
            sourceType: 'manual',
            verificationStatus: 'unverified',
            fields: ['startAt'],
            note: 'Dato del viajero: sale a las 19:40',
          },
        ],
      },
    ],
    alternatives: [],
    impacts: [
      {
        impactId: 'imp-1',
        componentId: 'airport-arrival-desk-flt-out',
        componentKind: 'itineraryItem',
        relation: 'airport_arrival',
        reason: 'Recalcular arribo',
        severity: 'warning',
        requiresUserChoice: true,
      },
    ],
    toolTrace: [],
    ops: [],
    contextSource: 'persisted',
  }
}

describe('component action merge + provenance', () => {
  it('resolveOperationFromIntent forces verify/find_alternative', () => {
    assert.equal(resolveOperationFromIntent('verify'), 'VERIFY')
    assert.equal(resolveOperationFromIntent('find_alternative'), 'RESEARCH_REPLAN')
    assert.equal(resolveOperationFromIntent('adjust', 'EDIT'), 'EDIT')
    assert.equal(
      resolveOperationFromIntent('adjust', 'RESEARCH_REPLAN'),
      'RESEARCH_REPLAN',
    )
  })

  it('forceUserSuppliedProvenance never leaves verified', () => {
    const { after, provenance } = forceUserSuppliedProvenance(
      {
        startAt: '2026-09-19T19:40:00-06:00',
        verificationStatus: 'verified',
        sourceType: 'agent',
        sourceUrl: 'https://evil.example',
      },
      ['startAt'],
      'mi vuelo sale a las 19:40',
    )
    assert.equal(after.verificationStatus, 'unverified')
    assert.equal(after.sourceType, 'manual')
    assert.equal(after.sourceUrl, undefined)
    assert.equal(provenance.verificationStatus, 'unverified')
    assert.match(String(after.notes), /Dato del viajero/)
  })

  it('merge applies only accepted patch ids; impacts off by default', () => {
    const pkg = basePkg()
    const result = editResult()
    const merged = mergeComponentActionIntoPackage(pkg, {
      result,
      acceptedPatchComponentIds: ['flt-out'],
      acceptedImpactIds: [],
      acceptedAlternativeIds: [],
      currentRevision: 2,
    })
    const flt = merged.travelOptions.find((o) => o.externalId === 'flt-out')!
    assert.equal(flt.startAt, '2026-09-19T19:40:00-06:00')
    assert.equal(flt.sourceType, 'manual')
    assert.equal(flt.verificationStatus, 'unverified')
    assert.equal(merged.revision, 3)
    // Impacts off by default: suggestedPatch for impact not applied.
    // Policy airport-arrival enrich may still run when startAt changes.
    assert.equal(
      merged.itineraryItems.some((i) =>
        String(i.externalId) === 'airport-arrival-desk-flt-out' &&
          (i as { notes?: string }).notes?.includes('impact'),
      ),
      false,
    )
  })

  it('stale revision throws', () => {
    assert.throws(
      () =>
        mergeComponentActionIntoPackage(basePkg(), {
          result: editResult(),
          acceptedPatchComponentIds: ['flt-out'],
          acceptedImpactIds: [],
          acceptedAlternativeIds: [],
          currentRevision: 99,
        }),
      (err: unknown) => err instanceof StaleRevisionError,
    )
  })

  it('RESEARCH alternatives add without replacing shortlisted', () => {
    const pkg = basePkg()
    const result: ComponentActionResult = {
      ...editResult(),
      operation: 'RESEARCH_REPLAN',
      patches: [],
      alternatives: [
        {
          provisionalExternalId: 'alt-flt-out-1',
          summary: 'Salida 20:45',
          option: {
            externalId: 'alt-flt-out-1',
            type: 'flight',
            status: 'researched',
            title: 'MEX → GDL alt',
            sourceType: 'agent',
            verificationStatus: 'estimated',
          },
          provenance: {
            sourceType: 'agent',
            verificationStatus: 'estimated',
          },
        },
      ],
    }
    const without = mergeComponentActionIntoPackage(pkg, {
      result,
      acceptedPatchComponentIds: [],
      acceptedImpactIds: [],
      acceptedAlternativeIds: [],
      currentRevision: 2,
    })
    assert.equal(without.travelOptions.length, 1)

    const withAlt = mergeComponentActionIntoPackage(pkg, {
      result,
      acceptedPatchComponentIds: [],
      acceptedImpactIds: [],
      acceptedAlternativeIds: ['alt-flt-out-1'],
      currentRevision: 2,
    })
    assert.equal(withAlt.travelOptions.length, 2)
    assert.equal(
      withAlt.travelOptions.find((o) => o.externalId === 'flt-out')?.status,
      'shortlisted',
    )
    assert.equal(
      withAlt.travelOptions.find((o) => o.externalId === 'alt-flt-out-1')
        ?.status,
      'researched',
    )
  })

  it('Usar esta opción promote demotes previous shortlisted', () => {
    const pkg = basePkg()
    const research: ComponentActionResult = {
      ...editResult(),
      operation: 'RESEARCH_REPLAN',
      patches: [],
      alternatives: [
        {
          provisionalExternalId: 'alt-flt-out-1',
          summary: 'Alt',
          option: {
            externalId: 'alt-flt-out-1',
            type: 'flight',
            status: 'researched',
            title: 'Alt',
            sourceType: 'agent',
            verificationStatus: 'estimated',
          },
          provenance: {
            sourceType: 'agent',
            verificationStatus: 'estimated',
          },
        },
      ],
    }
    const preview = buildPromotePreview(research, 'alt-flt-out-1')
    const merged = mergeComponentActionIntoPackage(pkg, {
      result: preview,
      acceptedPatchComponentIds: [],
      acceptedImpactIds: [],
      acceptedAlternativeIds: ['alt-flt-out-1'],
      promoteAlternativeId: 'alt-flt-out-1',
      currentRevision: 2,
    })
    assert.equal(
      merged.travelOptions.find((o) => o.externalId === 'alt-flt-out-1')?.status,
      'shortlisted',
    )
    assert.equal(
      merged.travelOptions.find((o) => o.externalId === 'flt-out')?.status,
      'researched',
    )
  })
})
