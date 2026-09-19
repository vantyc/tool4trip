/**
 * Interactive TripPanel — scoped component actions.
 * EDIT / RESEARCH_REPLAN / VERIFY with provenance gates (no full package regen).
 */
import { randomUUID } from 'node:crypto'
import {
  componentActionResultSchema,
  type AgentAskRequest,
  type AlternativeOption,
  type ComponentActionPayload,
  type ComponentActionResult,
  type EntityPatch,
  type ImpactSuggestion,
  type ProvenanceHistoryEntry,
  type ProvenanceStamp,
  type ToolTraceEntry,
} from '../../shared/agentContracts.ts'
import type { AgentRuntimeDeps } from './runtime.ts'
import type { ChatMessage } from '../llm/types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { registerTravelTools } from '../tools/travelTools.ts'

export type ComponentActionRunResult = {
  componentActionResult: ComponentActionResult
  meta: {
    steps: number
    llmCalls: number
    lastFinishReason: string | null
    usage: { inputTokens: number; outputTokens: number; totalTokens: number }
    hadRepair: boolean
    finalContentChars: number
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** Server gate: EDIT never verified / never web sourceUrl. */
export function forceUserSuppliedProvenance(
  after: Record<string, unknown>,
  fields: string[],
  instruction: string,
): { after: Record<string, unknown>; provenance: ProvenanceStamp; history: ProvenanceHistoryEntry } {
  const next = { ...after }
  next.sourceType = 'manual'
  next.verificationStatus = 'unverified'
  delete next.sourceUrl
  delete next.checkedAt
  const noteLine = `Dato del viajero: ${instruction.trim().slice(0, 200)}`
  const prevNotes = str(next.notes)
  next.notes = prevNotes
    ? prevNotes.includes('Dato del viajero:')
      ? prevNotes
      : `${prevNotes}\n${noteLine}`
    : noteLine
  const at = nowIso().replace(/\.\d{3}Z$/, 'Z')
  return {
    after: next,
    provenance: {
      sourceType: 'manual',
      verificationStatus: 'unverified',
      note: noteLine,
    },
    history: {
      at,
      event: 'user_edit',
      sourceType: 'manual',
      verificationStatus: 'unverified',
      fields,
      note: noteLine,
    },
  }
}

export function resolveOperationFromIntent(
  intent: ComponentActionPayload['actionIntent'],
  classified?: 'EDIT' | 'RESEARCH_REPLAN' | 'VERIFY',
): 'EDIT' | 'RESEARCH_REPLAN' | 'VERIFY' {
  if (intent === 'verify') return 'VERIFY'
  if (intent === 'find_alternative') return 'RESEARCH_REPLAN'
  if (classified === 'EDIT' || classified === 'RESEARCH_REPLAN') return classified
  // Safe default for adjust without classification: research (never invent EDIT facts)
  return 'RESEARCH_REPLAN'
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fence?.[1]?.trim() ?? trimmed
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('No JSON object in model output')
  return JSON.parse(raw.slice(start, end + 1))
}

async function classifyAdjustOperation(
  instruction: string,
  deps: AgentRuntimeDeps,
): Promise<'EDIT' | 'RESEARCH_REPLAN'> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'Classify the traveler instruction for a trip component action.',
        'Return ONLY JSON: {"operation":"EDIT"|"RESEARCH_REPLAN","reason":"…"}',
        'EDIT = user states/corrects a concrete fact about THIS component (e.g. "my flight leaves at 19:40").',
        'RESEARCH_REPLAN = user asks to find/change/prefer another option (e.g. "find a flight after 19:40").',
        'Do not use tools. No markdown.',
      ].join('\n'),
    },
    { role: 'user', content: instruction },
  ]
  const result = await deps.llm.chat({
    messages,
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' },
  })
  const raw = result.message.content ?? '{}'
  try {
    const parsed = asRec(extractJsonObject(raw))
    const op = str(parsed.operation).toUpperCase()
    if (op === 'EDIT') return 'EDIT'
    return 'RESEARCH_REPLAN'
  } catch {
    return 'RESEARCH_REPLAN'
  }
}

