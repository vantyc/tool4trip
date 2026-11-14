import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { assertDraftGrounded, type AgentClaimLlm } from './claims.ts'
import { claimTargetOption, phonesEquivalent } from './entityEvidence.ts'

/**
 * "consigue los teléfonos de hoteles en Totatiche": snippets as returned by
 * webSearch in the real job. Phones and claims must stay on their own hotel.
 */

const JARDIN_URL = 'https://mexico.pueblosamerica.com/h/hotel-jardin-16'
const RAFA_URL = 'https://mexico.pueblosamerica.com/h/hotel-y-restaurant-el-oasis'
const RAFA_FB_URL = 'https://www.facebook.com/p/Hotel-y-Restaurant-Don-Rafa-100063474224834'
const EXPEDIA_URL = 'https://www.expedia.mx/Totatiche.dx553248635640666087'
const FLIGHT_URL =
  'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-10-01&flight=Y4140'

function trace(): ToolTraceEntry[] {
  return [
    {
      tool: 'webSearch',
      ok: true,
      checkedAt: '2026-09-30T17:20:00+00:00',
      sources: [
        {
          url: JARDIN_URL,
          title: 'Hotel JardÍn en Totatiche: Teléfono, Mapa y Opiniones',
          snippet:
            'Pueblos de México → Jalisco → Totatiche → Totatiche\n\n# Hotel JardÍn (Totatiche)\n\n⭐ Sé el primero en opinar   📞 Llamar: +52 4379640079   💲 Añadir precios',
        },
        {
          url: RAFA_URL,
          title: 'Hotel Y Restaurant Don Rafa en Totatiche: Teléfono, Mapa y Opiniones',
          snippet:
            'Pueblos de México → Jalisco → Totatiche → Totatiche\n\n# Hotel Y Restaurant Don Rafa\n\n⭐ Sé el primero en opinar   📞 Llamar: +52 4379640054   💲 Añadir precios',
        },
        {
          url: RAFA_FB_URL,
          title: 'Hotel y Restaurant "Don Rafa" | Totatiche',
          snippet: 'Hotel resort · $$ · +52 437 964 0054 Follow +52 437 964 0054 Contact info Photos',
        },
        {
          url: EXPEDIA_URL,
          title: 'Totatiche turismo | Viaja con Expedia',
          snippet:
            '### Hotel Riu Plaza Guadalajara\n\nAv. Lopez Mateos 830 Col. Chapalita Guadalajara JAL\n\nEl precio es de $2,150 MXN por noche del 18 oct al 19 oct',
        },
      ],
    },
  ]
}

function phoneClaim(statement: string, sourceUrl: string, extra: Partial<AgentClaimLlm> = {}): AgentClaimLlm {
  return {
    kind: 'other_factual',
    statement,
    sourceType: 'web',
    sourceUrl,
    evidenceIndex: 0,
    verificationStatus: 'unverified',
    confidence: 'medium',
    ...extra,
  }
}

const JARDIN_CLAIM = () =>
  phoneClaim('Teléfono del Hotel Jardín en Totatiche: +52 4379640079', JARDIN_URL)
const RAFA_CLAIM = () =>
  phoneClaim('Teléfono del Hotel y Restaurant Don Rafa en Totatiche: +52 4379640054', RAFA_URL)

function flight() {
  return {
    externalId: 'outbound-flight-20261001-y4140',
    type: 'flight',
    status: 'researched',
    title: 'Opción de salida',
    sourceType: 'agent',
    sourceUrl: FLIGHT_URL,
    verificationStatus: 'unverified',
  }
}

