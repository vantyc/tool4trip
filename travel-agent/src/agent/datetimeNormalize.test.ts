import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { agentProposalSchema } from '../../shared/agentContracts.ts'
import type { AgentAskRequest } from '../../shared/agentContracts.ts'
import {
  applyZoneToWallClock,
  formatProposalValidationUserError,
  isIsoWithOffset,
  normalizeDatetimeField,
  normalizeProposalDatetimes,
  softDropInvalidDatetimePaths,
} from './datetimeNormalize.ts'
import { hydrateProposal } from './runtime.ts'

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/new-travel-sma-last-minute-2026-09.json',
)

describe('datetimeNormalize', () => {
  it('keeps valid Z', () => {
    const r = normalizeDatetimeField('2026-09-19T14:30:00Z', {
      path: 't',
      tripTimezone: 'America/Mexico_City',
    })
    assert.equal(r.dropped, false)
    assert.equal(r.value, '2026-09-19T14:30:00Z')
    assert.equal(isIsoWithOffset('2026-09-19T14:30:00Z'), true)
  })

  it('keeps valid offset', () => {
    const r = normalizeDatetimeField('2026-09-19T14:30:00-06:00', {
      path: 't',
      tripTimezone: 'America/Mexico_City',
    })
    assert.equal(r.dropped, false)
    assert.equal(r.value, '2026-09-19T14:30:00-06:00')
  })

  it('applies known zone to bare wall clock', () => {
    const applied = applyZoneToWallClock(
      '2026-09-19T14:30:00',
      'America/Mexico_City',
    )
    assert.ok(applied)
    assert.match(applied!, /2026-09-19T14:30:00/)
    assert.ok(isIsoWithOffset(applied!))
    const r = normalizeDatetimeField('2026-09-19T14:30:00', {
      path: 'lodge.startAt',
      tripTimezone: 'America/Mexico_City',
      placeHints: ['San Miguel el Alto'],
    })
    assert.equal(r.dropped, false)
    assert.ok(r.value && isIsoWithOffset(r.value))
  })

  it('drops date-only without inventing a time', () => {
    const r = normalizeDatetimeField('2026-09-19', {
      path: 'dueAt',
      tripTimezone: 'America/Mexico_City',
    })
    assert.equal(r.dropped, true)
    assert.equal(r.value, undefined)
    assert.match(r.warning ?? '', /omitido/i)
  })

  it('drops bare datetime when zone cannot be determined', () => {
    const r = normalizeDatetimeField('2026-09-19T14:30:00', {
      path: 'x',
      tripTimezone: '',
      placeHints: ['SomewhereUnknownXYZ'],
    })
    // Empty tripTimezone falls through; unknown place → drop
    assert.equal(r.dropped, true)
  })

  it('normalizes multiple defective fields in a package', () => {
    const { value, warnings } = normalizeProposalDatetimes({
      narrative: 't',
      warnings: [],
      package: {
        trip: {
          id: 't1',
          title: 'SMA',
          destination: 'San Miguel el Alto',
          startDate: '2026-09-19',
          endDate: '2026-09-22',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        travelOptions: [
          {
            externalId: 'a',
            type: 'lodging',
            status: 'researched',
            title: 'Hotel',
            startAt: '2026-09-19T20:00:00',
            endAt: '2026-09-22T12:00:00',
            sourceType: 'agent',
          },
          {
            externalId: 'b',
            type: 'flight',
            status: 'shortlisted',
            title: 'Vuelo',
            startAt: '2026-09-19T10:00:00Z',
            sourceType: 'agent',
          },
        ],
        itineraryItems: [
          {
            externalId: 'i1',
            title: 'Serenata',
            startAt: '2026-09-20T20:00:00',
          },
        ],
        checklistItems: [
          { externalId: 'c1', label: 'Due', dueAt: '2026-09-19' },
        ],
        notes: [],
      },
    })
    const pkg = (value as { package: Record<string, unknown> }).package
    const opts = pkg.travelOptions as Array<Record<string, unknown>>
    assert.ok(isIsoWithOffset(String(opts[0]!.startAt)))
    assert.ok(isIsoWithOffset(String(opts[0]!.endAt)))
    assert.equal(opts[1]!.startAt, '2026-09-19T10:00:00Z')
    const itin = pkg.itineraryItems as Array<Record<string, unknown>>
    assert.ok(isIsoWithOffset(String(itin[0]!.startAt)))
    const chk = pkg.checklistItems as Array<Record<string, unknown>>
    assert.equal(chk[0]!.dueAt, undefined)
    assert.ok(warnings.some((w) => /dueAt/i.test(w)))
  })

  it('soft-drops datetime paths from Zod-like issues', () => {
    const draft = {
      package: {
        travelOptions: [
          { title: 'A', startAt: 'bad' },
          { title: 'B', startAt: '2026-09-19T10:00:00Z' },
        ],
      },
    }
    const { value, warnings } = softDropInvalidDatetimePaths(draft, [
      {
        path: ['package', 'travelOptions', 0, 'startAt'],
        message: 'Datetime debe ser ISO 8601 con offset',
      },
    ])
    const opts = (value as { package: { travelOptions: Rec[] } }).package
      .travelOptions
    assert.equal(opts[0]!.startAt, undefined)
    assert.equal(opts[1]!.startAt, '2026-09-19T10:00:00Z')
    assert.ok(warnings.length >= 1)
  })

  it('formats user errors without raw Zod JSON', () => {
    const raw =
      'AgentProposal JSON inválido tras repair: [ { "code": "custom", "message": "Datetime debe ser ISO 8601 con offset", "path": [ "package", "travelOptions", 3, "startAt" ] } ]'
    const msg = formatProposalValidationUserError(raw)
    assert.match(msg, /Reintentar/)
    assert.ok(!msg.includes('"path"'))
    assert.ok(!msg.includes('travelOptions'))
  })
})

type Rec = Record<string, unknown>

describe('SMA last-minute fixture (prod regression)', () => {
  it('normalizes lodging bare datetimes and hydrates a valid proposal', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      prompt: string
      invalidDraft: Rec
    }
    assert.match(fixture.prompt, /San Miguel el Alto/)
    assert.match(fixture.prompt, /serenata/)

    const tripId = '00000000-0000-4000-8000-000000000099'
    const req: AgentAskRequest = {
      prompt: fixture.prompt,
      tripId,
      mode: 'new_travel',
      locale: 'es',
      context: {
        trip: {
          id: tripId,
          title: 'Nuevo viaje',
          startDate: '2026-01-01',
          endDate: '2026-01-02',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        bookings: [],
        travelOptions: [],
        itineraryItems: [],
        checklistItems: [],
        notes: [],
        packageImports: [],
      },
    }

    // Without normalize: Zod would reject travelOptions[3] bare times
    const bare = fixture.invalidDraft.package as Rec
    const lodge = (bare.travelOptions as Rec[])[3]!
    assert.equal(isIsoWithOffset(String(lodge.startAt)), false)
    assert.equal(isIsoWithOffset(String(lodge.endAt)), false)

    const { value, warnings } = normalizeProposalDatetimes(fixture.invalidDraft)
    const normPkg = (value as Rec).package as Rec
    const lodgeNorm = (normPkg.travelOptions as Rec[])[3]!
    assert.ok(isIsoWithOffset(String(lodgeNorm.startAt)))
    assert.ok(isIsoWithOffset(String(lodgeNorm.endAt)))
    assert.ok(warnings.some((w) => /zona|offset/i.test(w)))

    const hydrated = hydrateProposal(value, req, [], {
      intent: 'new_travel',
      serverWarnings: warnings,
    })
    const parsed = agentProposalSchema.safeParse(hydrated)
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message)
    if (!parsed.success) return
    const lodging = parsed.data.package.travelOptions.find(
      (o) => o.externalId === 'lodge-sma',
    )
    assert.ok(lodging)
    // Estimated lodging clocks are scrubbed (no inventable horario without provenance)
    assert.equal(lodging!.startAt, undefined)
    assert.equal(lodging!.endAt, undefined)
    assert.equal(lodging!.verificationStatus, 'estimated')
  })

  it('repair-like second pass: still bare after "repair" gets normalized', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      invalidDraft: Rec
    }
    // Simulate repair that forgot offsets again
    const repaired = structuredClone(fixture.invalidDraft)
    const opts = (repaired.package as Rec).travelOptions as Rec[]
    opts[3] = {
      ...opts[3]!,
      startAt: '2026-09-19T21:00:00',
      endAt: '2026-09-22T11:00:00',
    }
    const { value } = normalizeProposalDatetimes(repaired)
    const lodge = ((value as Rec).package as Rec).travelOptions as Rec[]
    assert.ok(isIsoWithOffset(String(lodge[3]!.startAt)))
    assert.ok(isIsoWithOffset(String(lodge[3]!.endAt)))
  })
})