/** LLM extracts only fields the user asserted (EDIT). */
async function extractEditFields(
  ca: ComponentActionPayload,
  deps: AgentRuntimeDeps,
): Promise<{
  fields: Record<string, unknown>
  narrative: string
  impacts: Array<{
    componentId: string
    componentKind: string
    relation: string
    reason: string
  }>
}> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You extract ONLY facts the traveler explicitly stated about the target component.',
        'Return JSON: {"fields":{...},"narrative":"…","impacts":[{"componentId","componentKind","relation","reason"}]}',
        'Allowed field keys: startAt, endAt, priceObserved, currency, title, notes, origin, destination, provider.',
        'startAt/endAt MUST be ISO 8601 with offset if set (use trip timezone).',
        'If the user did not state a concrete clock/price, OMIT that field.',
        'Do NOT invent schedules, fares, or availability.',
        'impacts: dependent components that may need user approval (airport arrival, lodging nights, transfers).',
        'componentId for impacts must come from relatedSnapshots when possible.',
        'No tools. No markdown.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: ca.instruction,
        tripHeader: ca.tripHeader,
        target: ca.snapshot,
        relatedSnapshots: ca.relatedSnapshots,
      }),
    },
  ]
  const result = await deps.llm.chat({
    messages,
    temperature: 0,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
  })
  const parsed = asRec(extractJsonObject(result.message.content ?? '{}'))
  const fields = asRec(parsed.fields)
  const impactsRaw = Array.isArray(parsed.impacts) ? parsed.impacts : []
  const impacts = impactsRaw
    .map((i) => {
      const r = asRec(i)
      return {
        componentId: str(r.componentId),
        componentKind: str(r.componentKind, 'travelOption'),
        relation: str(r.relation, 'other'),
        reason: str(r.reason, 'Posible impacto'),
      }
    })
    .filter((i) => i.componentId)
  return {
    fields,
    narrative: str(parsed.narrative, 'Actualización con dato del viajero.'),
    impacts,
  }
}

function isoOk(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) &&
    (/[+-]\d{2}:\d{2}$/.test(v) || /Z$/i.test(v))
  ) {
    return v
  }
  return undefined
}

function applyExtractedFields(
  snapshot: Record<string, unknown>,
  fields: Record<string, unknown>,
): { after: Record<string, unknown>; changedFields: string[] } {
  const after = { ...snapshot }
  const changed: string[] = []
  const allow = [
    'startAt',
    'endAt',
    'priceObserved',
    'currency',
    'title',
    'notes',
    'origin',
    'destination',
    'provider',
  ] as const
  for (const k of allow) {
    if (!(k in fields)) continue
    if (k === 'startAt' || k === 'endAt') {
      const iso = isoOk(fields[k])
      if (!iso) continue
      after[k] = iso
      changed.push(k)
      continue
    }
    if (k === 'priceObserved') {
      const n = Number(fields[k])
      if (!Number.isFinite(n) || n < 0) continue
      after[k] = n
      changed.push(k)
      continue
    }
    if (k === 'currency') {
      const c = str(fields[k]).toUpperCase()
      if (!/^[A-Z]{3}$/.test(c)) continue
      after[k] = c
      changed.push(k)
      continue
    }
    const s = str(fields[k])
    if (!s) continue
    after[k] = s
    changed.push(k)
  }
  return { after, changedFields: changed }
}

function buildAirportImpact(
  ca: ComponentActionPayload,
  flightAfter: Record<string, unknown>,
): ImpactSuggestion | null {
  if (!isoOk(flightAfter.startAt)) return null
  const id = `airport-arrival-desk-${ca.componentId}`
  return {
    impactId: `imp-airport-${ca.componentId}`,
    componentId: id,
    componentKind: 'itineraryItem',
    relation: 'airport_arrival',
    reason:
      'Recalcular arribo al aeropuerto según la nueva hora de salida del vuelo.',
    severity: 'warning',
    requiresUserChoice: true,
  }
}

