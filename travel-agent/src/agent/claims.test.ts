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
  statementIncludesContextValue,
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
            externalId: 'flt-sched',
            type: 'flight',
            status: 'shortlisted',
            title: 'MEX→GDL horario publicado',
            origin: 'MEX',
            destination: 'GDL',
            startAt: '2026-09-19T06:00:00-06:00',
            endAt: '2026-09-19T07:18:00-06:00',
            provider: 'Volaris',
            verificationStatus: 'estimated',
            sourceType: 'flight_schedule',
            sourceUrl:
              'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-19&flight=Y4140',
            notes: 'HORARIO PUBLICADO',
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
    const sched = opts.find((o) => o.externalId === 'flt-sched')!
    const ver = opts.find((o) => o.externalId === 'flt-ver')!
    assert.equal(est.startAt, undefined)
    assert.equal(est.priceObserved, undefined)
    assert.equal(est.currency, undefined)
    assert.equal(sched.startAt, '2026-09-19T06:00:00-06:00')
    assert.equal(sched.endAt, '2026-09-19T07:18:00-06:00')
    assert.equal(sched.sourceType, 'flight_schedule')
    assert.equal(ver.startAt, '2026-09-19T11:00:00-06:00')
    assert.equal(ver.priceObserved, 1800)
    const itin = (
      g.draft.package as { itineraryItems: Array<Record<string, unknown>> }
    ).itineraryItems[0]!
    assert.equal(itin.startAt, undefined)
    assert.match(String(itin.notes), /2026-09-20/)
  })

  it('new_travel skeleton drops invalid evidenceIndex claims instead of failing closed', () => {
    const url = 'https://example.com/hotel'
    const toolTrace = [
      {
        tool: 'webSearch' as const,
        args: { query: 'hotel', provider: 'tavily' },
        ok: true,
        sources: [{ url, title: 'Hotel', snippet: 'Hotel San Miguel contacto' }],
        checkedAt: '2026-09-19T18:00:00+00:00',
      },
    ]
    const draft = {
      narrative: 'Viaje.',
      warnings: [],
      claims: [
        {
          kind: 'other_factual',
          statement: 'Hotel San Miguel',
          sourceType: 'web',
          sourceUrl: url,
          evidenceIndex: 1, // out of range — only 1 source at URL
          verificationStatus: 'verified',
          confidence: 'high',
        },
      ],
      package: {
        travelOptions: [
          {
            externalId: 'lodge-1',
            type: 'lodging',
            status: 'researched',
            title: 'Hotel San Miguel',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
        ],
        itineraryItems: [],
        checklistItems: [],
        notes: [],
      },
      ops: [],
    }
    const g = assertDraftGrounded(draft, toolTrace, undefined, {
      allowSkeletonPackage: true,
    })
    assert.equal(g.ok, true)
    if (!g.ok) throw new Error('expected ok')
    assert.equal((g.draft.claims as unknown[]).length, 0)
    assert.ok(
      g.serverWarnings.some((w) =>
        /claim\[0\] no grounded \(evidence_index_invalid\)/.test(w),
      ),
    )
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

describe('Ask Travel searchFlightSchedules context grounding', () => {
  const checkedAt = '2026-09-20T18:00:00+00:00'
  const scheduleUrl2 =
    'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-20&flight=AM212'
  const scheduleUrl3 =
    'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-20&flight=Y4152'
  const scheduleUrl4 =
    'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-20&flight=AM222'

  function scheduleTrace(): ToolTraceEntry[] {
    return [
      {
        tool: 'searchFlightSchedules',
        args: {
          origin: 'MEX',
          destination: 'GDL',
          date: '2026-09-20',
          provider: 'aerodatabox',
          flights: [
            {
              origin: 'MEX',
              destination: 'GDL',
              departureAt: '2026-09-20T11:30:00-06:00',
              arrivalAt: '2026-09-20T12:55:00-06:00',
              carrierCode: 'AM',
              carrierName: 'Aeromexico',
              flightNumber: 'AM212',
              sourceUrl: scheduleUrl2,
              checkedAt,
            },
            {
              origin: 'MEX',
              destination: 'GDL',
              departureAt: '2026-09-20T13:00:00-06:00',
              arrivalAt: '2026-09-20T14:25:00-06:00',
              carrierCode: 'Y4',
              carrierName: 'Volaris',
              flightNumber: 'Y4152',
              sourceUrl: scheduleUrl3,
              checkedAt,
            },
            {
              origin: 'MEX',
              destination: 'GDL',
              departureAt: '2026-09-20T14:30:00-06:00',
              arrivalAt: '2026-09-20T15:55:00-06:00',
              carrierCode: 'AM',
              carrierName: 'Aeromexico',
              flightNumber: 'AM222',
              sourceUrl: scheduleUrl4,
              checkedAt,
            },
          ],
        },
        ok: true,
        sources: [
          { url: scheduleUrl2, title: 'AM AM212 MEX→GDL', snippet: 'dep 2026-09-20T11:30:00-06:00' },
          { url: scheduleUrl3, title: 'Y4 Y4152 MEX→GDL', snippet: 'dep 2026-09-20T13:00:00-06:00' },
          { url: scheduleUrl4, title: 'AM AM222 MEX→GDL', snippet: 'dep 2026-09-20T14:30:00-06:00' },
        ],
        checkedAt,
      },
    ]
  }

  function emptyAskContext(): AgentAskRequest['context'] {
    return {
      trip: {
        id: 'trip-ask-1',
        title: 'Viaje existente',
        startDate: '2026-09-20',
        endDate: '2026-09-22',
        timezone: 'America/Mexico_City',
        status: 'planned',
        goals: [],
      },
      bookings: [],
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
      packageImports: [],
    }
  }

  function packageWithOutboundFlights() {
    return {
      schemaVersion: 1,
      packageId: 'agent-trip-ask-1',
      revision: 1,
      trip: {
        id: 'trip-ask-1',
        title: 'Viaje existente',
        startDate: '2026-09-20',
        endDate: '2026-09-22',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      travelOptions: [
        {
          externalId: 'outbound-flight-2',
          type: 'flight',
          status: 'researched',
          title: 'AM212 MEX→GDL 11:30',
          provider: 'Aeromexico',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-20T11:30:00-06:00',
          endAt: '2026-09-20T12:55:00-06:00',
          verificationStatus: 'estimated',
          sourceType: 'agent',
        },
        {
          externalId: 'outbound-flight-3',
          type: 'flight',
          status: 'researched',
          title: 'Y4152 MEX→GDL 13:00',
          provider: 'Volaris',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-20T13:00:00-06:00',
          endAt: '2026-09-20T14:25:00-06:00',
          verificationStatus: 'estimated',
          sourceType: 'agent',
        },
        {
          externalId: 'outbound-flight-4',
          type: 'flight',
          status: 'researched',
          title: 'AM222 MEX→GDL 14:30',
          provider: 'Aeromexico',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-20T14:30:00-06:00',
          endAt: '2026-09-20T15:55:00-06:00',
          verificationStatus: 'estimated',
          sourceType: 'agent',
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    }
  }

  it('reproduces context_entity_missing without schedule registration (baseline)', () => {
    // Direct validateClaimsAgainstToolTrace WITHOUT augment — exact failure mode
    const result = validateClaimsAgainstToolTrace(
      [
        {
          kind: 'schedule',
          statement: 'AM212 MEX→GDL 11:30',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'outbound-flight-2',
          field: 'title',
          verificationStatus: 'estimated',
          confidence: 'high',
        },
        {
          kind: 'schedule',
          statement: 'Y4152 MEX→GDL 13:00',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'outbound-flight-3',
          field: 'title',
          verificationStatus: 'estimated',
          confidence: 'high',
        },
        {
          kind: 'schedule',
          statement: 'AM222 MEX→GDL 14:30',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'outbound-flight-4',
          field: 'title',
          verificationStatus: 'estimated',
          confidence: 'high',
        },
      ],
      scheduleTrace(),
      emptyAskContext(),
    )
    assert.equal(result.valid.length, 0)
    assert.equal(result.invalid.length, 3)
    for (const v of result.invalid) {
      assert.equal(v.code, 'context_entity_missing')
      assert.match(v.message, /outbound-flight-[234] not in context/)
    }
  })

  it('Ask Travel: schedule-backed package options ground context claims (no bypass)', () => {
    const draft = {
      narrative: 'Opciones de horario publicado MEX→GDL el 20 sep 2026 entre 11:00 y 15:00.',
      warnings: [],
      diffSummary: [],
      ops: [],
      claims: [
        {
          kind: 'schedule',
          statement: 'AM212 MEX→GDL 11:30',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'outbound-flight-2',
          field: 'title',
          verificationStatus: 'estimated',
          confidence: 'high',
        },
        {
          kind: 'schedule',
          statement: 'Y4152 MEX→GDL 13:00',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'outbound-flight-3',
          field: 'title',
          verificationStatus: 'estimated',
          confidence: 'high',
        },
        {
          kind: 'schedule',
          statement: 'AM222 MEX→GDL 14:30',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'outbound-flight-4',
          field: 'title',
          verificationStatus: 'estimated',
          confidence: 'high',
        },
      ],
      package: packageWithOutboundFlights(),
    }
    const g = assertDraftGrounded(draft, scheduleTrace(), emptyAskContext(), {
      allowSkeletonPackage: false,
      userPrompt:
        'Vuelos directos MEX a GDL el 2026-09-20 entre las 11:00 y las 15:00',
    })
    assert.equal(g.ok, true, g.ok ? '' : JSON.stringify(g))
    if (!g.ok) throw new Error('expected ok')
    assert.equal(g.validClaims.length, 3)
    const opts = (
      g.draft.package as { travelOptions: Array<Record<string, unknown>> }
    ).travelOptions
    for (const id of [
      'outbound-flight-2',
      'outbound-flight-3',
      'outbound-flight-4',
    ]) {
      const o = opts.find((x) => x.externalId === id)!
      assert.equal(o.sourceType, 'flight_schedule')
      assert.equal(o.verificationStatus, 'estimated')
      assert.ok(typeof o.startAt === 'string' && /T\d{2}:\d{2}/.test(o.startAt))
      assert.ok(typeof o.sourceUrl === 'string' && /^https?:\/\//.test(o.sourceUrl))
      assert.match(String(o.notes), /HORARIO PUBLICADO/)
    }
  })

  it('fabricated flight context claim still fails context_entity_missing', () => {
    const draft = {
      narrative: 'Invented flight',
      warnings: [],
      diffSummary: [],
      ops: [],
      claims: [
        {
          kind: 'schedule',
          statement: 'ZZ999 MEX→GDL 12:00',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'outbound-flight-fake',
          field: 'title',
          verificationStatus: 'estimated',
          confidence: 'high',
        },
      ],
      package: {
        ...packageWithOutboundFlights(),
        travelOptions: [
          {
            externalId: 'outbound-flight-fake',
            type: 'flight',
            status: 'researched',
            title: 'ZZ999 MEX→GDL 12:00',
            provider: 'FakeAir',
            origin: 'MEX',
            destination: 'GDL',
            // Clock NOT in searchFlightSchedules results
            startAt: '2026-09-20T12:00:00-06:00',
            endAt: '2026-09-20T13:20:00-06:00',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
        ],
      },
    }
    const g = assertDraftGrounded(draft, scheduleTrace(), emptyAskContext(), {
      allowSkeletonPackage: false,
    })
    assert.equal(g.ok, false)
    if (g.ok) throw new Error('expected fail')
    assert.equal(g.code, 'ungrounded_claims')
    assert.ok(
      g.violations.some(
        (v) =>
          v.code === 'context_entity_missing' &&
          /outbound-flight-fake/.test(v.message),
      ),
      JSON.stringify(g.violations),
    )
  })

  it('webSearch grounding still requires toolTrace sourceUrl (unchanged)', () => {
    const draft = {
      narrative: 'Hotel',
      warnings: [],
      diffSummary: [],
      ops: [],
      claims: [
        {
          kind: 'other_factual',
          statement: 'Hotel centro',
          sourceType: 'web',
          sourceUrl: 'https://example.com/hotel-not-in-trace',
          evidenceIndex: 0,
          verificationStatus: 'verified',
          confidence: 'high',
        },
      ],
      package: {
        schemaVersion: 1,
        packageId: 'p',
        revision: 1,
        trip: {
          id: 't',
          title: 't',
          startDate: '2026-09-20',
          endDate: '2026-09-22',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        travelOptions: [],
        itineraryItems: [],
        checklistItems: [],
        notes: [],
      },
    }
    const g = assertDraftGrounded(
      draft,
      scheduleTrace(),
      emptyAskContext(),
      { allowSkeletonPackage: false },
    )
    assert.equal(g.ok, false)
    if (g.ok) throw new Error('expected fail')
    assert.ok(
      g.violations.some((v) => v.code === 'source_url_missing'),
      JSON.stringify(g.violations),
    )
  })

  /**
   * Production Ask Travel personalization (trip bd4d0e9a…): context_statement_mismatch
   * after 57df5c6. LLM wrote natural Spanish clocks; Dexie/schedule startAt is ISO.
   * Exact statements + values from live diagnosis 2026-09-20.
   */
  it('prod regression: natural Spanish startAt matches ISO schedule-backed value', () => {
    // claim[0] statement (exact) vs matching schedule-backed startAt
    const stmt0 =
      'Vuelos directos MEX → GDL para el 25 de septiembre 2026 con salida entre 11:00 y 15:00, incluyendo vuelo AM222 con salida a las 11:15 y llegada a las 12:52.'
    const matchingStart0 = '2026-09-25T11:15:00-06:00'
    const obsoleteDexie0 = '2026-09-20T07:00:00-06:00'

    assert.equal(
      statementIncludesContextValue(stmt0, matchingStart0),
      true,
      'natural Spanish must ground matching ISO startAt',
    )
    assert.equal(
      statementIncludesContextValue(stmt0, obsoleteDexie0),
      false,
      'must NOT ground against obsolete Dexie startAt (contradiction)',
    )

    // claim[1] statement (exact) vs matching / obsolete
    const stmt1 =
      'Vuelo directo GDL → MEX para el 28 de septiembre 2026, vuelo Y4149 con salida a las 06:02 y llegada a las 07:25.'
    const matchingStart1 = '2026-09-28T06:02:00-06:00'
    const obsoleteDexie1 = '2026-09-22T12:00:00-06:00'

    assert.equal(statementIncludesContextValue(stmt1, matchingStart1), true)
    assert.equal(statementIncludesContextValue(stmt1, obsoleteDexie1), false)

    // Wrong clock same day still fails
    assert.equal(
      statementIncludesContextValue(
        'Vuelo MEX→GDL el 25 de septiembre 2026 con salida a las 14:00',
        matchingStart0,
      ),
      false,
    )
  })

  it('prod regression: context_statement_mismatch path via validateClaimsAgainstToolTrace', () => {
    const am222Url =
      'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-25&flight=AM222'
    const y4149Url =
      'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-09-28&flight=Y4149'
    const checked = '2026-09-20T00:55:20+00:00'

    const ctx: AgentAskRequest['context'] = {
      ...emptyAskContext(),
      travelOptions: [
        {
          id: 'opt-bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28-outbound-flight-1',
          tripId: 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28',
          type: 'flight',
          status: 'researched',
          title: 'Vuelo estimado directo MEX → GDL el domingo 20 de septiembre 2026',
          provider: 'Aeromexico',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-20T07:00:00-06:00',
          endAt: '2026-09-20T08:20:00-06:00',
          externalId: 'outbound-flight-1',
          verificationStatus: 'estimated',
          sourceType: 'agent',
        },
        {
          id: 'opt-bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28-return-flight-1',
          tripId: 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28',
          type: 'flight',
          status: 'researched',
          title: 'Vuelo estimado directo GDL → MEX el martes 22 de septiembre 2026',
          provider: 'Volaris',
          origin: 'GDL',
          destination: 'MEX',
          startAt: '2026-09-22T12:00:00-06:00',
          endAt: '2026-09-22T13:25:00-06:00',
          externalId: 'return-flight-1',
          verificationStatus: 'estimated',
          sourceType: 'agent',
        },
      ],
    }

    const claim0: AgentClaimLlm = {
      kind: 'schedule',
      statement:
        'Vuelos directos MEX → GDL para el 25 de septiembre 2026 con salida entre 11:00 y 15:00, incluyendo vuelo AM222 con salida a las 11:15 y llegada a las 12:52.',
      sourceType: 'context',
      entityType: 'travelOption',
      entityId: 'opt-bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28-outbound-flight-1',
      field: 'startAt',
      verificationStatus: 'estimated',
      confidence: 'high',
    }
    const claim1: AgentClaimLlm = {
      kind: 'schedule',
      statement:
        'Vuelo directo GDL → MEX para el 28 de septiembre 2026, vuelo Y4149 con salida a las 06:02 y llegada a las 07:25.',
      sourceType: 'context',
      entityType: 'travelOption',
      entityId: 'opt-bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28-return-flight-1',
      field: 'startAt',
      verificationStatus: 'estimated',
      confidence: 'high',
    }

    // Exact production failure mode: Dexie entities + natural statements → mismatch
    // (contradiction: statement describes Sep 25/28 clocks, Dexie has Sep 20/22)
    const againstDexie = validateClaimsAgainstToolTrace(
      [claim0, claim1],
      [],
      ctx,
    )
    assert.equal(againstDexie.valid.length, 0)
    assert.equal(againstDexie.invalid.length, 2)
    assert.ok(
      againstDexie.invalid.every((v) => v.code === 'context_statement_mismatch'),
      JSON.stringify(againstDexie.invalid),
    )

    // Same natural statements against schedule-backed matching startAt → pass
    const scheduleBackedCtx: AgentAskRequest['context'] = {
      ...emptyAskContext(),
      travelOptions: [
        {
          id: 'outbound-flight-am222',
          tripId: 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28',
          type: 'flight',
          status: 'researched',
          title: 'AM222 MEX→GDL 11:15',
          provider: 'Aeromexico',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-25T11:15:00-06:00',
          endAt: '2026-09-25T12:52:00-06:00',
          externalId: 'outbound-flight-am222',
          verificationStatus: 'estimated',
          sourceType: 'flight_schedule',
          sourceUrl: am222Url,
          notes: 'HORARIO PUBLICADO — no confirma asientos ni tarifa.',
        },
        {
          id: 'return-flight-y4149',
          tripId: 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28',
          type: 'flight',
          status: 'researched',
          title: 'Y4149 GDL→MEX 06:02',
          provider: 'Volaris',
          origin: 'GDL',
          destination: 'MEX',
          startAt: '2026-09-28T06:02:00-06:00',
          endAt: '2026-09-28T07:25:00-06:00',
          externalId: 'return-flight-y4149',
          verificationStatus: 'estimated',
          sourceType: 'flight_schedule',
          sourceUrl: y4149Url,
          notes: 'HORARIO PUBLICADO — no confirma asientos ni tarifa.',
        },
      ],
    }
    const againstSchedule = validateClaimsAgainstToolTrace(
      [
        { ...claim0, entityId: 'outbound-flight-am222' },
        { ...claim1, entityId: 'return-flight-y4149' },
      ],
      [
        {
          tool: 'searchFlightSchedules',
          ok: true,
          checkedAt: checked,
          args: { origin: 'MEX', destination: 'GDL', date: '2026-09-25' },
          sources: [
            {
              url: am222Url,
              title: 'AM AM222 MEX→GDL',
              snippet:
                'dep 2026-09-25T11:15:00-06:00 arr 2026-09-25T12:52:00-06:00 (salida 11:15, llegada 12:52) · date 2026-09-25 · published schedule only',
            },
          ],
        },
      ],
      scheduleBackedCtx,
    )
    assert.equal(againstSchedule.invalid.length, 0, JSON.stringify(againstSchedule.invalid))
    assert.equal(againstSchedule.valid.length, 2)

    // Fabricated entity still fails
    const fabricated = validateClaimsAgainstToolTrace(
      [
        {
          ...claim0,
          entityId: 'outbound-flight-does-not-exist',
        },
      ],
      [],
      scheduleBackedCtx,
    )
    assert.equal(fabricated.valid.length, 0)
    assert.equal(fabricated.invalid[0]?.code, 'context_entity_missing')

    // LLM often labels schedule claims as sourceType=web while citing the
    // schedule-backed package entityId — accept via context when statement matches.
    const webLabeled = validateClaimsAgainstToolTrace(
      [
        {
          ...claim0,
          sourceType: 'web',
          entityId: 'outbound-flight-am222',
          sourceUrl: am222Url,
          evidenceIndex: 0,
        },
        {
          ...claim1,
          sourceType: 'web',
          entityId: 'return-flight-y4149',
          sourceUrl: y4149Url,
          evidenceIndex: 0,
        },
      ],
      [
        {
          tool: 'searchFlightSchedules',
          ok: true,
          checkedAt: checked,
          args: {},
          sources: [
            {
              url: am222Url,
              title: 'AM AM222',
              snippet: 'dep 2026-09-25T11:15:00-06:00',
            },
          ],
        },
      ],
      scheduleBackedCtx,
    )
    assert.equal(webLabeled.invalid.length, 0, JSON.stringify(webLabeled.invalid))
    assert.equal(webLabeled.valid.length, 2)
    assert.ok(webLabeled.valid.every((c) => c.sourceType === 'context'))

    // web + obsolete Dexie entity (statement contradicts startAt) must NOT
    // silently pass context; falls through — and still fails if web evidence
    // lacks required numbers/modes (snippet too thin here).
    const webObsolete = validateClaimsAgainstToolTrace(
      [
        {
          ...claim0,
          sourceType: 'web',
          sourceUrl: am222Url,
          evidenceIndex: 0,
        },
      ],
      [
        {
          tool: 'searchFlightSchedules',
          ok: true,
          checkedAt: checked,
          args: {},
          sources: [
            {
              url: am222Url,
              title: 'AM AM222',
              snippet: 'dep 2026-09-25T11:15:00-06:00',
            },
          ],
        },
      ],
      ctx,
    )
    assert.equal(webObsolete.valid.length, 0)
    assert.ok(
      webObsolete.invalid.some(
        (v) =>
          v.code === 'number_mismatch' ||
          v.code === 'transport_mode_ungrounded',
      ),
      JSON.stringify(webObsolete.invalid),
    )

    // When Dexie still has outbound-flight-1 with obsolete clocks, but package
    // reuses that externalId with schedule-backed Sep 25 clocks, grounding must
    // prefer the schedule value (Ask Travel date update).
    const collidingCtx: AgentAskRequest['context'] = {
      ...emptyAskContext(),
      travelOptions: [
        {
          id: 'opt-bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28-outbound-flight-1',
          tripId: 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28',
          type: 'flight',
          status: 'researched',
          title: 'Old Dexie outbound',
          provider: 'Aeromexico',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-20T07:00:00-06:00',
          endAt: '2026-09-20T08:20:00-06:00',
          externalId: 'outbound-flight-1',
          verificationStatus: 'estimated',
          sourceType: 'agent',
        },
      ],
    }
    const collidingPkg = {
      schemaVersion: 1,
      packageId: 'agent-bd4d0e9a',
      revision: 2,
      trip: {
        id: 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28',
        title: 'SMA',
        startDate: '2026-09-25',
        endDate: '2026-09-28',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      travelOptions: [
        {
          externalId: 'outbound-flight-1',
          type: 'flight',
          status: 'researched',
          title: 'AM222 MEX→GDL 11:15',
          provider: 'Aeromexico',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-25T11:15:00-06:00',
          endAt: '2026-09-25T12:52:00-06:00',
          verificationStatus: 'estimated',
          sourceType: 'flight_schedule',
          sourceUrl: am222Url,
          notes: 'HORARIO PUBLICADO',
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    }
    const collidingTrace: ToolTraceEntry[] = [
      {
        tool: 'searchFlightSchedules',
        ok: true,
        checkedAt: checked,
        args: {
          origin: 'MEX',
          destination: 'GDL',
          date: '2026-09-25',
          flights: [
            {
              origin: 'MEX',
              destination: 'GDL',
              departureAt: '2026-09-25T11:15:00-06:00',
              arrivalAt: '2026-09-25T12:52:00-06:00',
              carrierCode: 'AM',
              flightNumber: 'AM222',
              sourceUrl: am222Url,
              checkedAt: checked,
            },
          ],
        },
        sources: [
          {
            url: am222Url,
            title: 'AM AM222',
            snippet:
              'vuelo AM222 MEX→GDL · dep 2026-09-25T11:15:00-06:00 (salida 11:15)',
          },
        ],
      },
    ]
    const collidingDraft = {
      narrative: 'Actualización de fechas',
      warnings: [],
      diffSummary: [],
      ops: [],
      claims: [
        {
          kind: 'schedule',
          statement:
            'Vuelos directos MEX → GDL para el 25 de septiembre 2026 con salida entre 11:00 y 15:00, incluyendo vuelo AM222 con salida a las 11:15 y llegada a las 12:52.',
          sourceType: 'context',
          entityType: 'travelOption',
          entityId: 'outbound-flight-1',
          field: 'startAt',
          verificationStatus: 'estimated',
          confidence: 'high',
        },
      ],
      package: collidingPkg,
    }
    const gCollide = assertDraftGrounded(
      collidingDraft,
      collidingTrace,
      collidingCtx,
      {
        allowSkeletonPackage: false,
        userPrompt:
          'Cambia las fechas del viaje al viernes 25 de septiembre de 2026. Busca vuelos directos MEX a GDL.',
      },
    )
    assert.equal(
      gCollide.ok,
      true,
      gCollide.ok ? '' : JSON.stringify(gCollide),
    )
  })
})
