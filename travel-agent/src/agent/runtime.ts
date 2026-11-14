import { randomUUID } from 'node:crypto'
import {
  agentProposalSchema,
  type AgentAskRequest,
  type AgentProposal,
  type ToolTraceEntry,
} from '../../shared/agentContracts.ts'
import {
  AgentRuntimeError,
  assertLlmReady,
  assertWebSearchReady,
  type LlmEnvConfig,
} from '../llm/config.ts'
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatMessage,
  LLMProvider,
  ToolCall,
} from '../llm/types.ts'
import { logJobEvent } from '../jobs/log.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { buildUserMessage, registerTravelTools } from '../tools/travelTools.ts'
import {
  buildFinalProposalPrompt,
  buildNewTravelUserNudge,
  buildRepairPrompt,
  buildResearchOnlyFinalPrompt,
  buildSystemPrompt,
} from './prompts.ts'
import {
  assertDraftGrounded,
  scrubUngroundedConcreteFields,
  type GroundingSuccess,
} from './claims.ts'
import { renderToolContentForModel } from './evidenceRefs.ts'
import {
  buildContactFollowUpNote,
  contactFollowUpUrls,
  userAskedForContact,
} from './contactFollowUp.ts'
import {
  buildDirectedResearchNudge,
  buildResearchDiagnostics,
  extractTripDatesFromPrompt,
  scrubUnsupportedFreeTextAssertions,
  shouldForceAnotherResearchRound,
  shouldSkipToolCallForFlightPriority,
  assessResearchGoals,
  type ResearchDiagnostics,
  type ResearchGoal,
} from './researchCoverage.ts'
import {
  buildContextOnlyDraft,
  classifyAskIntent,
  detectNoMutationDirective,
  tryContextAnswer,
  type AskIntent,
} from './intent.ts'
import {
  assessPlannerGoals,
  buildPlannerNudge,
  buildResearchTransitionNote,
  computePlannerState,
  decideResponseShape,
  deriveResearchPlan,
  plannedCallLevel,
  planToolCallDecision,
  filterUnresearchedNegativeWarnings,
  nextRequiredResearchAction,
  pendingGoalWarnings,
  requiredActionMessage,
  shouldForcePlannerRound,
  toResearchOnlyDraft,
  type PlannerState,
  type ResearchDimension,
  type ResearchPlan,
} from './researchPlanner.ts'
import { enrichPackageWithAirportArrivals } from './airportArrivalEnrich.ts'
import { mergePublishedSchedulesFromTrace } from '../flights/mergeSchedules.ts'
import {
  formatProposalValidationUserError,
  normalizeProposalDatetimes,
  softDropInvalidDatetimePaths,
} from './datetimeNormalize.ts'
import {
  collectNewTravelServerWarnings,
  ensureNewTravelSkeleton,
  markTentativeTripWindow,
  webResearchWarnings,
} from './newTravelCoherence.ts'
import { agentProposalStructuredResponseFormat } from './proposalSchema.ts'

export type AgentRunMeta = {
  steps: number
  llmCalls: number
  toolTrace: ToolTraceEntry[]
  lastFinishReason: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  hadRepair: boolean
  finalContentChars?: number
  finalContentBytes?: number
}

export type AgentRunResult = {
  proposal?: AgentProposal
  componentActionResult?: import('../../shared/agentContracts.ts').ComponentActionResult
  meta: AgentRunMeta
}

export type AgentRuntimeDeps = {
  llm: LLMProvider
  cfg: LlmEnvConfig
  /** Injected for tests — default builds registry with real tools. */
  createRegistry?: () => ToolRegistry
  jobId?: string
  requestId?: string
  tripId?: string
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

/**
 * An explicit change to an existing trip already fixes the destination (the
 * trip's) and the dates (the user's). The event is still researched and kept
 * pending, but it no longer turns the answer into research-only — otherwise
 * the requested window change is silently dropped.
 */
export function ungateEventForExistingTripMutation(
  plan: ResearchPlan,
  intent: AskIntent,
  req: Pick<AgentAskRequest, 'mode' | 'context'>,
): ResearchPlan {
  if (intent !== 'mutation' || req.mode === 'new_travel') return plan
  if (plan.destinationSelection) return plan
  const trip = asRecord(req.context.trip)
  if (!str(trip.id) || !str(trip.startDate)) return plan
  return {
    ...plan,
    goals: plan.goals.map((g) =>
      g.kind === 'event_discovery' && g.decisionCritical
        ? { ...g, decisionCritical: false }
        : g,
    ),
  }
}

/**
 * Package that owns the trip's current options (most options win), else the
 * highest-revision import. Ties break on id so the choice is deterministic.
 */
function existingTripPackage(
  req: Pick<AgentAskRequest, 'context'>,
): { id: string; revision: number } | undefined {
  const imports = req.context.packageImports.map(asRecord).map((p) => ({
    id: nonEmptyStr(p.id) || nonEmptyStr(p.packageId),
    revision: typeof p.revision === 'number' ? p.revision : 0,
  }))
  const revisionOf = (id: string) =>
    Math.max(0, ...imports.filter((p) => p.id === id).map((p) => p.revision))
  const owners = new Map<string, number>()
  for (const o of req.context.travelOptions.map(asRecord)) {
    const id = nonEmptyStr(o.packageId)
    if (id) owners.set(id, (owners.get(id) ?? 0) + 1)
  }
  const owner = [...owners].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0]
  if (owner) return { id: owner, revision: revisionOf(owner) }
  const latest = imports
    .filter((p) => p.id)
    .sort((a, b) => b.revision - a.revision || a.id.localeCompare(b.id))[0]
  return latest ? { id: latest.id, revision: latest.revision } : undefined
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed)
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim())
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }
  throw new Error('no JSON object in model output')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** Like str(), but empty/whitespace strings fall through to fallback. */
function nonEmptyStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback
}

function normalizeGoals(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((g) => {
      if (typeof g === 'string') return g
      const o = asRecord(g)
      return str(o.label, str(o.id))
    })
    .filter(Boolean)
}

const EXTERNAL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const TRAVEL_OPTION_TYPES = new Set([
  'flight',
  'lodging',
  'bus',
  'train',
  'transfer',
  'car_rental',
  'restaurant',
  'activity',
  'event',
  'other',
])

