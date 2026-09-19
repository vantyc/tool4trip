import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { agentProposalSchema } from '../../shared/agentContracts.ts'
import {
  assertDraftGrounded,
  deriveEvidenceFromSource,
  filterAggregateFlightClaims,
  isDaySpecificFlightAsk,
  resolveClaimEvidence,
  scrubOperationalFreeText,
  scrubUngroundedConcreteFields,
  validateClaimsAgainstToolTrace,
  type AgentClaimLlm,
} from './claims.ts'
import { hydrateProposal } from './runtime.ts'
import type { AgentAskRequest } from '../../shared/agentContracts.ts'

const rome2rioAirportUrl =
  'https://www.rome2rio.com/es/s/Aeropuerto-GDL/Nueva-Central'
const reservamosUrl =
  'https://www.reservamos.mx/autobuses/primera-plus/a-san-miguel-el-alto'
const rome2rioCarUrl =
  'https://www.rome2rio.com/es/s/Guadalajara/Municipio-de-San-Miguel-el-Alto'

function toolTraceRealCases(): ToolTraceEntry[] {
  return [
    {
      tool: 'webSearch',
      ok: true,
      sources: [
        {
          url: rome2rioAirportUrl,
          title: 'Aeropuerto GDL → Central',
          snippet:
            'Aeropuerto Internacional De Guadalajara (GDL) a Central de autobuses Guadalajara JAL. cuesta $1 - $3 y dura 17 min.',
        },
      ],
      checkedAt: '2026-09-07T07:40:13+00:00',
    },
    {
      tool: 'webSearch',
      ok: true,
      sources: [
        {
          url: reservamosUrl,
          title: 'Boletos Primera Plus',
          snippet:
            'Son 0 las terminales de autobuses en San Miguel El Alto con salidas de Primera Plus, a continuación puedes ver las terminales.',
        },
      ],
      checkedAt: '2026-09-07T07:40:16+00:00',
    },
    {
      tool: 'webSearch',
      ok: true,
      sources: [
        {
          url: rome2rioCarUrl,
          title: 'Guadalajara → San Miguel el Alto',
          snippet:
            'La forma más rápida de llegar desde Guadalajara a Municipio de San Miguel el Alto es en coche que cuesta ₹1,200 - ₹1,800 y dura 1h 25min.',
        },
      ],
      checkedAt: '2026-09-07T07:40:16+00:00',
    },
  ]
}

function llmClaim(
  partial: Partial<AgentClaimLlm> &
    Pick<AgentClaimLlm, 'statement' | 'sourceUrl' | 'kind'>,
): AgentClaimLlm {
  return {
    verificationStatus: 'unverified',
    confidence: 'low',
    evidenceIndex: 0,
    ...partial,
  }
}