async function runToolsBrief(
  query: string,
  deps: AgentRuntimeDeps,
): Promise<ToolTraceEntry[]> {
  if (!deps.cfg.enableWebTools) return []
  const registry =
    deps.createRegistry?.() ??
    (() => {
      const r = new ToolRegistry()
      registerTravelTools(r, {
        enableWebTools: deps.cfg.enableWebTools,
        webSearchProvider: deps.cfg.webSearchProvider,
        enableDdgFallback: deps.cfg.enableDdgFallback,
      })
      return r
    })()
  const trace: ToolTraceEntry[] = []
  try {
    const out = await registry.execute(
      'webSearch',
      JSON.stringify({ query, max_results: 5 }),
      {},
    )
    trace.push(out.trace)
  } catch (err) {
    trace.push({
      tool: 'webSearch',
      ok: false,
      sources: [],
      error: err instanceof Error ? err.message : 'webSearch failed',
      checkedAt: nowIso(),
      args: { query },
    })
  }
  return trace
}

async function handleEdit(
  ca: ComponentActionPayload,
  deps: AgentRuntimeDeps,
  meta: { llmCalls: number },
): Promise<ComponentActionResult> {
  const extracted = await extractEditFields(ca, deps)
  meta.llmCalls += 1
  const snap = asRec(ca.snapshot)
  const { after: merged, changedFields } = applyExtractedFields(
    snap,
    extracted.fields,
  )
  const warnings: string[] = []
  if (changedFields.length === 0) {
    warnings.push(
      'No se extrajo ningún dato concreto de la instrucción; no hay cambios que aplicar.',
    )
  }
  const forced = forceUserSuppliedProvenance(
    merged,
    changedFields,
    ca.instruction ?? '',
  )
  const patches: EntityPatch[] =
    changedFields.length === 0
      ? []
      : [
          {
            componentId: ca.componentId,
            componentKind: ca.componentKind,
            op: 'update',
            before: snap,
            after: forced.after,
            changedFields: [
              ...changedFields,
              'sourceType',
              'verificationStatus',
              'notes',
            ],
            provenance: forced.provenance,
            provenanceHistoryAppend: [forced.history],
          },
        ]

  const impacts: ImpactSuggestion[] = extracted.impacts.map((i, idx) => ({
    impactId: `imp-${idx}-${i.componentId}`,
    componentId: i.componentId,
    componentKind: (['travelOption', 'itineraryItem', 'checklistItem', 'note'].includes(
      i.componentKind,
    )
      ? i.componentKind
      : 'travelOption') as ImpactSuggestion['componentKind'],
    relation: i.relation,
    reason: i.reason,
    severity: 'warning' as const,
    requiresUserChoice: true,
  }))
  if (
    ca.componentType === 'flight' &&
    changedFields.includes('startAt') &&
    !impacts.some((i) => i.relation === 'airport_arrival')
  ) {
    const air = buildAirportImpact(ca, forced.after)
    if (air) impacts.push(air)
  }

  return {
    resultId: randomUUID(),
    createdAt: nowIso(),
    operation: 'EDIT',
    actionIntent: ca.actionIntent,
    target: {
      componentId: ca.componentId,
      entityId: ca.entityId,
      componentKind: ca.componentKind,
      componentType: ca.componentType,
    },
    baseRevision: ca.baseRevision,
    expectedRevisionOnApply: ca.baseRevision + 1,
    narrative: extracted.narrative,
    warnings,
    diffSummary:
      changedFields.length === 0
        ? []
        : [
            {
              entityKind: ca.componentKind,
              entityRef: ca.componentId,
              op: 'update',
              before: changedFields
                .map((f) => `${f}=${String(snap[f] ?? '—')}`)
                .join('; '),
              after: changedFields
                .map((f) => `${f}=${String(forced.after[f] ?? '—')}`)
                .join('; '),
              note: 'EDIT — dato del viajero (no verificado)',
            },
          ],
    patches,
    alternatives: [],
    impacts,
    toolTrace: [],
    ops: [],
    contextSource: ca.contextSource,
  }
}