function hotel(externalId: string, title: string, phone: string | undefined, sourceUrl?: string) {
  return {
    externalId,
    type: 'lodging',
    status: 'researched',
    title,
    destination: 'Totatiche, Jalisco',
    ...(phone !== undefined ? { phone } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    sourceType: 'agent',
    verificationStatus: 'unverified',
  }
}

function draft(travelOptions: Record<string, unknown>[], claims: AgentClaimLlm[]) {
  return {
    narrative: 'Hoteles en Totatiche para contactar directamente.',
    warnings: [],
    claims,
    diffSummary: [],
    package: {
      schemaVersion: 1,
      packageId: 'pkg-1',
      revision: 2,
      generatedAt: '2026-09-30T00:00:00+00:00',
      trip: {
        id: 'trip-1',
        title: 'Totatiche',
        destination: 'Totatiche, Jalisco',
        startDate: '2026-10-01',
        endDate: '2026-10-08',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      travelOptions,
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    },
    ops: [],
  }
}

function ground(d: Record<string, unknown>) {
  const g = assertDraftGrounded(d, trace())
  assert.equal(g.ok, true, g.ok ? '' : g.message)
  if (!g.ok) throw new Error('expected ok')
  const options = (g.draft.package as { travelOptions: Record<string, unknown>[] }).travelOptions
  const byId = new Map(options.map((o) => [o.externalId as string, o]))
  return { g, byId }
}

describe('lodging candidate claims and phones', () => {
  it('E: a hotel phone claim lands on that hotel, never on the flight', () => {
    const { byId } = ground(
      draft(
        [flight(), hotel('hotel-jardin', 'Hotel Jardín', '+52 4379640079', JARDIN_URL)],
        [JARDIN_CLAIM()],
      ),
    )
    assert.doesNotMatch(String(byId.get('outbound-flight-20261001-y4140')!.notes ?? ''), /Tel[ée]fono|4379640079/)
    assert.match(String(byId.get('hotel-jardin')!.notes ?? ''), /4379640079/)
  })

  it('F: a claim with no matching option is kept as evidence only, not on options[0]', () => {
    const { g, byId } = ground(draft([flight()], [JARDIN_CLAIM(), RAFA_CLAIM()]))
    assert.equal(byId.get('outbound-flight-20261001-y4140')!.notes, undefined)
    assert.ok(g.serverWarnings.some((w) => w.includes('evidencia (other_factual)') && w.includes('4379640079')))
    assert.ok(g.serverWarnings.some((w) => w.includes('4379640054')))
  })

  it('F: an entityId naming a missing option or several options attaches nowhere', () => {
    const options = [flight(), hotel('hotel-jardin', 'Hotel Jardín', undefined, JARDIN_URL)]
    assert.equal(
      claimTargetOption({ sourceType: 'web', sourceUrl: JARDIN_URL, entityType: 'travelOption', entityId: 'hotel-otro' }, options),
      undefined,
    )
    assert.equal(
      claimTargetOption({ sourceType: 'web', sourceUrl: JARDIN_URL }, [
        ...options,
        hotel('hotel-jardin-2', 'Hotel Jardín (anexo)', undefined, JARDIN_URL),
      ]),
      undefined,
    )
    assert.equal(
      claimTargetOption({ sourceType: 'web', sourceUrl: JARDIN_URL }, options)?.externalId,
      'hotel-jardin',
    )
  })

  it('F: an unlinked price claim no longer lands on options[0]', () => {
    const { g, byId } = ground(
      draft([flight()], [
        {
          ...phoneClaim('Hotel Riu Plaza Guadalajara: $2,150 MXN por noche', EXPEDIA_URL),
          kind: 'price',
        },
      ]),
    )
    const f = byId.get('outbound-flight-20261001-y4140')!
    assert.equal(f.priceObserved, undefined)
    assert.notEqual(f.verificationStatus, 'verified')
    assert.ok(g.serverWarnings.some((w) => w.includes('evidencia (price)')))
  })

  it('G: a phone backed by its own source is kept (formatting/country code ignored)', () => {
    const { g, byId } = ground(
      draft(
        [
          hotel('hotel-jardin', 'Hotel Jardín', '437-964-0079', JARDIN_URL),
          hotel('hotel-don-rafa', 'Hotel y Restaurant Don Rafa', '+524379640054', RAFA_FB_URL),
        ],
        [],
      ),
    )
    assert.equal(byId.get('hotel-jardin')!.phone, '437-964-0079')
    assert.equal(byId.get('hotel-don-rafa')!.phone, '+524379640054')
    assert.ok(!g.serverWarnings.some((w) => /teléfono sin evidencia/.test(w)))
  })

  it('H: a phone absent from its source, or with no source, is removed with a warning', () => {
    const { g, byId } = ground(
      draft(
        [
          hotel('hotel-jardin', 'Hotel Jardín', '+52 4379640099', JARDIN_URL),
          hotel('hotel-sin-fuente', 'Posada Centro', '+52 4379640011'),
        ],
        [],
      ),
    )
    assert.equal(byId.get('hotel-jardin')!.phone, undefined)
    assert.equal(byId.get('hotel-sin-fuente')!.phone, undefined)
    const w = g.serverWarnings.filter((x) => /teléfono sin evidencia/.test(x))
    assert.equal(w.length, 2)
    assert.ok(w.some((x) => x.includes('hotel-jardin')))
    assert.ok((g.draft.warnings as string[]).some((x) => /teléfono sin evidencia/.test(x)))
  })

  it('I: two hotels keep their own phones; a swapped phone is dropped', () => {
    const { byId } = ground(
      draft(
        [
          flight(),
          hotel('hotel-jardin', 'Hotel Jardín', '+52 4379640079', JARDIN_URL),
          hotel('hotel-don-rafa', 'Hotel y Restaurant Don Rafa', '+52 4379640054', RAFA_URL),
        ],
        [JARDIN_CLAIM(), RAFA_CLAIM()],
      ),
    )
    const jardin = byId.get('hotel-jardin')!
    const rafa = byId.get('hotel-don-rafa')!
    assert.equal(jardin.phone, '+52 4379640079')
    assert.equal(rafa.phone, '+52 4379640054')
    assert.doesNotMatch(String(jardin.notes ?? ''), /4379640054/)
    assert.doesNotMatch(String(rafa.notes ?? ''), /4379640079/)

    const swapped = ground(
      draft([hotel('hotel-jardin', 'Hotel Jardín', '+52 4379640054', JARDIN_URL)], []),
    )
    assert.equal(swapped.byId.get('hotel-jardin')!.phone, undefined)
  })

  it('phone equivalence needs the same number, not a shared suffix', () => {
    assert.ok(phonesEquivalent('+52 437 964 0079', '4379640079'))
    assert.ok(phonesEquivalent('(437) 964-0079', '+52 1 437 964 0079'))
    assert.ok(!phonesEquivalent('+52 4379640079', '+52 4379640054'))
    assert.ok(!phonesEquivalent('9640079', '+52 4379640079'))
  })
})