function slugId(prefix: string, seed: string, index: number): string {
  const base = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${prefix}-${base || 'item'}-${index + 1}`
}

function ensureExternalId(
  raw: unknown,
  prefix: string,
  seed: string,
  index: number,
  seen: Set<string>,
): string {
  let id = nonEmptyStr(raw)
  if (!EXTERNAL_ID_RE.test(id)) id = slugId(prefix, seed, index)
  if (seen.has(id)) id = `${id.replace(/-\d+$/, '')}-${index + 1}`
  if (seen.has(id) || !EXTERNAL_ID_RE.test(id)) {
    id = `${prefix}-item-${index + 1}-${seen.size + 1}`
  }
  seen.add(id)
  return id
}

function optionalIso(v: unknown): string | undefined {
  const s = nonEmptyStr(v)
  if (!s) return undefined
  // Keep only already-valid ISO-with-offset here; normalizeProposalDatetimes
  // runs earlier and either fixes or drops bare datetimes.
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) &&
    (/[+-]\d{2}:\d{2}$/.test(s) || /Z$/i.test(s))
  ) {
    return s
  }
  return undefined
}

/** Drop/fill incomplete package entities so Zod proposal schema always passes. */
export function sanitizePackageCollections(pkg: Record<string, unknown>): {
  travelOptions: Record<string, unknown>[]
  itineraryItems: Record<string, unknown>[]
  checklistItems: Record<string, unknown>[]
  notes: Record<string, unknown>[]
} {
  const travelOptions: Record<string, unknown>[] = []
  const seenOpt = new Set<string>()
  const rawOpts = Array.isArray(pkg.travelOptions) ? pkg.travelOptions : []
  for (let i = 0; i < rawOpts.length; i++) {
    const r = asRecord(rawOpts[i])
    const title = nonEmptyStr(r.title)
    if (!title) continue
    const typeRaw = nonEmptyStr(r.type, 'other')
    const type = TRAVEL_OPTION_TYPES.has(typeRaw) ? typeRaw : 'other'
    const externalId = ensureExternalId(r.externalId, 'opt', title, i, seenOpt)
    const statusRaw = nonEmptyStr(r.status, 'researched')
    const status =
      statusRaw === 'researched' || statusRaw === 'shortlisted'
        ? statusRaw
        : 'researched'
    const priceObserved =
      typeof r.priceObserved === 'number' &&
      Number.isFinite(r.priceObserved) &&
      r.priceObserved >= 0
        ? r.priceObserved
        : undefined
    const currency = nonEmptyStr(r.currency).toUpperCase()
    const currencyOk = /^[A-Z]{3}$/.test(currency) ? currency : undefined
    const sourceTypeRaw = nonEmptyStr(r.sourceType, 'agent')
    const sourceType =
      sourceTypeRaw === 'cursor' ||
      sourceTypeRaw === 'manual' ||
      sourceTypeRaw === 'imported' ||
      sourceTypeRaw === 'agent' ||
      sourceTypeRaw === 'other' ||
      sourceTypeRaw === 'flight_schedule'
        ? sourceTypeRaw
        : 'agent'
    const out: Record<string, unknown> = {
      externalId,
      type,
      title,
      status,
      sourceType,
    }
    const provider = nonEmptyStr(r.provider)
    if (provider) out.provider = provider
    const description = nonEmptyStr(r.description)
    if (description) out.description = description
    const startAt = optionalIso(r.startAt)
    if (startAt) out.startAt = startAt
    const endAt = optionalIso(r.endAt)
    if (endAt) out.endAt = endAt
    const origin = nonEmptyStr(r.origin)
    if (origin) out.origin = origin
    const destination = nonEmptyStr(r.destination)
    if (destination) out.destination = destination
    const address = nonEmptyStr(r.address)
    if (address) out.address = address
    const phone = nonEmptyStr(r.phone)
    if (phone) out.phone = phone
    if (priceObserved !== undefined && currencyOk) {
      out.priceObserved = priceObserved
      out.currency = currencyOk
    }
    const sourceUrl = nonEmptyStr(r.sourceUrl)
    if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) out.sourceUrl = sourceUrl
    const checkedAt = optionalIso(r.checkedAt)
    if (checkedAt) out.checkedAt = checkedAt
    const verificationStatus = nonEmptyStr(r.verificationStatus)
    if (
      verificationStatus === 'verified' ||
      verificationStatus === 'estimated' ||
      verificationStatus === 'unverified'
    ) {
      out.verificationStatus = verificationStatus
    }
    const notes = nonEmptyStr(r.notes)
    if (notes) out.notes = notes
    travelOptions.push(out)
  }

  const itineraryItems: Record<string, unknown>[] = []
  const seenItin = new Set<string>()
  const rawItin = Array.isArray(pkg.itineraryItems) ? pkg.itineraryItems : []
  for (let i = 0; i < rawItin.length; i++) {
    const r = asRecord(rawItin[i])
    // Soft-drop empty shells — keep items that at least have a title or timing.
    const title = nonEmptyStr(r.title)
    const startAt = optionalIso(r.startAt)
    const endAt = optionalIso(r.endAt)
    const place = nonEmptyStr(r.place)
    if (!title && !startAt && !endAt && !place) continue
    const resolvedTitle = title || place || 'Ítem de itinerario'
    const externalId = ensureExternalId(
      r.externalId,
      'itin',
      resolvedTitle,
      i,
      seenItin,
    )
    const importanceRaw = nonEmptyStr(r.importance, 'optional')
    const importance =
      importanceRaw === 'crucial' ||
      importanceRaw === 'recommended' ||
      importanceRaw === 'optional'
        ? importanceRaw
        : 'optional'
    const out: Record<string, unknown> = {
      externalId,
      title: resolvedTitle,
      importance,
    }
    if (startAt) out.startAt = startAt
    if (endAt) out.endAt = endAt
    if (place) out.place = place
    const notes = nonEmptyStr(r.notes)
    if (notes) out.notes = notes
    itineraryItems.push(out)
  }

  const checklistItems: Record<string, unknown>[] = []
  const seenChk = new Set<string>()
  const rawChk = Array.isArray(pkg.checklistItems) ? pkg.checklistItems : []
  for (let i = 0; i < rawChk.length; i++) {
    const r = asRecord(rawChk[i])
    // LLMs sometimes put checklist text in title/text instead of label.
    const label = nonEmptyStr(r.label, nonEmptyStr(r.title, nonEmptyStr(r.text)))
    if (!label) continue
    const externalId = ensureExternalId(r.externalId, 'chk', label, i, seenChk)
    const out: Record<string, unknown> = { externalId, label }
    const dueAt = optionalIso(r.dueAt)
    if (dueAt) out.dueAt = dueAt
    if (typeof r.sortOrder === 'number' && Number.isFinite(r.sortOrder) && r.sortOrder >= 0) {
      out.sortOrder = Math.floor(r.sortOrder)
    }
    checklistItems.push(out)
  }

  const notes: Record<string, unknown>[] = []
  const seenNote = new Set<string>()
  const rawNotes = Array.isArray(pkg.notes) ? pkg.notes : []
  for (let i = 0; i < rawNotes.length; i++) {
    const r = asRecord(rawNotes[i])
    const body = nonEmptyStr(r.body)
    if (!body) continue
    const externalId = ensureExternalId(r.externalId, 'note', body, i, seenNote)
    const out: Record<string, unknown> = { externalId, body }
    const noteTitle = nonEmptyStr(r.title)
    if (noteTitle) out.title = noteTitle
    notes.push(out)
  }

  return { travelOptions, itineraryItems, checklistItems, notes }
}

function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) continue
      out[k] = stripNulls(val)
    }
    return out
  }
  return v
}

/** Hydrate LLM draft with server-owned fields; PWA still receives full AgentProposal. */
export function hydrateProposal(
  raw: unknown,
  req: AgentAskRequest,
  toolTrace: ToolTraceEntry[],
  opts?: {
    serverWarnings?: string[]
    intent?: string
    researchDiagnostics?: ResearchDiagnostics
    /** Findings-only answer: no skeleton, schedule merge, or airport arrivals. */
    researchOnly?: boolean
  },
): unknown {
  const obj = asRecord(stripNulls(raw))
  // claims[] is internal to AgentRuntime — never part of public AgentProposal
  const { claims: _claims, ...withoutClaims } = obj
  const isNewTravel =
    req.mode === 'new_travel' || opts?.intent === 'new_travel'
  const trip = asRecord(req.context.trip)
  const tripId = isNewTravel
    ? str(asRecord(asRecord(withoutClaims.package).trip).id, req.tripId)
    : str(trip.id, req.tripId)
  const title = isNewTravel
    ? str(asRecord(asRecord(withoutClaims.package).trip).title, 'Nuevo viaje')
    : str(trip.title, 'Viaje')
  const startDate = isNewTravel
    ? str(
        asRecord(asRecord(withoutClaims.package).trip).startDate,
        '2026-01-01',
      )
    : str(trip.startDate, '2026-01-01')
  const endDate = isNewTravel
    ? str(
        asRecord(asRecord(withoutClaims.package).trip).endDate,
        startDate,
      )
    : str(trip.endDate, startDate)
  const timezone = isNewTravel
    ? str(
        asRecord(asRecord(withoutClaims.package).trip).timezone,
        'America/Mexico_City',
      )
    : str(trip.timezone, 'America/Mexico_City')
  const existingPkg = isNewTravel ? undefined : existingTripPackage(req)
  const packageId = isNewTravel
    ? nonEmptyStr(asRecord(withoutClaims.package).packageId, `new-${tripId}`)
    : existingPkg?.id || `agent-${tripId}`
  const priorRevision = existingPkg?.revision ?? 0
  const revision = isNewTravel
    ? 1
    : Math.max(1, priorRevision + 1)

  let pkg = asRecord(withoutClaims.package)
  const coherenceWarnings: string[] = []
  if (opts?.researchOnly) {
    if (isNewTravel) coherenceWarnings.push(...webResearchWarnings(toolTrace))
  } else if (isNewTravel) {
    // Defense in depth: strip inventable concrete facts before skeleton/airport
    // enrich (also runs in assertDraftGrounded for the normal parse path).
    const wrap: Record<string, unknown> = { package: pkg }
    coherenceWarnings.push(
      ...scrubUngroundedConcreteFields(wrap, { scrubItineraryClocks: true }),
    )
    coherenceWarnings.push(
      ...scrubUnsupportedFreeTextAssertions(wrap, toolTrace),
    )
    pkg = asRecord(wrap.package)
    const merged = mergePublishedSchedulesFromTrace(pkg, toolTrace)
    pkg = merged.package
    coherenceWarnings.push(...merged.warnings)
    pkg = ensureNewTravelSkeleton(pkg, req.prompt)
    pkg = enrichPackageWithAirportArrivals(pkg)
    coherenceWarnings.push(
      ...collectNewTravelServerWarnings(pkg, req.prompt, toolTrace),
    )
  }
  if (isNewTravel) {
    const tentative = markTentativeTripWindow(pkg, req.prompt)
    pkg = tentative.pkg
    coherenceWarnings.push(...tentative.warnings)
  }
  const collections = sanitizePackageCollections(pkg)
  const pkgTrip = asRecord(pkg.trip)

  const modelWarnings = Array.isArray(withoutClaims.warnings)
    ? withoutClaims.warnings.filter((w): w is string => typeof w === 'string')
    : []
  const warnings = [
    ...modelWarnings,
    ...(opts?.serverWarnings ?? []),
    ...coherenceWarnings,
  ]

  return {
    ...withoutClaims,
    warnings,
    // Server-owned — always overwrite model values if present
    proposalId: randomUUID(),
    createdAt: nowIso(),
    toolTrace,
    ...(opts?.researchDiagnostics
      ? { researchDiagnostics: opts.researchDiagnostics }
      : {}),
    package: {
      ...pkg,
      schemaVersion: 1,
      // Existing trip: package identity is server-owned (a model-chosen id
      // re-keys every option and orphans the current ones).
      packageId: isNewTravel ? nonEmptyStr(pkg.packageId, packageId) : packageId,
      revision: isNewTravel
        ? typeof pkg.revision === 'number' && pkg.revision >= 1
          ? pkg.revision
          : revision
        : revision,
      generatedAt: nowIso(),
      trip: {
        id: tripId,
        title: str(pkgTrip.title, title),
        destination: isNewTravel
          ? str(pkgTrip.destination) || undefined
          : str(pkgTrip.destination, str(trip.destination)),
        startDate: str(pkgTrip.startDate, startDate),
        endDate: str(pkgTrip.endDate, endDate),
        timezone: str(pkgTrip.timezone, timezone),
        goals: normalizeGoals(
          pkgTrip.goals ?? (isNewTravel ? [] : trip.goals),
        ),
        status: isNewTravel
          ? 'planned'
          : str(pkgTrip.status, str(trip.status, 'planned')),
        // Explicit null/empty from a context-only draft must not re-echo Dexie notes
        // into the proposal package (those are INPUT CONTEXT, not agent output).
        notes:
          'notes' in pkgTrip
            ? str(pkgTrip.notes) || undefined
            : isNewTravel
              ? undefined
              : str(trip.notes) || undefined,
      },
      travelOptions: collections.travelOptions,
      itineraryItems: collections.itineraryItems,
      checklistItems: collections.checklistItems,
      notes: collections.notes,
    },
  }
}

export type ParseProposalResult =
  | {
      ok: true
      proposal: AgentProposal
      assessedGoals?: ResearchGoal[]
      researchOnly?: boolean
      groundedSourceUrls?: string[]
    }
  | { ok: false; error: string; code?: string; warnings?: string[] }

/** Post-grounding response shaping (goal assessment → package | research_only). */
type ResponseShaping = {
  noMutation: boolean
  assess: (grounding: GroundingSuccess) => ResearchGoal[]
  planner?: () => { state: PlannerState; dimensions: ResearchDimension[] }
}

function tryParseProposal(
  text: string,
  req: AgentAskRequest,
  toolTrace: ToolTraceEntry[],
  intent?: string,
  researchDiagnostics?: ResearchDiagnostics,
  shaping?: ResponseShaping,
): ParseProposalResult {
  try {
    const raw = extractJsonObject(text)
    let draft = asRecord(stripNulls(raw))
    const tripTz = str(
      asRecord(asRecord(draft.package).trip).timezone,
      str(asRecord(req.context.trip).timezone, 'America/Mexico_City'),
    )
    const normalized = normalizeProposalDatetimes(draft, {
      tripTimezoneFallback: tripTz,
    })
    draft = asRecord(normalized.value)
    const dtWarnings = [...normalized.warnings]

    const grounding = assertDraftGrounded(draft, toolTrace, req.context, {
      allowSkeletonPackage: intent === 'new_travel' || req.mode === 'new_travel',
      userPrompt: req.prompt,
    })
    if (!grounding.ok) {
      const detail = [grounding.message, ...grounding.warnings].join('\n')
      return {
        ok: false,
        error: detail,
        code: 'ungrounded_claims',
        warnings: grounding.warnings,
      }
    }

    let draftForHydrate = grounding.draft
    let assessedGoals: ResearchGoal[] | undefined
    let researchOnly = false
    if (shaping) {
      assessedGoals = shaping.assess(grounding)
      const shape = decideResponseShape({
        noMutation: shaping.noMutation,
        goals: assessedGoals,
      })
      const planner = shaping.planner?.()
      if (shape.shape === 'research_only') {
        researchOnly = true
        draftForHydrate = toResearchOnlyDraft(grounding.draft, req, {
          isNewTravel: intent === 'new_travel' || req.mode === 'new_travel',
          goals: assessedGoals,
          reasons: shape.reasons,
          validClaims: grounding.validClaims,
          planner,
        })
      } else if (planner) {
        const modelWarnings = Array.isArray(grounding.draft.warnings)
          ? grounding.draft.warnings.filter((w): w is string => typeof w === 'string')
          : []
        draftForHydrate = {
          ...grounding.draft,
          warnings: [
            ...filterUnresearchedNegativeWarnings(modelWarnings, planner.state),
            ...pendingGoalWarnings(assessedGoals),
          ],
        }
      }
    }

    let hydrated: unknown = hydrateProposal(draftForHydrate, req, toolTrace, {
      serverWarnings: dtWarnings,
      intent,
      researchDiagnostics,
      researchOnly,
    })
    let parsed = agentProposalSchema.safeParse(hydrated)

    if (!parsed.success) {
      const soft = softDropInvalidDatetimePaths(
        hydrated,
        parsed.error.issues.map((i) => ({
          path: [...i.path] as PropertyKey[],
          message: i.message,
        })),
      )
      const renorm = normalizeProposalDatetimes(soft.value, {
        tripTimezoneFallback: tripTz,
      })
      const merged = asRecord(renorm.value)
      const extra = [...dtWarnings, ...soft.warnings, ...renorm.warnings]
      const prevWarn = Array.isArray(merged.warnings)
        ? merged.warnings.filter((w): w is string => typeof w === 'string')
        : []
      merged.warnings = [...prevWarn, ...extra]
      hydrated = merged
      parsed = agentProposalSchema.safeParse(hydrated)
    }

    if (!parsed.success) {
      return { ok: false, error: parsed.error.message }
    }
    const groundedSourceUrls = [
      ...new Set(
        grounding.validClaims
          .filter((c) => c.sourceType === 'web' && /^https:\/\//i.test(c.sourceUrl ?? ''))
          .map((c) => c.sourceUrl!),
      ),
    ]
    return { ok: true, proposal: parsed.data, assessedGoals, researchOnly, groundedSourceUrls }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'parse failed',
    }
  }
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function addUsage(
  acc: { inputTokens: number; outputTokens: number; totalTokens: number },
  usage: ChatCompletionResult['usage'],
) {
  if (!usage) return
  acc.inputTokens += usage.inputTokens ?? 0
  acc.outputTokens += usage.outputTokens ?? 0
  acc.totalTokens +=
    usage.totalTokens ??
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

/**
 * AgentRuntime: tool loop → dedicated structured final → Zod → one repair max.
 */
export async function runAgentAsk(
  req: AgentAskRequest,
  deps: AgentRuntimeDeps,
): Promise<AgentRunResult> {
  assertLlmReady(deps.cfg)
  if (deps.cfg.enableWebTools) {
    assertWebSearchReady(deps.cfg)
  }

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

  const toolTrace: ToolTraceEntry[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.cfg.timeoutMs)

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserMessage(req) },
  ]

  let toolCallsUsed = 0
  let steps = 0
  let llmCalls = 0
  let lastFinishReason: string | null = null
  let hadRepair = false
  let toolRounds = 0
  let forcedExtraRounds = 0
  let contactFollowUpDone = false
  const askedForContact = userAskedForContact(req.prompt)
  let researchGoalsSeed: ResearchGoal[] = []
  let plan: ResearchPlan | null = null
  let multiObjective = false
  const baseCap = deps.cfg.maxToolCalls
  const multiCap = Math.max(baseCap, deps.cfg.maxToolCallsMultiObjective ?? 12)
  const availableTools = registry.definitions().map((d) => d.function.name)
  const tripDates = extractTripDatesFromPrompt(req.prompt)
  /**
   * Tool-call ceiling. Multi-objective research is bounded per dimension by the
   * planner (limits + closing unproductive lines); this is only the backstop.
   */
  const currentCap = (): number => (multiObjective && plan ? multiCap : baseCap)
  const legacyCoverage = () =>
    !multiObjective && researchGoalsSeed.length > 0
  const usage = emptyUsage()

  const failMeta = (): NonNullable<AgentRuntimeError['runMeta']> => ({
    toolTrace: [...toolTrace],
    steps,
    llmCalls,
    lastFinishReason,
    usage: { ...usage },
    hadRepair,
  })

  const chatLogged = async (
    callType: 'tool' | 'final' | 'repair',
    params: ChatCompletionParams,
  ): Promise<ChatCompletionResult> => {
    steps += 1
    llmCalls += 1
    const maxTokensRequested = params.max_tokens ?? deps.cfg.maxTokens
    const t0 = Date.now()
    const result = await deps.llm.chat({
      ...params,
      max_tokens: maxTokensRequested,
      signal: controller.signal,
    })
    lastFinishReason = result.finishReason
    addUsage(usage, result.usage)
    const content = result.message.content ?? ''
    const contentLengthChars = content.length
    const contentLengthBytes = Buffer.byteLength(content, 'utf8')
    logJobEvent('llm_call', {
      jobId: deps.jobId ?? null,
      requestId: deps.requestId ?? null,
      tripId: deps.tripId ?? req.tripId,
      step: steps,
      callType,
      model: deps.llm.model,
      durationMs: Date.now() - t0,
      finish_reason: result.finishReason,
      input_tokens: result.usage?.inputTokens ?? null,
      output_tokens: result.usage?.outputTokens ?? null,
      total_tokens: result.usage?.totalTokens ?? null,
      contentLengthChars,
      contentLengthBytes,
      toolCallsCount: result.message.tool_calls?.length ?? 0,
      responseFormatUsed: Boolean(params.response_format),
      maxTokensRequested,
    })
    return result
  }

  try {
    if (req.mode === 'component_action') {
      const { runComponentAction } = await import('./componentAction.ts')
      const ca = await runComponentAction(req, deps)
      return {
        componentActionResult: ca.componentActionResult,
        meta: {
          ...ca.meta,
          toolTrace: ca.componentActionResult.toolTrace,
        },
      }
    }

    const intent = classifyAskIntent(req.prompt, req.mode)
    const noMutation = detectNoMutationDirective(req.prompt)
    if (intent !== 'context_answer') {
      const derived = deriveResearchPlan(req.prompt)
      // Simple asks keep current behavior: legacy goals for new_travel only.
      if (intent === 'new_travel' || derived.multiObjective) {
        plan = ungateEventForExistingTripMutation(derived, intent, req)
        researchGoalsSeed = plan.goals
        multiObjective = derived.multiObjective && derived.goals.length > 0
      }
    }
    logJobEvent('ask_intent', {
      jobId: deps.jobId ?? null,
      requestId: deps.requestId ?? null,
      tripId: deps.tripId ?? req.tripId,
      intent,
      mode: req.mode ?? 'ask',
      noMutation,
      multiObjective,
    })

    // --- Context-only fast path: no tools, no web claims ---
    if (intent === 'context_answer') {
      const hit = tryContextAnswer(req)
      if (hit) {
        const draft = buildContextOnlyDraft(req, hit)
        const grounding = assertDraftGrounded(draft, toolTrace, req.context, {
          userPrompt: req.prompt,
        })
        if (!grounding.ok) {
          throw new AgentRuntimeError(
            [grounding.message, ...grounding.warnings].join('\n'),
            'ungrounded_claims',
            failMeta(),
          )
        }
        const hydrated = hydrateProposal(grounding.draft, req, toolTrace, {
          serverWarnings: [],
        })
        const parsed = agentProposalSchema.safeParse(hydrated)
        if (!parsed.success) {
          throw new AgentRuntimeError(
            parsed.error.message,
            'invalid_proposal',
            failMeta(),
          )
        }
        return {
          proposal: parsed.data,
          meta: {
            steps,
            llmCalls: 0,
            toolTrace,
            lastFinishReason: null,
            usage: emptyUsage(),
            hadRepair: false,
            finalContentChars: hit.narrative.length,
            finalContentBytes: Buffer.byteLength(hit.narrative, 'utf8'),
          },
        }
      }
      // Context intent but no deterministic hit → LLM final only (no tools)
      messages.push({
        role: 'user',
        content: [
          'INTENT: context_answer.',
          'Answer ONLY from DEXIE_TRIP_CONTEXT_SNAPSHOT_JSON.',
          'Do NOT call tools. Do NOT invent web sourceUrl.',
          'Use claims with sourceType=context (entityType, entityId, field).',
          'If the answer is not in context, say so briefly without web research.',
        ].join(' '),
      })
      // fall through to structured final (skip tool loop)
    } else {
      if (intent === 'new_travel') {
        messages.push({
          role: 'user',
          content: buildNewTravelUserNudge(req.tripId, { multiObjective }),
        })
      }
      if (multiObjective && plan) {
        messages.push({
          role: 'user',
          content: buildPlannerNudge({
            plan,
            state: computePlannerState(plan, toolTrace),
            remainingCalls: multiCap,
          }),
        })
      }
      let lastOpenLevel =
        multiObjective && plan ? computePlannerState(plan, toolTrace).minOpenLevel : 0
      // --- Tool loop (research / mutation / new_travel events) ---
      while (steps < deps.cfg.maxSteps) {
        if (controller.signal.aborted) {
          throw new AgentRuntimeError('Agent timeout', 'llm_timeout', failMeta())
        }

        const tools = registry.definitions()
        // While the event is the only open priority, the planner owns the step:
        // the call is restricted to its tool (the model still writes the args),
        // so no step is spent on lodging/transport/flights the planner would defer.
        let forced: { tool: string; trace: Record<string, unknown> } | null = null
        if (multiObjective && plan && toolCallsUsed < currentCap()) {
          const state = computePlannerState(plan, toolTrace)
          const action = nextRequiredResearchAction(plan, state)
          const tool = action?.type === 'VERIFY_EVENT' ? 'fetchUrl' : action ? 'webSearch' : null
          if (!action && state.minOpenLevel > lastOpenLevel) {
            messages.push({
              role: 'user',
              content: buildResearchTransitionNote(state, currentCap() - toolCallsUsed),
            })
          }
          lastOpenLevel = state.minOpenLevel
          if (action && tool && tools.some((t) => t.function.name === tool)) {
            forced = {
              tool,
              trace: { type: action.type, candidate: action.candidate ?? null, reason: action.reason },
            }
            messages.push({ role: 'user', content: requiredActionMessage(action, state) })
            logJobEvent('research_forced_action', {
              jobId: deps.jobId ?? null,
              requestId: deps.requestId ?? null,
              tripId: deps.tripId ?? req.tripId,
              step: steps + 1,
              tool,
              ...forced.trace,
              ...(action.type === 'VERIFY_EVENT' ? { eligibleUrls: action.eligibleUrls.join(' ') } : {}),
            })
          }
        }
        const result = await chatLogged('tool', {
          messages,
          ...(tools.length
            ? {
                tools,
                tool_choice: forced
                  ? { type: 'function' as const, function: { name: forced.tool } }
                  : ('auto' as const),
              }
            : {}),
        })

        const assistant = result.message
        messages.push(assistant)

        if (assistant.tool_calls?.length) {
          toolRounds += 1
          const stepTraceStart = toolTrace.length
          // Reserve tool budget for a directed follow-up round when important
          // research goals are still open (avoids burning maxToolCalls on the
          // first parallel webSearch batch).
          const reserveForCoverage =
            intent === 'new_travel' &&
            legacyCoverage() &&
            forcedExtraRounds === 0
              ? Math.min(2, Math.max(0, deps.cfg.maxToolCalls - 2))
              : 0
          const softCap = deps.cfg.maxToolCalls - reserveForCoverage
          // Prefer searchFlightSchedules, then fetchUrl, before extra webSearch.
          const orderedCalls = [...assistant.tool_calls]
          if (multiObjective && plan) {
            // Dependency order: event/candidate evaluation → access → flights.
            const p = plan
            const levelOf = (c: (typeof orderedCalls)[number]) =>
              plannedCallLevel(p, c.function.name, c.function.arguments, toolTrace)
                .level
            orderedCalls.sort((a, b) => levelOf(a) - levelOf(b))
          } else if (forcedExtraRounds > 0 || reserveForCoverage > 0) {
            orderedCalls.sort((a, b) => {
              const rank = (name: string) =>
                name === 'searchFlightSchedules'
                  ? 0
                  : name === 'fetchUrl'
                    ? 1
                    : 2
              return rank(a.function.name) - rank(b.function.name)
            })
          } else {
            orderedCalls.sort((a, b) => {
              const rank = (name: string) =>
                name === 'searchFlightSchedules' ? 0 : 1
              return rank(a.function.name) - rank(b.function.name)
            })
          }
          for (const call of orderedCalls) {
            const isFetch = call.function.name === 'fetchUrl'
            const isSchedule = call.function.name === 'searchFlightSchedules'
            if (multiObjective && plan) {
              const decision = planToolCallDecision({
                plan,
                state: computePlannerState(plan, toolTrace),
                toolName: call.function.name,
                argsJson: call.function.arguments,
                toolTrace,
              })
              if (!decision.allow) {
                let requested: unknown = call.function.arguments
                try {
                  requested = JSON.parse(call.function.arguments)
                } catch {
                  // keep the raw string
                }
                const skipTrace: ToolTraceEntry = {
                  tool: call.function.name,
                  // Nested: consumers read top-level query/url only for executed calls.
                  args: { skipped: true, deferred: decision.reason, requested },
                  ok: false,
                  sources: [],
                  error: `deferred: ${decision.reason}`,
                  checkedAt: nowIso(),
                }
                toolTrace.push(skipTrace)
                messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  name: call.function.name,
                  content: JSON.stringify({
                    UNTRUSTED_CONTENT: true,
                    error: skipTrace.error,
                    hint: decision.hint,
                  }),
                })
                continue
              }
            }
            // Defer lodging/event tools while critical flight attempt unfinished
            if (
              intent === 'new_travel' &&
              legacyCoverage() &&
              shouldSkipToolCallForFlightPriority({
                toolName: call.function.name,
                argsJson: call.function.arguments,
                goals: assessResearchGoals(researchGoalsSeed, toolTrace, {
                  tripDates,
                }),
                toolTrace,
                tripDates,
              })
            ) {
              const checkedAt = nowIso()
              const skipTrace: ToolTraceEntry = {
                tool: call.function.name,
                args: { skipped: true, deferred: 'flight_critical' },
                ok: false,
                sources: [],
                error:
                  'deferred: critical flight_day_specific still needs searchFlightSchedules (or directed web fallback) before lodging/events',
                checkedAt,
              }
              toolTrace.push(skipTrace)
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify({
                  UNTRUSTED_CONTENT: true,
                  error: skipTrace.error,
                  hint: 'Call searchFlightSchedules({ origin, destination, date }) first; webSearch/fetchUrl only as fallback after schedules.',
                }),
              })
              continue
            }
            const cap = currentCap()
            const atHardCap = toolCallsUsed >= cap
            // Reserved slots are for schedule search / fetchUrl (or post-nudge directed work).
            const blockedByReserve =
              reserveForCoverage > 0 &&
              toolCallsUsed >= softCap &&
              !isFetch &&
              !isSchedule
            if (atHardCap || blockedByReserve) {
              const checkedAt = nowIso()
              const reserved =
                reserveForCoverage > 0 &&
                toolCallsUsed < deps.cfg.maxToolCalls
              const skipTrace: ToolTraceEntry = {
                tool: call.function.name,
                args: { skipped: true },
                ok: false,
                sources: [],
                error: reserved
                  ? `tool budget reserved for directed research follow-up (${reserveForCoverage} call(s) held; used ${toolCallsUsed}/${deps.cfg.maxToolCalls})`
                  : multiObjective
                    ? `AGENT_MAX_TOOL_CALLS research budget ${cap} reached (multi-objective ceiling ${multiCap})`
                    : `AGENT_MAX_TOOL_CALLS=${deps.cfg.maxToolCalls} exceeded`,
                checkedAt,
              }
              toolTrace.push(skipTrace)
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify({
                  UNTRUSTED_CONTENT: true,
                  error: skipTrace.error,
                  hint: reserved
                    ? 'Next: fetchUrl on a promising flight candidate URL OR a refined day-specific/carrier query. Do not spend reserved slots on lodging yet.'
                    : undefined,
                }),
              })
              continue
            }
            toolCallsUsed += 1
            const exec = await registry.execute(
              call.function.name,
              call.function.arguments,
              { signal: controller.signal },
            )
            const content = renderToolContentForModel(
              exec.trace,
              toolTrace,
              exec.contentForModel,
            )
            toolTrace.push(exec.trace)
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content,
            })
          }
          if (forced) {
            for (const t of toolTrace.slice(stepTraceStart)) {
              t.args = { ...(t.args ?? {}), forcedResearchAction: forced.trace }
            }
          }
          continue
        }

        // No tool calls → contact data the user asked for may still sit behind a
        // search hit: fetch it once and hand the passages back to the model.
        if (!contactFollowUpDone && askedForContact && registry.has('fetchUrl')) {
          contactFollowUpDone = true
          const cap = currentCap()
          const eligible = contactFollowUpUrls(toolTrace)
          const urls = eligible.slice(0, Math.max(0, cap - toolCallsUsed))
          logJobEvent('contact_follow_up', {
            jobId: deps.jobId ?? null,
            requestId: deps.requestId ?? null,
            tripId: deps.tripId ?? req.tripId,
            eligible: eligible.join(' '),
            fetched: urls.join(' '),
            toolCallsUsed,
            cap,
          })
          if (urls.length) {
            const calls: ToolCall[] = urls.map((url, i) => ({
              id: `contact_follow_up_${i + 1}`,
              type: 'function',
              function: { name: 'fetchUrl', arguments: JSON.stringify({ url }) },
            }))
            messages.push({ role: 'assistant', content: null, tool_calls: calls })
            for (const call of calls) {
              toolCallsUsed += 1
              const exec = await registry.execute(call.function.name, call.function.arguments, {
                signal: controller.signal,
              })
              exec.trace.args = { ...(exec.trace.args ?? {}), contactFollowUp: true }
              const content = renderToolContentForModel(exec.trace, toolTrace, exec.contentForModel)
              toolTrace.push(exec.trace)
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content,
              })
            }
            messages.push({ role: 'user', content: buildContactFollowUpNote(urls) })
            continue
          }
        }

        // No tool calls → multi-objective: nudge only while decision research is open
        if (multiObjective && plan) {
          const state = computePlannerState(plan, toolTrace)
          const cap = currentCap()
          if (
            shouldForcePlannerRound({
              plan,
              state,
              forcedRounds: forcedExtraRounds,
              toolCallsUsed,
              maxToolCalls: cap,
              steps,
              maxSteps: deps.cfg.maxSteps,
            })
          ) {
            forcedExtraRounds += 1
            logJobEvent('research_planner_nudge', {
              jobId: deps.jobId ?? null,
              requestId: deps.requestId ?? null,
              tripId: deps.tripId ?? req.tripId,
              forcedExtraRounds,
              open: state.dimensions
                .filter((d) => !d.satisfied && !d.exhausted)
                .map((d) => d.dimension)
                .join(','),
              candidates: state.relevantCandidates.join(','),
              toolCallsUsed,
              cap,
            })
            messages.push({
              role: 'user',
              content: buildPlannerNudge({
                plan,
                state,
                remainingCalls: Math.max(0, cap - toolCallsUsed),
              }),
            })
            continue
          }
          break
        }

        // No tool calls → maybe force another directed research round (new_travel)
        if (intent === 'new_travel' && legacyCoverage()) {
          const assessed = assessResearchGoals(
            researchGoalsSeed,
            toolTrace,
            { tripDates },
          )
          const hasSuccessfulFetch = toolTrace.some(
            (t) => t.tool === 'fetchUrl' && t.ok,
          )
          if (
            shouldForceAnotherResearchRound({
              goals: assessed,
              toolCallsUsed,
              maxToolCalls: deps.cfg.maxToolCalls,
              steps,
              maxSteps: deps.cfg.maxSteps,
              forcedExtraRounds,
              hasSuccessfulFetch,
              toolTrace,
              tripDates,
            })
          ) {
            forcedExtraRounds += 1
            logJobEvent('research_coverage_nudge', {
              jobId: deps.jobId ?? null,
              requestId: deps.requestId ?? null,
              tripId: deps.tripId ?? req.tripId,
              forcedExtraRounds,
              unresolved: assessed
                .filter((g) => g.status === 'UNRESOLVED')
                .map((g) => g.id)
                .join(','),
              partial: assessed
                .filter((g) => g.status === 'PARTIAL')
                .map((g) => g.id)
                .join(','),
              toolCallsUsed,
            })
            messages.push({
              role: 'user',
              content: buildDirectedResearchNudge({
                goals: assessed,
                toolTrace,
                tripDates,
                prompt: req.prompt,
              }),
            })
            continue
          }
        }

        break
      }
    }

    // --- Dedicated structured final (no tools) ---
    if (controller.signal.aborted) {
      throw new AgentRuntimeError('Agent timeout', 'llm_timeout', failMeta())
    }

    const assessGoals = (grounded?: GroundingSuccess): ResearchGoal[] => {
      if (researchGoalsSeed.length === 0) return []
      const pkg = grounded ? asRecord(grounded.draft).package : undefined
      if (multiObjective && plan) {
        return assessPlannerGoals(plan, toolTrace, {
          grounded: grounded
            ? { validClaims: grounded.validClaims, package: pkg }
            : undefined,
          availableTools,
          tripDates,
        })
      }
      return assessResearchGoals(researchGoalsSeed, toolTrace, {
        package: pkg,
        tripDates,
        availableTools,
      })
    }
    const capUsed = currentCap()
    const preGoals = assessGoals()
    const openDecision = preGoals.filter(
      (g) => g.decisionCritical && g.status !== 'RESOLVED',
    )
    const researchOnlyPrompted =
      noMutation ||
      openDecision.some(
        (g) => g.status === 'UNRESOLVED' || g.status === 'UNSUPPORTED',
      )

    const researchDiagnosticsPre =
      researchGoalsSeed.length > 0
        ? buildResearchDiagnostics({
            goals: researchGoalsSeed,
            assessedGoals: multiObjective ? preGoals : undefined,
            availableTools,
            toolTrace,
            toolRounds,
            toolCallsUsed,
            maxToolCalls: capUsed,
            forcedExtraRounds,
            tripDates,
          })
        : undefined

    const shaping: ResponseShaping | undefined =
      noMutation || multiObjective
        ? {
            noMutation,
            assess: assessGoals,
            planner:
              multiObjective && plan
                ? () => ({
                    state: computePlannerState(plan!, toolTrace),
                    dimensions: plan!.dimensions,
                  })
                : undefined,
          }
        : undefined

    messages.push({
      role: 'user',
      content: researchOnlyPrompted
        ? buildResearchOnlyFinalPrompt({
            reasons: decideResponseShape({ noMutation, goals: preGoals })
              .reasons,
            openGoals: openDecision.map((g) => `${g.label}: ${g.status}`),
          })
        : buildFinalProposalPrompt(intent, {
            decisionGateLabels: openDecision.map(
              (g) => `${g.label} (${g.status})`,
            ),
            pendingGoalLabels: multiObjective
              ? preGoals
                  .filter((g) => g.important && !g.decisionCritical && g.status !== 'RESOLVED')
                  .map((g) => `${g.label} (${g.status})`)
              : [],
          }),
    })
    const finalResult = await chatLogged('final', {
      messages,
      response_format: agentProposalStructuredResponseFormat(),
    })
    messages.push(finalResult.message)

    if (finalResult.finishReason === 'length') {
      throw new AgentRuntimeError(
        'LLM output truncated (finish_reason=length) on final structured turn',
        'output_truncated',
        failMeta(),
      )
    }

    const finalText = finalResult.message.content?.trim() || ''
    const finalChars = finalText.length
    const finalBytes = Buffer.byteLength(finalText, 'utf8')

    if (!finalText) {
      throw new AgentRuntimeError(
        `LLM returned empty content on final (finish=${finalResult.finishReason ?? 'unknown'})`,
        'llm_empty',
        failMeta(),
      )
    }

    const finalizeDiagnostics = (
      proposal: AgentProposal,
      assessedGoals?: ResearchGoal[],
      groundedSourceUrls?: string[],
    ): AgentProposal => {
      if (researchGoalsSeed.length === 0) return proposal
      const diag = buildResearchDiagnostics({
        goals: researchGoalsSeed,
        assessedGoals: multiObjective ? (assessedGoals ?? preGoals) : undefined,
        availableTools,
        toolTrace,
        toolRounds,
        toolCallsUsed,
        maxToolCalls: capUsed,
        forcedExtraRounds,
        package: proposal.package,
        tripDates,
        groundedSourceUrls,
      })
      return { ...proposal, researchDiagnostics: diag }
    }

    const first = tryParseProposal(
      finalText,
      req,
      toolTrace,
      intent,
      researchDiagnosticsPre,
      shaping,
    )
    if (first.ok) {
      return {
        proposal: finalizeDiagnostics(first.proposal, first.assessedGoals, first.groundedSourceUrls),
        meta: {
          steps,
          llmCalls,
          toolTrace,
          lastFinishReason,
          usage: { ...usage },
          hadRepair: false,
          finalContentChars: finalChars,
          finalContentBytes: finalBytes,
        },
      }
    }

    // --- Single repair fallback ---
    hadRepair = true
    if (controller.signal.aborted) {
      throw new AgentRuntimeError('Agent timeout', 'llm_timeout', failMeta())
    }

    const repairResult = await chatLogged('repair', {
      messages: [
        ...messages,
        { role: 'user', content: buildRepairPrompt(first.error) },
      ],
      response_format: agentProposalStructuredResponseFormat(),
    })
    messages.push(repairResult.message)

    if (repairResult.finishReason === 'length') {
      throw new AgentRuntimeError(
        'LLM output truncated (finish_reason=length) on repair turn',
        'output_truncated',
        failMeta(),
      )
    }

    const repairedText = repairResult.message.content?.trim() || ''
    const second = tryParseProposal(
      repairedText,
      req,
      toolTrace,
      intent,
      researchDiagnosticsPre,
      shaping,
    )
    if (second.ok) {
      return {
        proposal: finalizeDiagnostics(second.proposal, second.assessedGoals, second.groundedSourceUrls),
        meta: {
          steps,
          llmCalls,
          toolTrace,
          lastFinishReason,
          usage: { ...usage },
          hadRepair: true,
          finalContentChars: repairedText.length,
          finalContentBytes: Buffer.byteLength(repairedText, 'utf8'),
        },
      }
    }

    const failCode =
      second.code === 'ungrounded_claims' || first.code === 'ungrounded_claims'
        ? 'ungrounded_claims'
        : 'invalid_proposal'
    throw new AgentRuntimeError(
      failCode === 'ungrounded_claims'
        ? second.error
        : formatProposalValidationUserError(
            `AgentProposal JSON inválido tras repair: ${second.error}`,
          ),
      failCode,
      failMeta(),
    )
  } catch (err) {
    if (err instanceof AgentRuntimeError) {
      if (!err.runMeta) {
        throw new AgentRuntimeError(err.message, err.code, failMeta())
      }
      throw err
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AgentRuntimeError('Agent timeout', 'llm_timeout', failMeta())
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