async function handleVerify(
  ca: ComponentActionPayload,
  deps: AgentRuntimeDeps,
  meta: { llmCalls: number },
): Promise<ComponentActionResult> {
  const snap = asRec(ca.snapshot)
  const title = str(snap.title, ca.componentId)
  const startAt = str(snap.startAt)
  const query = [
    title,
    str(snap.origin),
    str(snap.destination),
    startAt ? `horario ${startAt}` : '',
    ca.instruction ?? 'verificar',
  ]
    .filter(Boolean)
    .join(' ')
  const toolTrace = await runToolsBrief(query, deps)
  const hasSources = toolTrace.some((t) => t.ok && (t.sources?.length ?? 0) > 0)

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'VERIFY a travel component against toolTrace sources.',
        'Return JSON: {"verified":boolean,"narrative":"…","warnings":[],"sourceUrl":string|null,"confirmedStartAt":string|null}',
        'verified=true ONLY if toolTrace snippets clearly support the existing fact.',
        'If evidence is missing or conflicting: verified=false. Do NOT invent schedules.',
        'No markdown.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({ target: snap, toolTrace, instruction: ca.instruction }),
    },
  ]
  const result = await deps.llm.chat({
    messages,
    temperature: 0,
    max_tokens: 800,
    response_format: { type: 'json_object' },
  })
  meta.llmCalls += 1
  const parsed = asRec(extractJsonObject(result.message.content ?? '{}'))
  const verified = parsed.verified === true && hasSources
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === 'string')
    : []
  const sourceUrl =
    typeof parsed.sourceUrl === 'string' && /^https?:\/\//i.test(parsed.sourceUrl)
      ? parsed.sourceUrl
      : toolTrace[0]?.sources?.[0]?.url

  if (!verified) {
    warnings.push(
      'VERIFY fail-closed: no hay evidencia suficiente en toolTrace para marcar como verificado.',
    )
    return {
      resultId: randomUUID(),
      createdAt: nowIso(),
      operation: 'VERIFY',
      actionIntent: ca.actionIntent,
      target: {
        componentId: ca.componentId,
        entityId: ca.entityId,
        componentKind: ca.componentKind,
        componentType: ca.componentType,
      },
      baseRevision: ca.baseRevision,
      expectedRevisionOnApply: ca.baseRevision + 1,
      narrative: str(parsed.narrative, 'No se pudo verificar con fuentes actuales.'),
      warnings,
      diffSummary: [],
      patches: [],
      alternatives: [],
      impacts: [],
      toolTrace,
      ops: [],
      contextSource: ca.contextSource,
    }
  }

  const after = { ...snap }
  after.verificationStatus = 'verified'
  after.sourceType = 'agent'
  if (sourceUrl) after.sourceUrl = sourceUrl
  after.checkedAt = nowIso().replace(/\.\d{3}Z$/, 'Z')
  const confirmIso = isoOk(parsed.confirmedStartAt)
  if (confirmIso) after.startAt = confirmIso
  const prevNotes = str(after.notes)
  after.notes = prevNotes
    ? `${prevNotes}\nVerificado externamente${sourceUrl ? `: ${sourceUrl}` : ''}`
    : `Verificado externamente${sourceUrl ? `: ${sourceUrl}` : ''}`

  const at = String(after.checkedAt)
  const history: ProvenanceHistoryEntry[] = []
  if (str(snap.sourceType) === 'manual' || str(snap.verificationStatus) === 'unverified') {
    history.push({
      at,
      event: 'user_edit',
      sourceType: 'manual',
      verificationStatus: 'unverified',
      fields: startAt ? ['startAt'] : [],
      note: 'Aporte previo del viajero conservado en historial',
    })
  }
  history.push({
    at,
    event: 'verify_ok',
    sourceType: 'agent',
    verificationStatus: 'verified',
    sourceUrl: sourceUrl || undefined,
    fields: ['verificationStatus', 'sourceUrl', 'checkedAt'],
    note: 'Verificación externa grounded en toolTrace',
  })

  const provenance: ProvenanceStamp = {
    sourceType: 'agent',
    verificationStatus: 'verified',
    sourceUrl: sourceUrl || undefined,
    checkedAt: at,
    note: 'Verificado externamente',
  }

  return {
    resultId: randomUUID(),
    createdAt: nowIso(),
    operation: 'VERIFY',
    actionIntent: ca.actionIntent,
    target: {
      componentId: ca.componentId,
      entityId: ca.entityId,
      componentKind: ca.componentKind,
      componentType: ca.componentType,
    },
    baseRevision: ca.baseRevision,
    expectedRevisionOnApply: ca.baseRevision + 1,
    narrative: str(parsed.narrative, 'Componente verificado con fuente externa.'),
    warnings,
    diffSummary: [
      {
        entityKind: ca.componentKind,
        entityRef: ca.componentId,
        op: 'update',
        before: `${str(snap.verificationStatus, '—')} / ${str(snap.sourceType, '—')}`,
        after: `verified / agent${sourceUrl ? ` / ${sourceUrl}` : ''}`,
        note: 'VERIFY ok — historial de dato del viajero conservado en notes',
      },
    ],
    patches: [
      {
        componentId: ca.componentId,
        componentKind: ca.componentKind,
        op: 'update',
        before: snap,
        after,
        changedFields: [
          'verificationStatus',
          'sourceType',
          'sourceUrl',
          'checkedAt',
          'notes',
        ],
        provenance,
        provenanceHistoryAppend: history,
      },
    ],
    alternatives: [],
    impacts: [],
    toolTrace,
    ops: [],
    contextSource: ca.contextSource,
  }
}