function sampleReq(): AgentAskRequest {
  return {
    prompt: 'x',
    tripId: 'trip-1',
    locale: 'es-MX',
    context: {
      trip: {
        id: 'trip-1',
        title: 'SMA',
        destination: 'San Miguel el Alto',
        startDate: '2026-09-25',
        endDate: '2026-10-01',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      bookings: [],
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
      packageImports: [{ id: 'pkg-1', revision: 1 }],
    },
  }
}

function baseDraft(over: Record<string, unknown> = {}) {
  return {
    narrative: 'Resumen sin hechos operativos de precio o modalidad.',
    warnings: [],
    claims: [],
    diffSummary: [],
    package: {
      schemaVersion: 1,
      packageId: 'pkg-1',
      revision: 2,
      generatedAt: '2026-09-07T00:00:00+00:00',
      trip: {
        id: 'trip-1',
        title: 'SMA',
        destination: 'San Miguel el Alto',
        startDate: '2026-09-25',
        endDate: '2026-10-01',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      travelOptions: [
        {
          externalId: 'opt-1',
          type: 'bus',
          status: 'researched',
          title: 'Opción de transporte',
          sourceType: 'agent',
          verificationStatus: 'unverified',
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    },
    ops: [],
    ...over,
  }
}

function finalize(draft: Record<string, unknown>, trace: ToolTraceEntry[]) {
  const g = assertDraftGrounded(draft, trace)
  assert.equal(g.ok, true, g.ok ? '' : g.message)
  if (!g.ok) throw new Error('expected ok')
  const hydrated = hydrateProposal(g.draft, sampleReq(), trace)
  const parsed = agentProposalSchema.safeParse(hydrated)
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message)
  return { g, proposal: parsed.data! }
}

describe('server-owned quotedFact (regression)', () => {
  const trace = toolTraceRealCases()

  it('1: sourceUrl válida + statement sustentado -> pass', () => {
    const result = validateClaimsAgainstToolTrace(
      [
        llmClaim({
          kind: 'price',
          statement: 'Trayecto cuesta $1 - $3 (modo no especificado)',
          sourceUrl: rome2rioAirportUrl,
        }),
      ],
      trace,
    )
    assert.equal(result.invalid.length, 0)
    assert.equal(result.valid.length, 1)
    assert.match(result.valid[0]!.quotedFact, /\$1 - \$3/)
  })

  it('2: precio no presente -> fail', () => {
    const result = validateClaimsAgainstToolTrace(
      [
        llmClaim({
          kind: 'price',
          statement: 'cuesta $99',
          sourceUrl: rome2rioAirportUrl,
        }),
      ],
      trace,
    )
    assert.equal(result.invalid[0]?.code, 'number_mismatch')
  })

  it('3: moneda distinta -> fail', () => {
    const result = validateClaimsAgainstToolTrace(
      [
        llmClaim({
          kind: 'price',
          statement: 'Transfer privado cuesta 1800 MXN',
          sourceUrl: rome2rioCarUrl,
        }),
      ],
      trace,
    )
    assert.equal(result.invalid[0]?.code, 'currency_mismatch')
  })

  it('4: taxi/Uber no mencionado -> fail', () => {
    const result = validateClaimsAgainstToolTrace(
      [
        llmClaim({
          kind: 'transport_mode',
          statement: 'taxi/Uber aeropuerto GDL a Nueva Central por $1 - $3',
          sourceUrl: rome2rioAirportUrl,
        }),
      ],
      trace,
    )
    assert.equal(result.invalid[0]?.code, 'transport_mode_ungrounded')
  })

  it('5: suspendido no mencionado -> fail', () => {
    const result = validateClaimsAgainstToolTrace(
      [
        llmClaim({
          kind: 'service_status',
          statement: 'Servicio Primera Plus suspendido temporalmente',
          sourceUrl: reservamosUrl,
        }),
      ],
      trace,
    )
    assert.equal(result.invalid[0]?.code, 'status_ungrounded')
  })

  it('6: LLM no puede imponer quotedFact arbitrario', () => {
    const poisoned = {
      kind: 'price' as const,
      statement: 'Trayecto cuesta $1 - $3',
      sourceUrl: rome2rioAirportUrl,
      evidenceIndex: 0,
      verificationStatus: 'verified' as const,
      confidence: 'high' as const,
      quotedFact: 'taxi/Uber confirmado por 1-3 USD inventado',
      sourceTitle: 'FAKE TITLE',
    }
    const g = assertDraftGrounded(
      baseDraft({
        narrative: 'Recomendación general sin cifras.',
        claims: [poisoned],
      }),
      trace,
    )
    assert.equal(g.ok, true)
    if (g.ok) {
      assert.equal(g.validClaims[0]!.sourceTitle, 'Aeropuerto GDL → Central')
      assert.doesNotMatch(
        g.validClaims[0]!.quotedFact,
        /inventado|taxi\/Uber confirmado/,
      )
    }
  })

  it('7: quotedFact se deriva del toolTrace real', () => {
    const resolved = resolveClaimEvidence(rome2rioAirportUrl, 0, trace)
    assert.equal(resolved.ok, true)
    if (resolved.ok) {
      const fromSource = deriveEvidenceFromSource({
        url: rome2rioAirportUrl,
        title: 'Aeropuerto GDL → Central',
        snippet:
          'Aeropuerto Internacional De Guadalajara (GDL) a Central de autobuses Guadalajara JAL. cuesta $1 - $3 y dura 17 min.',
      })
      assert.equal(resolved.quotedFact, fromSource.quotedFact)
    }
  })
})

describe('claims as single source of truth', () => {
  const trace = toolTraceRealCases()

  it('A: claim precio ₹1,800 -> package conserva ₹ / INR, jamás MXN', () => {
    const { proposal } = finalize(
      baseDraft({
        narrative: 'Te recomiendo revisar traslados terrestres con calma.',
        claims: [
          llmClaim({
            kind: 'price',
            statement: 'Coche estimado ₹1,800',
            sourceUrl: rome2rioCarUrl,
          }),
        ],
        package: {
          ...baseDraft().package,
          travelOptions: [
            {
              externalId: 'opt-car',
              type: 'transfer',
              status: 'researched',
              title: 'Traslado',
              description: 'Precio inventado 1800 MXN no grounded',
              priceObserved: 1800,
              currency: 'MXN',
              sourceType: 'agent',
              verificationStatus: 'unverified',
            },
          ],
        },
      }),
      trace,
    )
    const opt = proposal.package.travelOptions[0]!
    assert.equal(opt.currency, 'INR')
    assert.equal(opt.priceObserved, 1800)
    const blob = JSON.stringify(proposal)
    assert.match(blob, /₹1800|₹1,800|Precio observado \(claim\): ₹/)
    assert.doesNotMatch(blob, /1800 MXN|currency":"MXN"/)
  })

  it('B: sin claim service_status -> "confirmado" no aparece', () => {
    const { proposal } = finalize(
      baseDraft({
        narrative: 'No hay autobús directo confirmado desde Guadalajara.',
        warnings: ['Servicio confirmado según rumores'],
        claims: [],
        diffSummary: [
          {
            entityKind: 'travelOption',
            op: 'add',
            after: 'Ruta confirmado',
            note: 'estado confirmado',
          },
        ],
        package: {
          ...baseDraft().package,
          travelOptions: [
            {
              externalId: 'opt-1',
              type: 'bus',
              status: 'researched',
              title: 'Bus confirmado',
              description: 'No hay autobús directo confirmado',
              sourceType: 'agent',
              verificationStatus: 'unverified',
            },
          ],
        },
      }),
      trace,
    )
    const blob = JSON.stringify(proposal).toLowerCase()
    assert.equal(blob.includes('confirmado'), false)
  })

  it('C: narrative con "autobús confirmado" -> scrub', () => {
    assert.match(
      scrubOperationalFreeText(
        'Puedes explorar el centro. No hay autobús confirmado hoy.',
      ),
      /explorar el centro/i,
    )
    assert.doesNotMatch(
      scrubOperationalFreeText(
        'Puedes explorar el centro. No hay autobús confirmado hoy.',
      ),
      /confirmado/i,
    )
    const { proposal } = finalize(
      baseDraft({
        narrative:
          'Puedes explorar el centro. No hay autobús confirmado desde Guadalajara.',
        claims: [],
      }),
      trace,
    )
    assert.doesNotMatch(proposal.narrative, /confirmado/i)
  })

  it('D: package.description con precio no grounded -> removido', () => {
    const { proposal } = finalize(
      baseDraft({
        narrative: 'Revisa hospedaje en el centro.',
        claims: [],
        package: {
          ...baseDraft().package,
          travelOptions: [
            {
              externalId: 'opt-1',
              type: 'bus',
              status: 'researched',
              title: 'Bus',
              description: 'Costo estimado ₹1,200 - ₹1,800 en coche.',
              sourceType: 'agent',
              verificationStatus: 'unverified',
            },
          ],
        },
      }),
      trace,
    )
    const desc = proposal.package.travelOptions[0]?.description ?? ''
    assert.doesNotMatch(desc, /₹|1,800|1200/)
    assert.equal(proposal.package.travelOptions[0]?.priceObserved, undefined)
  })

  it('E: diffSummary con estado no grounded -> scrub', () => {
    const { proposal } = finalize(
      baseDraft({
        narrative: 'Sigue las fiestas locales con flexibilidad.',
        claims: [],
        diffSummary: [
          {
            entityKind: 'travelOption',
            op: 'add',
            after: 'Servicio suspendido',
            note: 'estado cancelado',
          },
        ],
      }),
      trace,
    )
    const blob = JSON.stringify(proposal.diffSummary).toLowerCase()
    assert.equal(blob.includes('suspendido'), false)
    assert.equal(blob.includes('cancelado'), false)
  })

  it('F: proposal final sin hechos operativos sin claim', () => {
    const { proposal } = finalize(
      baseDraft({
        narrative:
          'Resumen. taxi/Uber por $1-$3 y servicio suspendido y 1800 MXN.',
        warnings: ['confirmado: todo listo'],
        claims: [
          llmClaim({
            kind: 'price',
            statement: 'Trayecto cuesta $1 - $3',
            sourceUrl: rome2rioAirportUrl,
          }),
        ],
        package: {
          ...baseDraft().package,
          travelOptions: [
            {
              externalId: 'opt-1',
              type: 'transfer',
              status: 'researched',
              title: 'taxi confirmado',
              description: 'Uber $1-$3 o 1800 MXN',
              priceObserved: 99,
              currency: 'MXN',
              sourceType: 'agent',
              verificationStatus: 'unverified',
            },
          ],
        },
      }),
      trace,
    )
    const blob = JSON.stringify(proposal)
    assert.doesNotMatch(blob.toLowerCase(), /confirmado|suspendido|1800 mxn|taxi/)
    // price from grounded claim only
    assert.equal(proposal.package.travelOptions[0]?.currency, 'USD')
    assert.ok([1, 3].includes(proposal.package.travelOptions[0]?.priceObserved as number) ||
      proposal.package.travelOptions[0]?.priceObserved === 3 ||
      proposal.package.travelOptions[0]?.priceObserved === 1)
  })
})

describe('context entity id vs externalId', () => {
  const packageId = 'e7b872d0-2446-477a-8282-bc988d350bdc'
  const fullId = `opt-${packageId}-flight-outbound-1`
  const context = {
    trip: { id: 'trip-1', title: 'Guanatos' },
    bookings: [],
    travelOptions: [
      {
        id: fullId,
        tripId: 'trip-1',
        type: 'flight',
        status: 'researched',
        title: 'CDMX → GDL',
        externalId: 'flight-outbound-1',
        packageId,
      },
    ],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
    packageImports: [],
  }

  it('grounds when claim cites primary id (not short externalId)', () => {
    const result = validateClaimsAgainstToolTrace(
      [
        {
          kind: 'fact',
          statement: 'CDMX → GDL',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: fullId,
          field: 'title',
          verificationStatus: 'unverified',
          confidence: 'high',
        },
      ],
      [],
      context,
    )
    assert.equal(result.invalid.length, 0, JSON.stringify(result.invalid))
    assert.equal(result.valid.length, 1)
  })

  it('still grounds when claim cites short externalId', () => {
    const result = validateClaimsAgainstToolTrace(
      [
        {
          kind: 'fact',
          statement: 'CDMX → GDL',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'flight-outbound-1',
          field: 'title',
          verificationStatus: 'unverified',
          confidence: 'high',
        },
      ],
      [],
      context,
    )
    assert.equal(result.invalid.length, 0, JSON.stringify(result.invalid))
    assert.equal(result.valid.length, 1)
  })
})

describe('day-specific flight ask vs weekly aggregate', () => {
  it('detects day-specific flight prompts', () => {
    assert.equal(
      isDaySpecificFlightAsk(
        'que vuelos hay desde cdmx a guadalajara este 15 de septiembre de 2026',
      ),
      true,
    )
    assert.equal(isDaySpecificFlightAsk('opciones de hospedaje en GDL'), false)
  })

  it('drops weekly aggregate claims for day-specific asks', () => {
    const prompt =
      'que vuelos hay desde cdmx a guadalajara este 15 de septiembre de 2026'
    const filtered = filterAggregateFlightClaims(
      [
        {
          kind: 'other_factual',
          statement:
            'Hay 591 vuelos por semana de Ciudad de México a Guadalajara en septiembre de 2026',
          sourceType: 'web',
          sourceUrl: 'https://example.com/cdmx-gdl',
          evidenceIndex: 0,
          sourceTitle: 'CDMX-GDL',
          quotedFact:
            'Hay 591 vuelos por semana de Ciudad de México a Guadalajara en septiembre.',
          verificationStatus: 'verified',
          confidence: 'high',
        },
      ],
      prompt,
    )
    assert.equal(filtered.kept.length, 0)
    assert.ok(filtered.warnings.some((w) => /omitido agregado/i.test(w)))
    assert.ok(filtered.warnings.some((w) => /fecha pedida/i.test(w)))

    const draft = baseDraft({
      claims: [
        {
          kind: 'other_factual',
          statement:
            'Hay 591 vuelos por semana de Ciudad de México a Guadalajara',
          sourceType: 'web',
          sourceUrl: 'https://example.com/cdmx-gdl',
          evidenceIndex: 0,
          verificationStatus: 'verified',
          confidence: 'high',
        },
      ],
      package: {
        schemaVersion: 1,
        packageId: 'pkg-1',
        revision: 1,
        trip: {
          id: 'trip-1',
          title: 'SMA',
          startDate: '2026-09-15',
          endDate: '2026-09-16',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        travelOptions: [],
        itineraryItems: [],
        checklistItems: [],
        notes: [],
      },
    })
    const trace: ToolTraceEntry[] = [
      {
        tool: 'webSearch',
        ok: true,
        sources: [
          {
            url: 'https://example.com/cdmx-gdl',
            title: 'CDMX-GDL',
            snippet:
              'Hay 591 vuelos por semana de Ciudad de México a Guadalajara.',
          },
        ],
        checkedAt: '2026-09-07T00:00:00+00:00',
      },
    ]
    const g = assertDraftGrounded(draft, trace, undefined, {
      userPrompt: prompt,
    })
    assert.equal(g.ok, true, g.ok ? '' : g.message)
    if (!g.ok) throw new Error('expected ok')
    assert.equal(g.validClaims.length, 0)
    const warnings = (g.draft.warnings as string[]).join('\n')
    assert.match(warnings, /omitido agregado/)
    assert.match(warnings, /fecha pedida/)
    assert.doesNotMatch(warnings, /server: evidencia \(other_factual\): Hay 591/)
  })

  it('skeleton: strips estimated price/schedule without provenance; keeps verified', () => {
    const draft = {
      narrative: 'esqueleto',
      warnings: [],
      diffSummary: [],
      ops: [],
      claims: [],
      package: {
        schemaVersion: 1,
        packageId: 'pkg-skel',
        revision: 1,
        trip: {
          id: 't1',
          title: 'SMA',
          startDate: '2026-09-19',
          endDate: '2026-09-22',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        travelOptions: [
          {
            externalId: 'flt-est',
            type: 'flight',
            status: 'researched',
            title: 'MEX→GDL estimado',
            origin: 'MEX',
            destination: 'GDL',
            startAt: '2026-09-19T10:00:00-06:00',
            priceObserved: 1999,
            currency: 'MXN',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
          {
            externalId: 'flt-ver',
            type: 'flight',
            status: 'shortlisted',
            title: 'MEX→GDL verificado',
            origin: 'MEX',
            destination: 'GDL',
            startAt: '2026-09-19T11:00:00-06:00',
            priceObserved: 1800,
            currency: 'MXN',
            verificationStatus: 'verified',
            sourceType: 'agent',
            sourceUrl: 'https://example.com/flight',
          },
        ],
        itineraryItems: [
          {
            externalId: 'goal-serenata',
            title: 'Serenata',
            startAt: '2026-09-20T20:00:00-06:00',
            notes: 'pendiente',
          },
        ],
        checklistItems: [],
        notes: [],
      },
    }
    const g = assertDraftGrounded(draft, [], undefined, {
      allowSkeletonPackage: true,
    })
    assert.equal(g.ok, true)
    if (!g.ok) throw new Error('expected ok')
    const opts = (
      g.draft.package as {
        travelOptions: Array<Record<string, unknown>>
        itineraryItems: Array<Record<string, unknown>>
      }
    ).travelOptions
    const est = opts.find((o) => o.externalId === 'flt-est')!
    const ver = opts.find((o) => o.externalId === 'flt-ver')!
    assert.equal(est.startAt, undefined)
    assert.equal(est.priceObserved, undefined)
    assert.equal(est.currency, undefined)
    assert.equal(ver.startAt, '2026-09-19T11:00:00-06:00')
    assert.equal(ver.priceObserved, 1800)
    const itin = (
      g.draft.package as { itineraryItems: Array<Record<string, unknown>> }
    ).itineraryItems[0]!
    assert.equal(itin.startAt, undefined)
    assert.match(String(itin.notes), /2026-09-20/)
  })

  it('scrubUngroundedConcreteFields is idempotent on already-clean package', () => {
    const draft = {
      package: {
        travelOptions: [
          {
            externalId: 'x',
            type: 'flight',
            title: 'X',
            verificationStatus: 'estimated',
          },
        ],
        itineraryItems: [],
      },
    }
    const w1 = scrubUngroundedConcreteFields(draft, { scrubItineraryClocks: true })
    const w2 = scrubUngroundedConcreteFields(draft, { scrubItineraryClocks: true })
    assert.equal(w1.length, 0)
    assert.equal(w2.length, 0)
  })
})