async function handleResearch(
  ca: ComponentActionPayload,
  deps: AgentRuntimeDeps,
  meta: { llmCalls: number },
): Promise<ComponentActionResult> {
  const snap = asRec(ca.snapshot)
  const title = str(snap.title, ca.componentId)
  const query = [
    ca.instruction ?? 'alternativa',
    title,
    str(snap.origin),
    str(snap.destination),
    ca.tripHeader.startDate,
    ca.tripHeader.endDate,
  ]
    .filter(Boolean)
    .join(' ')
  const toolTrace = await runToolsBrief(query, deps)

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'Propose RESEARCH alternatives for the target travel component.',
        'Return JSON: {"narrative":"…","warnings":[],"alternatives":[{"summary","title","startAt?","endAt?","origin?","destination?","priceObserved?","currency?","sourceUrl?","notes?"}]}',
        'Do NOT modify the current selection. Alternatives are additive only (status researched).',
        'Only include concrete startAt/price if present in toolTrace; otherwise omit.',
        'sourceUrl only if from toolTrace. No markdown.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: ca.instruction,
        target: snap,
        tripHeader: ca.tripHeader,
        toolTrace,
      }),
    },
  ]
  const result = await deps.llm.chat({
    messages,
    temperature: 0.2,
    max_tokens: 1600,
    response_format: { type: 'json_object' },
  })
  meta.llmCalls += 1
  const parsed = asRec(extractJsonObject(result.message.content ?? '{}'))
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === 'string')
    : []
  const altsRaw = Array.isArray(parsed.alternatives) ? parsed.alternatives : []
  const traceUrls = new Set(
    toolTrace.flatMap((t) => (t.sources ?? []).map((s) => s.url).filter(Boolean) as string[]),
  )

  const alternatives: AlternativeOption[] = []
  altsRaw.forEach((raw, i) => {
    const a = asRec(raw)
    const altTitle = str(a.title, `Alternativa ${i + 1}`)
    const provisionalExternalId =
      `alt-${ca.componentId}-${i + 1}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120)
    const startAt = isoOk(a.startAt)
    const endAt = isoOk(a.endAt)
    const sourceUrl =
      typeof a.sourceUrl === 'string' && traceUrls.has(a.sourceUrl)
        ? a.sourceUrl
        : undefined
    const price =
      typeof a.priceObserved === 'number' && Number.isFinite(a.priceObserved)
        ? a.priceObserved
        : undefined
    const currency = str(a.currency).toUpperCase()
    const currencyOk = /^[A-Z]{3}$/.test(currency) ? currency : undefined
    // Scrub inventables without provenance
    const option: AlternativeOption['option'] = {
      externalId: provisionalExternalId,
      type: (str(snap.type, ca.componentType) || 'other') as AlternativeOption['option']['type'],
      status: 'researched',
      title: altTitle,
      sourceType: 'agent',
      verificationStatus: sourceUrl ? 'verified' : 'estimated',
      notes: [
        str(a.notes),
        'Alternativa propuesta — no sustituye la selección actual. Usa «Usar esta opción» para promover.',
      ]
        .filter(Boolean)
        .join(' '),
    }
    if (str(a.origin) || str(snap.origin)) {
      option.origin = str(a.origin) || str(snap.origin) || undefined
    }
    if (str(a.destination) || str(snap.destination)) {
      option.destination = str(a.destination) || str(snap.destination) || undefined
    }
    if (startAt && sourceUrl) option.startAt = startAt
    if (endAt && sourceUrl) option.endAt = endAt
    if (price !== undefined && currencyOk && sourceUrl) {
      option.priceObserved = price
      option.currency = currencyOk
    }
    if (sourceUrl) {
      option.sourceUrl = sourceUrl
      option.checkedAt = nowIso().replace(/\.\d{3}Z$/, 'Z')
    }
    alternatives.push({
      provisionalExternalId,
      summary: str(a.summary, altTitle),
      option,
      provenance: {
        sourceType: 'agent',
        verificationStatus: sourceUrl ? 'verified' : 'estimated',
        sourceUrl,
        checkedAt: option.checkedAt,
        note: 'Alternativa researched — no promocionada',
      },
    })
  })

  if (alternatives.length === 0) {
    warnings.push(
      'No se encontraron alternativas utilizables (sin evidencia concreta o sin resultados).',
    )
  }

  return {
    resultId: randomUUID(),
    createdAt: nowIso(),
    operation: 'RESEARCH_REPLAN',
    actionIntent: ca.actionIntent,
    target: {
      componentId: ca.componentId,
      entityId: ca.entityId,
      componentKind: ca.componentKind,
      componentType: ca.componentType,
    },
    baseRevision: ca.baseRevision,
    expectedRevisionOnApply: ca.baseRevision + 1,
    narrative: str(
      parsed.narrative,
      'Alternativas investigadas; la opción actual no se sustituye automáticamente.',
    ),
    warnings,
    diffSummary: alternatives.map((a) => ({
      entityKind: 'travelOption' as const,
      entityRef: a.provisionalExternalId,
      op: 'add' as const,
      before: '—',
      after: a.summary,
      note: 'RESEARCH — add only; current selection unchanged',
    })),
    patches: [], // never mutate target on RESEARCH
    alternatives,
    impacts: [],
    toolTrace,
    ops: alternatives.map((a) => ({
      op: 'add' as const,
      entityKind: 'travelOption' as const,
      externalId: a.provisionalExternalId,
      note: 'alternativa researched',
    })),
    contextSource: ca.contextSource,
  }
}

export async function runComponentAction(
  req: AgentAskRequest,
  deps: AgentRuntimeDeps,
): Promise<ComponentActionRunResult> {
  const ca = req.componentAction
  if (!ca) {
    throw new Error('componentAction payload required')
  }

  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const meta = { llmCalls: 0 }
  let operation = resolveOperationFromIntent(ca.actionIntent)
  if (ca.actionIntent === 'adjust') {
    operation = await classifyAdjustOperation(ca.instruction ?? '', deps)
    meta.llmCalls += 1
  }

  let result: ComponentActionResult
  if (operation === 'EDIT') {
    result = await handleEdit(ca, deps, meta)
  } else if (operation === 'VERIFY') {
    result = await handleVerify(ca, deps, meta)
  } else {
    result = await handleResearch(ca, deps, meta)
  }

  const parsed = componentActionResultSchema.safeParse(result)
  if (!parsed.success) {
    throw new Error(
      `componentActionResult schema: ${parsed.error.message.slice(0, 500)}`,
    )
  }

  return {
    componentActionResult: parsed.data,
    meta: {
      steps: meta.llmCalls,
      llmCalls: meta.llmCalls,
      lastFinishReason: 'stop',
      usage,
      hadRepair: false,
      finalContentChars: JSON.stringify(parsed.data).length,
    },
  }
}
