/**
 * new_travel research coverage — explicit goals, candidate decisions, free-text scrub.
 * Snippets are candidate evidence only; never auto-promote to verified.
 */
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'

export type ResearchGoalKind =
  | 'flight_day_specific'
  | 'airport_terminal'
  | 'bus_terminal'
  | 'connection_feasibility'
  | 'lodging_contingency'
  | 'lodging_destination'
  | 'event_activities'
  | 'ground_leg'
  | 'other'

export type GoalStatus = 'RESOLVED' | 'PARTIAL' | 'UNRESOLVED'

/** Investigation priority: critical blocks secondary until a reasonable attempt finishes. */
export type GoalTier = 'critical' | 'supporting' | 'secondary'

export type ResearchGoal = {
  id: string
  kind: ResearchGoalKind
  label: string
  important: boolean
  tier: GoalTier
  status: GoalStatus
  evidenceNote?: string
}

export type CandidateRejectReason =
  | 'wrong_date'
  | 'wrong_route'
  | 'generic_landing_page'
  | 'insufficient_evidence'
  | 'insufficient_day_specific_evidence'
  | 'aggregated_schedule'
  | 'fetch_blocked_js'
  | 'stale'
  | 'duplicate'
  | 'fetch_failed'
  | 'accepted_anchor'
  | 'accepted_partial'

export type CandidateDecision = {
  url: string
  query?: string
  goalIds: string[]
  decision: 'accepted' | 'rejected'
  reason: CandidateRejectReason
  note?: string
}

export type ResearchDiagnostics = {
  goals: ResearchGoal[]
  candidates: CandidateDecision[]
  toolRounds: number
  toolCallsUsed: number
  maxToolCalls: number
  forcedExtraRounds: number
  consultedSourceCount: number
  anchoredSourceCount: number
}

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractYmd(prompt: string): string[] {
  const out: string[] = []
  const iso = prompt.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)
  if (iso) out.push(...iso)
  const es = [
    ...prompt.matchAll(
      /\b(\d{1,2})\s*(?:de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic)[a-z]*\.?\s*(?:de\s+)?(20\d{2})\b/gi,
    ),
  ]
  const months: Record<string, string> = {
    ene: '01',
    feb: '02',
    mar: '03',
    abr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    ago: '08',
    sep: '09',
    sept: '09',
    oct: '10',
    nov: '11',
    dic: '12',
  }
  for (const m of es) {
    const d = String(m[1]).padStart(2, '0')
    const mo = months[m[2]!.toLowerCase().slice(0, 4)] ?? months[m[2]!.toLowerCase().slice(0, 3)]
    if (mo) out.push(`${m[3]}-${mo}-${d}`)
  }
  return [...new Set(out)]
}

/** Derive concrete research goals from a new_travel prompt. */
export function deriveResearchGoals(prompt: string): ResearchGoal[] {
  const p = norm(prompt)
  const goals: ResearchGoal[] = []
  const dates = extractYmd(prompt)

  const wantsFlight =
    /\bvuelo|\bvuelos|\bflight|\bmex\b|\bgdl\b|\baicm\b/.test(p)
  const wantsBus =
    /\bautobus|\bautobús|\bbus\b|\bcorrida|\bterminal/.test(p)
  const wantsHotel =
    /\bhotel|\bhoteles|\bhospedaje|\balojamiento|\bpernoctar|\bcontingencia/.test(
      p,
    )
  const wantsEvent =
    /\bserenata|\bferia|\bfiestas|\bactividades|\bevento/.test(p)
  const wantsTerminalAicm = /\bterminal\b/.test(p) && /\baicm|mex\b/.test(p)
  const wantsBusTerminal =
    /\bterminal\b/.test(p) &&
    (/\bguadalajara|\bgdl\b/.test(p) || /\bautobus|\bautobús|\bbus\b/.test(p))
  const wantsConnection =
    /\bviabilidad|\balcanzar|\bconexion|\bconexión|\bcumplir.*20:00|\bcorrida/.test(
      p,
    ) || /\b20:00\b/.test(prompt)

  const destTown =
    /san miguel el alto/.test(p)
      ? 'San Miguel el Alto'
      : /destino|pueblo|hospedaje en/.test(p)
        ? 'destino'
        : null

  if (wantsFlight) {
    goals.push({
      id: 'goal-flight-day',
      kind: 'flight_day_specific',
      label: dates.length
        ? `Vuelo day-specific (${dates.join(', ')})`
        : 'Vuelo day-specific (fecha del prompt)',
      important: true,
      tier: 'critical',
      status: 'UNRESOLVED',
    })
  }
  if (wantsTerminalAicm || (wantsFlight && /\bterminal\b/.test(p))) {
    goals.push({
      id: 'goal-airport-terminal',
      kind: 'airport_terminal',
      label: 'Terminal AICM / aeropuerto del vuelo',
      important: true,
      tier: 'supporting',
      status: 'UNRESOLVED',
    })
  }
  if (wantsBusTerminal || (wantsBus && /\bterminal\b/.test(p))) {
    goals.push({
      id: 'goal-bus-terminal',
      kind: 'bus_terminal',
      label: 'Terminal correcta GDL → destino terrestre',
      important: true,
      tier: 'supporting',
      status: 'UNRESOLVED',
    })
  }
  if (wantsConnection || (wantsBus && wantsFlight)) {
    goals.push({
      id: 'goal-connection',
      kind: 'connection_feasibility',
      label: 'Viabilidad de conexión con corrida terrestre',
      important: true,
      tier: 'supporting',
      status: 'UNRESOLVED',
    })
  }
  if (wantsHotel && (/\bcontingencia|\bcerca.*(terminal|autobus)|\bguadalajara/.test(p) || wantsBus)) {
    goals.push({
      id: 'goal-lodging-contingency',
      kind: 'lodging_contingency',
      label: 'Hotel contingencia cerca de terminal',
      important: true,
      tier: 'secondary',
      status: 'UNRESOLVED',
    })
  }
  if (wantsHotel || destTown) {
    goals.push({
      id: 'goal-lodging-dest',
      kind: 'lodging_destination',
      label: destTown
        ? `Hospedaje en ${destTown}`
        : 'Hospedaje en destino',
      important: true,
      tier: 'secondary',
      status: 'UNRESOLVED',
    })
  }
  if (wantsEvent) {
    goals.push({
      id: 'goal-event',
      kind: 'event_activities',
      label: dates.length
        ? `Serenata/actividades (${dates.join(', ')})`
        : 'Serenata/actividades del destino',
      important: true,
      tier: 'secondary',
      status: 'UNRESOLVED',
    })
  }
  if (wantsBus && !goals.some((g) => g.kind === 'ground_leg')) {
    goals.push({
      id: 'goal-ground',
      kind: 'ground_leg',
      label: 'Tramo terrestre / operador / horarios',
      important: true,
      tier: 'supporting',
      status: 'UNRESOLVED',
    })
  }

  // Always at least one catch-all if prompt asks to buscar/verificar but no match
  if (
    goals.length === 0 &&
    /\bbuscar|\bverificar|\binvestigar|\bconfirmar/.test(p)
  ) {
    goals.push({
      id: 'goal-other-research',
      kind: 'other',
      label: 'Investigación solicitada en el prompt',
      important: true,
      tier: 'supporting',
      status: 'UNRESOLVED',
    })
  }

  return goals
}

function listTraceSources(toolTrace: ToolTraceEntry[]): Array<{
  url: string
  title: string
  snippet: string
  query?: string
  tool: string
  ok: boolean
}> {
  const out: Array<{
    url: string
    title: string
    snippet: string
    query?: string
    tool: string
    ok: boolean
  }> = []
  for (const t of toolTrace) {
    const query =
      typeof t.args?.query === 'string'
        ? t.args.query
        : typeof t.args?.url === 'string'
          ? String(t.args.url)
          : undefined
    for (const s of t.sources ?? []) {
      if (!s.url) continue
      out.push({
        url: s.url,
        title: s.title ?? '',
        snippet: s.snippet ?? '',
        query,
        tool: t.tool,
        ok: t.ok,
      })
    }
    if (t.tool === 'fetchUrl' && typeof t.args?.url === 'string') {
      // fetchUrl may put content only in model payload; still record URL
      if (!out.some((x) => x.url === t.args!.url)) {
        out.push({
          url: String(t.args.url),
          title: '',
          snippet: t.ok ? 'fetchUrl ok' : t.error ?? 'fetch failed',
          query: String(t.args.url),
          tool: 'fetchUrl',
          ok: t.ok,
        })
      }
    }
  }
  return out
}

export function consultedSourceCount(toolTrace: ToolTraceEntry[]): number {
  const urls = new Set<string>()
  for (const s of listTraceSources(toolTrace)) {
    if (s.url) urls.add(s.url)
  }
  return urls.size
}

export function anchoredSourceCount(pkg: unknown): number {
  const p = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : {}
  const opts = Array.isArray(p.travelOptions) ? p.travelOptions : []
  const urls = new Set<string>()
  for (const o of opts) {
    if (!o || typeof o !== 'object') continue
    const url = (o as Record<string, unknown>).sourceUrl
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) urls.add(url)
  }
  return urls.size
}

function isGenericLanding(url: string, title: string, snippet: string): boolean {
  const u = url.toLowerCase()
  const blob = norm(`${title} ${snippet}`)
  if (/\/vuelos-a-|\/flights-to-|\/hoteles\/|\/hotels-near-/.test(u)) {
    if (!/\b\d{1,2}:\d{2}\b/.test(snippet) && !/\b20\d{2}-\d{2}-\d{2}\b/.test(snippet)) {
      return true
    }
  }
  if (/busca en nuestra pagina|book a hotel|special offers|vuelos baratos a/.test(blob)) {
    return true
  }
  return false
}

export function isFetchBlockedJs(snippet: string, title = ''): boolean {
  const blob = norm(`${title} ${snippet}`)
  return (
    /javascript is disabled/.test(blob) ||
    /verify that you.?re not a robot/.test(blob) ||
    /enable javascript and then reload/.test(blob) ||
    /captcha|cf-browser-verification|attention required/.test(blob) ||
    (/em_server_data/.test(blob) && /fare-daily-histogram/.test(blob)) ||
    (/window\[.em_server_data/.test(blob) && !/\b\d{1,2}:\d{2}\b/.test(snippet))
  )
}

export function isAggregatedScheduleSnippet(snippet: string, title = ''): boolean {
  const blob = norm(`${title} ${snippet}`)
  return (
    /\b\d+\s+vuelos?\s+por\s+semana\b/.test(blob) ||
    /\b\d+\s+vuelos?\s+al\s+d[ií]a\b/.test(blob) ||
    /horas de salida var[ií]an/.test(blob) ||
    /weekly\s+flights|flights?\s+per\s+week/.test(blob)
  )
}

export function isFlightResearchQuery(query: string): boolean {
  const q = norm(query)
  return (
    /\bvuelo|\bflight|\baeromexico|\bvolaris|\bviva\b/.test(q) ||
    (/\bmex\b/.test(q) && /\bgdl\b/.test(q)) ||
    /flight schedule|horario.*vuelo/.test(q)
  )
}

export function isSecondaryResearchQuery(query: string): boolean {
  const q = norm(query)
  if (isFlightResearchQuery(q)) return false
  return (
    /\bhotel|\bhoteles|\bhospedaje|\balojamiento|\bairbnb\b/.test(q) ||
    /\bserenata|\bferia|\bfiestas|\bactividades|\bevento|\bcartelera\b/.test(q)
  )
}

export function isDirectedFlightRetryQuery(query: string): boolean {
  const q = norm(query)
  if (!isFlightResearchQuery(q)) return false
  // Carrier- or schedule-specific — not merely "19 septiembre" in a generic ask.
  return (
    /\baeromexico|\bvolaris|\bviva\b|\bamerican airlines\b/.test(q) ||
    /flight schedule|horario(s)? (de )?vuelo/.test(q)
  )
}

/** True when blob has trip date + route + clock + carrier-ish token. */
export function hasDaySpecificFlightEvidenceInText(
  text: string,
  tripDates: string[],
): boolean {
  const blob = norm(text)
  if (!tripDates.length) return false
  const hasDate =
    tripDates.some((d) => {
      const [y, m, day] = d.split('-')
      if (!y || !m || !day) return false
      return (
        blob.includes(d) ||
        blob.includes(`${day}/${m}/${y}`) ||
        blob.includes(`${m}/${day}/${y}`) ||
        // Spanish: 19 septiembre 2026 / 19 sep 2026
        new RegExp(
          `\\b${Number(day)}\\s*(de\\s+)?(sep|sept|septiembre)\\.?\\s*(de\\s+)?${y}\\b`,
        ).test(blob)
      )
    }) || false
  if (!hasDate) return false
  const hasRoute =
    (/\bmex\b/.test(blob) && /\bgdl\b/.test(blob)) ||
    (/ciudad de mexico|cdmx|mexico city/.test(blob) &&
      /guadalajara/.test(blob))
  if (!hasRoute) return false
  if (!/\b\d{1,2}:\d{2}\b/.test(text)) return false
  if (
    !/\baeromexico|\bvolaris|\bviva|\bamerican|\bairline|\baerolinea|\boperad|\bvuelo\s+[a-z]?\d/i.test(
      blob,
    )
  ) {
    return false
  }
  return true
}

function flightOptionHasConcreteArrival(opt: Record<string, unknown>): boolean {
  if (String(opt.type ?? '') !== 'flight') return false
  const start = String(opt.startAt ?? '')
  const end = String(opt.endAt ?? '')
  // Need real clock, not bare date
  return /T\d{2}:\d{2}/.test(start) || /T\d{2}:\d{2}/.test(end)
}

function snippetHasWrongDate(
  snippet: string,
  title: string,
  tripDates: string[],
): boolean {
  if (!tripDates.length) return false
  const blob = `${title} ${snippet}`
  const found = blob.match(/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/g) ?? []
  const found2 = blob.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/g) ?? []
  const norms: string[] = []
  for (const f of found) {
    const m = f.match(/(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})/)
    if (m) {
      norms.push(
        `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`,
      )
    }
  }
  for (const f of found2) {
    const m = f.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})/)
    if (m) {
      norms.push(
        `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`,
      )
    }
  }
  if (!norms.length) return false
  return norms.every((d) => !tripDates.includes(d))
}

function goalMatchesSource(
  goal: ResearchGoal,
  src: { url: string; title: string; snippet: string; query?: string },
): boolean {
  const blob = norm(`${src.url} ${src.title} ${src.snippet} ${src.query ?? ''}`)
  switch (goal.kind) {
    case 'flight_day_specific':
      return /vuelo|flight|aeromexico|volaris|viva|aicm|\bmex\b|\bgdl\b/.test(
        blob,
      )
    case 'airport_terminal':
      return /terminal|aicm|aeropuerto|airport/.test(blob)
    case 'bus_terminal':
      return /terminal|central|autobus|autobús|bus station/.test(blob)
    case 'connection_feasibility':
      return /autobus|autobús|corrida|conexion|conexión|horario|terminal/.test(
        blob,
      )
    case 'lodging_contingency':
      return /hotel|hospedaje|central|terminal|guadalajara/.test(blob)
    case 'lodging_destination':
      return /hotel|hospedaje|airbnb|san miguel/.test(blob)
    case 'event_activities':
      return /feria|serenata|fiesta|evento|cartelera|palenque/.test(blob)
    case 'ground_leg':
      return /autobus|autobús|bus|corrida|ruta/.test(blob)
    default:
      return true
  }
}

/** Classify each consulted URL for internal diagnostics (not UX cards). */
export function classifyCandidates(
  toolTrace: ToolTraceEntry[],
  goals: ResearchGoal[],
  tripDates: string[],
): CandidateDecision[] {
  const seen = new Set<string>()
  const decisions: CandidateDecision[] = []
  for (const src of listTraceSources(toolTrace)) {
    if (seen.has(src.url)) {
      if (src.tool === 'fetchUrl' && isFetchBlockedJs(src.snippet, src.title)) {
        decisions.push({
          url: src.url,
          query: src.query,
          goalIds: goals
            .filter((g) => goalMatchesSource(g, src))
            .map((g) => g.id),
          decision: 'rejected',
          reason: 'fetch_blocked_js',
          note: 'JS shell / captcha / anti-bot on fetchUrl',
        })
      } else {
        decisions.push({
          url: src.url,
          query: src.query,
          goalIds: [],
          decision: 'rejected',
          reason: 'duplicate',
        })
      }
      continue
    }
    seen.add(src.url)

    if (src.tool === 'fetchUrl' && !src.ok) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds: goals.filter((g) => goalMatchesSource(g, src)).map((g) => g.id),
        decision: 'rejected',
        reason: 'fetch_failed',
        note: src.snippet,
      })
      continue
    }

    const matched = goals.filter((g) => goalMatchesSource(g, src))
    const goalIds = matched.map((g) => g.id)

    if (src.tool === 'fetchUrl' && src.ok && isFetchBlockedJs(src.snippet, src.title)) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds,
        decision: 'rejected',
        reason: 'fetch_blocked_js',
        note: 'JS shell / captcha / anti-bot — no day-specific schedule extracted',
      })
      continue
    }

    if (snippetHasWrongDate(src.snippet, src.title, tripDates)) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds,
        decision: 'rejected',
        reason: 'wrong_date',
      })
      continue
    }

    if (isAggregatedScheduleSnippet(src.snippet, src.title)) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds,
        decision: 'rejected',
        reason: 'aggregated_schedule',
        note: 'weekly/daily aggregate — not a day-specific inventory',
      })
      continue
    }

    if (isGenericLanding(src.url, src.title, src.snippet)) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds,
        decision: 'rejected',
        reason: 'generic_landing_page',
      })
      continue
    }

    // Flight-ish hit without day-specific evidence for trip dates
    const flightish = matched.some((g) => g.kind === 'flight_day_specific')
    if (
      flightish &&
      tripDates.length > 0 &&
      !hasDaySpecificFlightEvidenceInText(
        `${src.title}\n${src.snippet}`,
        tripDates,
      )
    ) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds,
        decision: 'rejected',
        reason: 'insufficient_day_specific_evidence',
      })
      continue
    }

    // Named lodging / event pages without schedule/price → partial candidate
    const namedHotel =
      /hotel|posada|hospedaje/.test(norm(src.title + src.snippet)) &&
      /san miguel|guadalajara|central/.test(norm(src.title + src.url))
    const namedEvent =
      /feria|serenata|fiesta 2026|cartelera/.test(norm(src.title + src.snippet))

    if (
      flightish &&
      hasDaySpecificFlightEvidenceInText(
        `${src.title}\n${src.snippet}`,
        tripDates,
      )
    ) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds,
        decision: 'accepted',
        reason: 'accepted_partial',
        note: 'day-specific flight candidate — fetchUrl/refine before verified',
      })
      continue
    }

    if (src.tool === 'fetchUrl' && src.ok) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds,
        decision: 'accepted',
        reason: 'accepted_partial',
        note: 'fetchUrl completed — model must still justify verified vs estimated',
      })
      continue
    }

    if (namedHotel || namedEvent) {
      decisions.push({
        url: src.url,
        query: src.query,
        goalIds,
        decision: 'accepted',
        reason: 'accepted_partial',
        note: 'promising candidate — needs fetchUrl or explicit insufficient_evidence if not anchored',
      })
      continue
    }

    decisions.push({
      url: src.url,
      query: src.query,
      goalIds,
      decision: 'rejected',
      reason: 'insufficient_evidence',
    })
  }
  return decisions
}

function queriesUsed(toolTrace: ToolTraceEntry[]): string[] {
  const out: string[] = []
  for (const t of toolTrace) {
    if (t.tool === 'webSearch' && typeof t.args?.query === 'string') {
      out.push(t.args.query)
    }
  }
  return out
}

function hasFetchForGoals(
  toolTrace: ToolTraceEntry[],
  goals: ResearchGoal[],
): boolean {
  return toolTrace.some(
    (t) =>
      t.tool === 'fetchUrl' &&
      t.ok &&
      goals.some((g) =>
        goalMatchesSource(g, {
          url: String(t.args?.url ?? ''),
          title: '',
          snippet: '',
          query: String(t.args?.url ?? ''),
        }),
      ),
  )
}

export function optionAnchorsGoal(
  goal: ResearchGoal,
  opt: Record<string, unknown>,
  opts?: { allOptions?: Record<string, unknown>[] },
): 'RESOLVED' | 'PARTIAL' | null {
  const url = typeof opt.sourceUrl === 'string' ? opt.sourceUrl : ''
  const v = String(opt.verificationStatus ?? '')
  const type = String(opt.type ?? '')
  const title = norm(String(opt.title ?? ''))
  const notes = norm(String(opt.notes ?? ''))
  const place = norm(String(opt.place ?? opt.address ?? ''))
  const blob = `${title} ${notes} ${place} ${type} ${norm(url)}`

  const kindOk = (() => {
    switch (goal.kind) {
      case 'flight_day_specific':
        return type === 'flight'
      case 'airport_terminal': {
        // Must be airport-related — bus central SMA must NOT match via "terminal".
        if (type === 'flight') {
          return /aicm|aeropuerto|airport|terminal\s*[12]|terminal nacional/.test(
            blob,
          )
        }
        if (type === 'transfer') {
          return /aeropuerto|airport|aicm/.test(blob)
        }
        return false
      }
      case 'bus_terminal':
        return (
          ['bus', 'train', 'transfer'].includes(type) &&
          /terminal|central|autobus|autobús|bus station/.test(blob)
        )
      case 'ground_leg':
        return ['bus', 'train', 'transfer'].includes(type)
      case 'connection_feasibility': {
        // Cannot resolve without a flight that has a concrete arrival clock.
        const flights = (opts?.allOptions ?? []).filter(
          (o) => String(o.type ?? '') === 'flight',
        )
        const hasArrival = flights.some((f) => flightOptionHasConcreteArrival(f))
        if (!hasArrival) return false
        return ['bus', 'train', 'transfer'].includes(type)
      }
      case 'lodging_contingency':
        return type === 'lodging' && /guadalajara|terminal|contingencia/.test(blob)
      case 'lodging_destination':
        return type === 'lodging' && /san miguel|destino|alto/.test(blob)
      case 'event_activities':
        return (
          ['activity', 'event'].includes(type) ||
          /serenata|feria|fiesta/.test(blob)
        )
      default:
        return Boolean(url)
    }
  })()

  if (!kindOk) return null
  // Published schedule provider: estimated + flight_schedule + clocks + carrier + https
  if (goal.kind === 'flight_day_specific') {
    const provider = String(opt.provider ?? opt.carrier ?? '').trim()
    if (
      String(opt.sourceType ?? '') === 'flight_schedule' &&
      (v === 'estimated' || v === 'verified') &&
      flightOptionHasConcreteArrival(opt) &&
      provider &&
      /^https?:\/\//i.test(url)
    ) {
      return 'RESOLVED'
    }
  }
  if (v === 'verified' && /^https?:\/\//i.test(url)) return 'RESOLVED'
  if (/^https?:\/\//i.test(url)) return 'PARTIAL'
  return null
}

/**
 * Assess goal status from toolTrace (+ optional package after final).
 * Snippet-only hits ⇒ at best PARTIAL; verified requires anchored sourceUrl.
 */
export function assessResearchGoals(
  goals: ResearchGoal[],
  toolTrace: ToolTraceEntry[],
  opts?: {
    package?: unknown
    tripDates?: string[]
  },
): ResearchGoal[] {
  const tripDates = opts?.tripDates ?? []
  const candidates = classifyCandidates(toolTrace, goals, tripDates)
  const pkg = opts?.package && typeof opts.package === 'object'
    ? (opts.package as Record<string, unknown>)
    : null
  const options = Array.isArray(pkg?.travelOptions)
    ? (pkg!.travelOptions as Record<string, unknown>[])
    : []
  const itinerary = Array.isArray(pkg?.itineraryItems)
    ? (pkg!.itineraryItems as Record<string, unknown>[])
    : []

  return goals.map((g) => {
    let status: GoalStatus = 'UNRESOLVED'
    let evidenceNote: string | undefined

    // connection_feasibility: hard gate — no flight arrival ⇒ cannot RESOLVE
    if (g.kind === 'connection_feasibility') {
      const hasArrival = options.some((o) => flightOptionHasConcreteArrival(o))
      if (!hasArrival) {
        const busHit = options.some(
          (o) =>
            ['bus', 'train', 'transfer'].includes(String(o.type ?? '')) &&
            typeof o.sourceUrl === 'string' &&
            /^https?:\/\//i.test(String(o.sourceUrl)),
        )
        return {
          ...g,
          status: busHit ? 'PARTIAL' : 'UNRESOLVED',
          evidenceNote: busHit
            ? 'bus evidence present but flight arrival unknown — cannot evaluate connection'
            : 'flight arrival unknown — connection feasibility unresolved',
        }
      }
    }

    for (const o of options) {
      const hit = optionAnchorsGoal(g, o, { allOptions: options })
      if (hit === 'RESOLVED') {
        // flight_day_specific RESOLVED only with concrete schedule fields
        if (g.kind === 'flight_day_specific') {
          const ok =
            flightOptionHasConcreteArrival(o) &&
            Boolean(String(o.provider ?? o.carrier ?? '').trim()) &&
            typeof o.sourceUrl === 'string' &&
            /^https?:\/\//i.test(String(o.sourceUrl))
          if (!ok) {
            status = 'PARTIAL'
            evidenceNote = `flight anchored but missing day-specific fields (startAt/provider)`
            continue
          }
        }
        status = 'RESOLVED'
        evidenceNote = `anchored ${String(o.sourceUrl)}`
        break
      }
      if (hit === 'PARTIAL') {
        status = 'PARTIAL'
        evidenceNote = `sourceUrl without verified: ${String(o.sourceUrl)}`
      }
    }

    if (status !== 'RESOLVED' && g.kind === 'event_activities') {
      for (const i of itinerary) {
        const url = typeof i.sourceUrl === 'string' ? i.sourceUrl : ''
        const notes = norm(String(i.notes ?? ''))
        if (/^https?:\/\//i.test(url)) {
          status =
            String(i.verificationStatus) === 'verified' ? 'RESOLVED' : 'PARTIAL'
          evidenceNote = url
        } else if (/pendiente de verificar|objetivo del viajero/.test(notes)) {
          // still unresolved unless we have candidate evidence
        }
      }
    }

    if (status === 'UNRESOLVED') {
      // Published schedule tool results count as PARTIAL until package-anchored
      if (
        g.kind === 'flight_day_specific' &&
        toolTrace.some(
          (t) =>
            t.tool === 'searchFlightSchedules' &&
            t.ok &&
            (t.sources?.length ?? 0) > 0,
        )
      ) {
        status = 'PARTIAL'
        evidenceNote =
          'searchFlightSchedules returned published schedules — map into flight options (estimated + flight_schedule)'
      }
    }

    if (status === 'UNRESOLVED') {
      const related = candidates.filter(
        (c) => c.goalIds.includes(g.id) && c.decision === 'accepted',
      )
      const rejectedOnly = candidates.filter(
        (c) => c.goalIds.includes(g.id) && c.decision === 'rejected',
      )
      if (related.length > 0) {
        status = 'PARTIAL'
        evidenceNote =
          related[0]!.reason === 'accepted_partial'
            ? 'candidate hits — not yet anchored/verified'
            : related[0]!.reason
      } else if (
        hasFetchForGoals(toolTrace, [g]) ||
        toolTrace.some(
          (t) =>
            t.tool === 'webSearch' &&
            t.ok &&
            (t.sources?.length ?? 0) > 0 &&
            goalMatchesSource(g, {
              url: t.sources?.[0]?.url ?? '',
              title: t.sources?.[0]?.title ?? '',
              snippet: t.sources?.[0]?.snippet ?? '',
              query: String(t.args?.query ?? ''),
            }),
        )
      ) {
        // Had search results but all rejected as generic/wrong_date
        if (rejectedOnly.length > 0) {
          status = 'UNRESOLVED'
          evidenceNote = `hits rejected: ${rejectedOnly[0]!.reason}`
        } else {
          status = 'PARTIAL'
          evidenceNote = 'search hits without usable classification'
        }
      }
    }

    return { ...g, status, evidenceNote }
  })
}

export function countFlightWebSearches(toolTrace: ToolTraceEntry[]): number {
  return toolTrace.filter(
    (t) =>
      t.tool === 'webSearch' &&
      t.ok &&
      typeof t.args?.query === 'string' &&
      isFlightResearchQuery(t.args.query),
  ).length
}

export function countScheduleSearches(toolTrace: ToolTraceEntry[]): number {
  return toolTrace.filter((t) => t.tool === 'searchFlightSchedules').length
}

export function hasScheduleSearchAttempt(toolTrace: ToolTraceEntry[]): boolean {
  return countScheduleSearches(toolTrace) >= 1
}

export function countDirectedFlightRetries(toolTrace: ToolTraceEntry[]): number {
  return toolTrace.filter(
    (t) =>
      t.tool === 'webSearch' &&
      t.ok &&
      typeof t.args?.query === 'string' &&
      isDirectedFlightRetryQuery(t.args.query),
  ).length
}

export function hasFlightFetchAttempt(toolTrace: ToolTraceEntry[]): boolean {
  return toolTrace.some((t) => {
    if (t.tool !== 'fetchUrl') return false
    const url = String(t.args?.url ?? '')
    return /volaris|aeromexico|viva|flight|vuelo|kayak|skyscanner|expedia|google\.com\/travel\/flights|flightconnections/i.test(
      url,
    )
  })
}

export function buildDirectedFlightRetryQueries(input: {
  prompt: string
  tripDates: string[]
  usedQueries: string[]
}): string[] {
  const used = new Set(input.usedQueries.map((q) => norm(q)))
  const p = norm(input.prompt)
  const date = input.tripDates[0] ?? ''
  const dateHuman = date
    ? (() => {
        const [y, m, d] = date.split('-')
        const months = [
          '',
          'Jan',
          'Feb',
          'Mar',
          'Apr',
          'May',
          'Jun',
          'Jul',
          'Aug',
          'Sep',
          'Oct',
          'Nov',
          'Dec',
        ]
        return `${d} ${months[Number(m)] ?? m} ${y}`
      })()
    : ''
  const origin = /\bmex\b|ciudad de mexico|cdmx|aicm/.test(p) ? 'MEX' : 'origin'
  const dest = /\bgdl\b|guadalajara/.test(p) ? 'GDL' : 'destination'
  const carriers = ['Aeromexico', 'Volaris', 'Viva']
  const out: string[] = []
  for (const c of carriers) {
    const q = `${origin} ${dest} ${dateHuman} ${c}`.trim()
    if (q && !used.has(norm(q))) out.push(q)
  }
  const schedule = `${origin} ${dest} ${dateHuman} flight schedule`.trim()
  if (schedule && !used.has(norm(schedule))) out.push(schedule)
  return out.slice(0, 3)
}

/**
 * First flight search only yielded bad evidence → need one directed retry
 * before secondary lodging/event research.
 */
export function needsFlightDirectedRetry(input: {
  goals: ResearchGoal[]
  toolTrace: ToolTraceEntry[]
  tripDates: string[]
}): boolean {
  const flight = input.goals.find((g) => g.kind === 'flight_day_specific')
  if (!flight) return false
  if (flight.status === 'RESOLVED') return false
  // Prefer searchFlightSchedules before any web directed retry
  if (!hasScheduleSearchAttempt(input.toolTrace)) return true
  if (countFlightWebSearches(input.toolTrace) < 1) return false
  if (countDirectedFlightRetries(input.toolTrace) >= 1) return false
  // Already have day-specific candidate text somewhere
  for (const t of input.toolTrace) {
    for (const s of t.sources ?? []) {
      if (
        hasDaySpecificFlightEvidenceInText(
          `${s.title ?? ''}\n${s.snippet ?? ''}`,
          input.tripDates,
        )
      ) {
        return false
      }
    }
  }
  const decisions = classifyCandidates(
    input.toolTrace,
    input.goals,
    input.tripDates,
  ).filter((c) => c.goalIds.includes(flight.id))
  if (decisions.length === 0) return true
  const bad = new Set([
    'wrong_date',
    'generic_landing_page',
    'insufficient_evidence',
    'insufficient_day_specific_evidence',
    'aggregated_schedule',
    'fetch_blocked_js',
    'fetch_failed',
    'wrong_route',
    'duplicate',
  ])
  return decisions.every(
    (c) => c.decision === 'rejected' && bad.has(c.reason),
  )
}

/** Critical flight attempt finished (success or exhausted) — secondary may run. */
export function flightCriticalAttemptExhausted(input: {
  goals: ResearchGoal[]
  toolTrace: ToolTraceEntry[]
  tripDates: string[]
}): boolean {
  const flight = input.goals.find((g) => g.kind === 'flight_day_specific')
  if (!flight) return true
  if (flight.status === 'RESOLVED' || flight.status === 'PARTIAL') return true
  // One schedule-provider attempt (ok or empty/error) unlocks web fallback / secondary
  if (hasScheduleSearchAttempt(input.toolTrace)) return true
  for (const t of input.toolTrace) {
    for (const s of t.sources ?? []) {
      if (
        hasDaySpecificFlightEvidenceInText(
          `${s.title ?? ''}\n${s.snippet ?? ''}`,
          input.tripDates,
        )
      ) {
        return true
      }
    }
  }
  // Directed retry done + fetch attempted (or nothing worth fetching)
  if (countDirectedFlightRetries(input.toolTrace) >= 1) {
    const accepted = classifyCandidates(
      input.toolTrace,
      input.goals,
      input.tripDates,
    ).filter(
      (c) =>
        c.goalIds.includes(flight.id) && c.decision === 'accepted',
    )
    if (accepted.length === 0) return true
    if (hasFlightFetchAttempt(input.toolTrace)) return true
    // accepted candidates exist but no fetch yet — not exhausted
    return false
  }
  // 2+ flight searches without directed flag still counts as exhausted attempt
  if (countFlightWebSearches(input.toolTrace) >= 2) return true
  return false
}

export function shouldDeferSecondaryResearch(input: {
  goals: ResearchGoal[]
  toolTrace: ToolTraceEntry[]
  tripDates: string[]
}): boolean {
  const flight = input.goals.find((g) => g.kind === 'flight_day_specific')
  if (!flight) return false
  if (flight.status === 'RESOLVED') return false
  return !flightCriticalAttemptExhausted(input)
}

/** Whether a pending tool call should be skipped to protect critical flight budget. */
export function shouldSkipToolCallForFlightPriority(input: {
  toolName: string
  argsJson: string
  goals: ResearchGoal[]
  toolTrace: ToolTraceEntry[]
  tripDates: string[]
}): boolean {
  if (input.toolName === 'searchFlightSchedules') return false

  const flight = input.goals.find((g) => g.kind === 'flight_day_specific')
  if (
    flight &&
    flight.status !== 'RESOLVED' &&
    !hasScheduleSearchAttempt(input.toolTrace) &&
    (input.toolName === 'webSearch' || input.toolName === 'fetchUrl') &&
    !flightCriticalAttemptExhausted(input)
  ) {
    // Force schedule provider before more web/fetch while critical attempt open
    return true
  }

  if (!shouldDeferSecondaryResearch(input)) return false
  if (input.toolName === 'webSearch') {
    let query = ''
    try {
      const parsed = JSON.parse(input.argsJson) as { query?: string }
      query = parsed.query ?? ''
    } catch {
      query = input.argsJson
    }
    return isSecondaryResearchQuery(query)
  }
  if (input.toolName === 'fetchUrl') {
    let url = ''
    try {
      const parsed = JSON.parse(input.argsJson) as { url?: string }
      url = parsed.url ?? ''
    } catch {
      url = input.argsJson
    }
    // Allow flight fetches; defer hotel/event pages
    if (/hotel|airbnb|booking\.|trivago|tripadvisor|serenata|feria/i.test(url)) {
      return true
    }
  }
  return false
}

export function shouldForceAnotherResearchRound(input: {
  goals: ResearchGoal[]
  toolCallsUsed: number
  maxToolCalls: number
  steps: number
  maxSteps: number
  forcedExtraRounds: number
  maxForcedRounds?: number
  /** True when at least one successful fetchUrl exists in toolTrace. */
  hasSuccessfulFetch?: boolean
  toolTrace?: ToolTraceEntry[]
  tripDates?: string[]
}): boolean {
  const maxForced = input.maxForcedRounds ?? 2
  if (input.forcedExtraRounds >= maxForced) return false
  if (input.toolCallsUsed >= input.maxToolCalls) return false
  if (input.steps >= input.maxSteps - 1) return false

  // Prefer critical flight directed retry before other open goals
  if (
    input.toolTrace &&
    needsFlightDirectedRetry({
      goals: input.goals,
      toolTrace: input.toolTrace,
      tripDates: input.tripDates ?? [],
    })
  ) {
    return true
  }

  const criticalOpen = input.goals.filter(
    (g) =>
      g.tier === 'critical' &&
      (g.status === 'UNRESOLVED' || g.status === 'PARTIAL'),
  )
  if (
    criticalOpen.length > 0 &&
    input.toolTrace &&
    !flightCriticalAttemptExhausted({
      goals: input.goals,
      toolTrace: input.toolTrace,
      tripDates: input.tripDates ?? [],
    })
  ) {
    return true
  }

  const importantOpen = input.goals.filter(
    (g) => g.important && g.status === 'UNRESOLVED',
  )
  if (importantOpen.length > 0) return true
  // PARTIAL without any fetchUrl yet → push directed fetch/refine once
  const importantPartial = input.goals.filter(
    (g) => g.important && g.status === 'PARTIAL',
  )
  if (importantPartial.length > 0 && !input.hasSuccessfulFetch) return true
  return false
}

export function buildDirectedResearchNudge(input: {
  goals: ResearchGoal[]
  toolTrace: ToolTraceEntry[]
  tripDates: string[]
  prompt?: string
}): string {
  const used = queriesUsed(input.toolTrace)
  const flightRetry = needsFlightDirectedRetry({
    goals: input.goals,
    toolTrace: input.toolTrace,
    tripDates: input.tripDates,
  })
  const open = input.goals.filter(
    (g) => g.status === 'UNRESOLVED' || g.status === 'PARTIAL',
  )
  const candidates = classifyCandidates(
    input.toolTrace,
    input.goals,
    input.tripDates,
  ).filter((c) => c.decision === 'accepted')

  if (flightRetry) {
    const suggested = buildDirectedFlightRetryQueries({
      prompt: input.prompt ?? '',
      tripDates: input.tripDates,
      usedQueries: used,
    })
    const flightCands = candidates.filter((c) =>
      c.goalIds.some((id) => id.includes('flight')),
    )
    const needSchedule = !hasScheduleSearchAttempt(input.toolTrace)
    const lines: string[] = [
      'RESEARCH COVERAGE GATE (server): critical goal flight_day_specific remains UNRESOLVED.',
      'Do NOT spend tool budget on lodging/hotels/events yet.',
      'Snippets are candidates only — never verificationStatus=verified from a Tavily snippet alone.',
      'Do NOT repeat prior webSearch queries verbatim.',
      '',
      'Required now (pick within remaining budget):',
      ...(needSchedule
        ? [
            '- Call searchFlightSchedules({ origin, destination, date }) FIRST (published schedules; not fares/availability).',
            '- Map results as verificationStatus=estimated, sourceType=flight_schedule, notes with HORARIO PUBLICADO warning.',
            '- Only if searchFlightSchedules fails/empty: fall back to webSearch/fetchUrl for day-specific schedules.',
          ]
        : [
            ...suggested.map((q) => `- webSearch: ${q}`),
            '- If a candidate URL looks day-specific, fetchUrl it BEFORE lodging searches.',
          ]),
      '',
      'Success criteria for flight_day_specific (does NOT auto-verify booking):',
      'origin + destination + requested date + concrete departureTime + carrier + https sourceUrl.',
      'Prefer searchFlightSchedules → estimated + flight_schedule (HORARIO PUBLICADO). Never invent schedules.',
    ]
    if (flightCands.length) {
      lines.push('', 'Promising flight URLs to fetchUrl:')
      for (const c of flightCands.slice(0, 5)) {
        lines.push(`- ${c.url}`)
      }
    }
    if (used.length) {
      lines.push('', 'Queries already used (do not repeat):')
      for (const q of used) lines.push(`- ${q}`)
    }
    return lines.join('\n')
  }

  const lines: string[] = [
    'RESEARCH COVERAGE GATE (server): important goals remain UNRESOLVED or PARTIAL.',
    'You still have tool budget. Do NOT convert these into checklist-only yet.',
    'Snippets from webSearch are CANDIDATE evidence — never set verificationStatus=verified from a Tavily snippet alone.',
    'Prefer: fetchUrl on promising candidate URLs, OR a refined day-specific/operator/terminal/event query.',
    'Do NOT repeat prior webSearch queries verbatim.',
    '',
    'Open goals:',
    ...open.map(
      (g) =>
        `- [${g.status}] ${g.id} (${g.kind}/${g.tier}): ${g.label}${g.evidenceNote ? ` — ${g.evidenceNote}` : ''}`,
    ),
  ]

  if (candidates.length) {
    lines.push('', 'Promising candidate URLs (fetchUrl or refine):')
    for (const c of candidates.slice(0, 8)) {
      lines.push(`- ${c.url} (${c.reason}) goals=${c.goalIds.join(',') || '—'}`)
    }
  }

  if (used.length) {
    lines.push('', 'Queries already used (do not repeat):')
    for (const q of used) lines.push(`- ${q}`)
  }

  lines.push(
    '',
    'Suggested directed actions (pick what fits remaining budget):',
    '- fetchUrl on a promising flight/hotel/event candidate',
    '- refined webSearch with exact date + route + carrier',
    '- webSearch terminal AICM / bus operator only after flight attempt is exhausted',
    '',
    'When evidence is still insufficient after this round: leave estimated/pending/UNKNOWN and checklist ONLY for what remains unresolved.',
  )

  return lines.join('\n')
}

/**
 * Strip / rewrite free-text factual assertions that claim search-backed facts
 * without anchored provenance (notes/warnings). Targeted patterns — not full NLP.
 */
export function scrubUnsupportedFreeTextAssertions(
  draft: Record<string, unknown>,
  toolTrace: ToolTraceEntry[],
): string[] {
  const warnings: string[] = []
  const consulted = listTraceSources(toolTrace).map((s) =>
    norm(`${s.url} ${s.title} ${s.snippet}`),
  )

  const rewrite = (text: string, where: string): string => {
    let next = text
    // "se asume como X basada en búsqueda…" → UNKNOWN
    next = next.replace(
      /La terminal de autobuses en Guadalajara[^.]*se asume como ([^.]+?)(?:\s+basada en búsqueda[^.]*)?\./gi,
      (_m, name: string) => {
        warnings.push(
          `server: afirmación de terminal sin provenance anclada degradada a UNKNOWN (${where}).`,
        )
        return `Terminal de autobuses en Guadalajara para la ruta solicitada: UNKNOWN — pendiente de verificar (hipótesis «${String(name).trim()}» no anclada a sourceUrl).`
      },
    )
    next = next.replace(
      /([^.]{0,80}?)\bse asume como\b([^.]{0,120}?)\bbasad[oa]s? en búsqueda[^.]{0,80}\./gi,
      (_m, pre: string, mid: string) => {
        warnings.push(
          `server: afirmación «basada en búsqueda» sin provenance anclada degradada (${where}).`,
        )
        return `${pre}UNKNOWN/pendiente de verificar — hipótesis no verificada (${String(mid).trim()}), no presentada como hallazgo anclado.`
      },
    )
    // Soft: "basada en búsqueda de hoteles" claiming a fact
    if (
      /\bbasad[oa]s? en búsqueda\b/i.test(next) &&
      !consulted.some((c) => /central nueva/.test(c) && /autobuses/.test(c))
    ) {
      // already handled by replaces; if remnant remains claiming certainty:
      if (/\bse (?:asume|determina|confirma)\b.*\bbúsqueda\b/i.test(next)) {
        next = next.replace(
          /\bse (?:asume|determina|confirma)\b/gi,
          'queda como hipótesis no verificada;',
        )
        warnings.push(
          `server: redacción de certeza por búsqueda suavizada en ${where}.`,
        )
      }
    }
    return next
  }

  if (typeof draft.narrative === 'string') {
    draft.narrative = rewrite(draft.narrative, 'narrative')
  }
  if (Array.isArray(draft.warnings)) {
    draft.warnings = draft.warnings.map((w, i) =>
      typeof w === 'string' ? rewrite(w, `warnings[${i}]`) : w,
    )
  }
  const pkg =
    draft.package && typeof draft.package === 'object'
      ? (draft.package as Record<string, unknown>)
      : null
  if (pkg && Array.isArray(pkg.notes)) {
    pkg.notes = pkg.notes.map((n, i) => {
      if (!n || typeof n !== 'object') return n
      const rec = { ...(n as Record<string, unknown>) }
      if (typeof rec.body === 'string') {
        rec.body = rewrite(rec.body, `notes[${i}].body`)
      }
      return rec
    })
  }
  if (pkg && Array.isArray(pkg.travelOptions)) {
    pkg.travelOptions = pkg.travelOptions.map((o, i) => {
      if (!o || typeof o !== 'object') return o
      const rec = { ...(o as Record<string, unknown>) }
      if (typeof rec.notes === 'string') {
        rec.notes = rewrite(rec.notes, `travelOptions[${i}].notes`)
      }
      if (typeof rec.description === 'string') {
        rec.description = rewrite(
          rec.description,
          `travelOptions[${i}].description`,
        )
      }
      return rec
    })
  }
  return warnings
}

export function buildResearchDiagnostics(input: {
  goals: ResearchGoal[]
  toolTrace: ToolTraceEntry[]
  toolRounds: number
  toolCallsUsed: number
  maxToolCalls: number
  forcedExtraRounds: number
  package?: unknown
  tripDates?: string[]
}): ResearchDiagnostics {
  const goals = assessResearchGoals(input.goals, input.toolTrace, {
    package: input.package,
    tripDates: input.tripDates,
  })
  const candidates = classifyCandidates(
    input.toolTrace,
    goals,
    input.tripDates ?? [],
  )
  // Mark accepted_anchor when package actually has that URL
  const anchored = new Set<string>()
  const pkg = input.package && typeof input.package === 'object'
    ? (input.package as Record<string, unknown>)
    : null
  if (Array.isArray(pkg?.travelOptions)) {
    for (const o of pkg!.travelOptions as Record<string, unknown>[]) {
      if (typeof o.sourceUrl === 'string') anchored.add(o.sourceUrl)
    }
  }
  const candidatesFinal = candidates.map((c) => {
    if (anchored.has(c.url) && c.decision === 'accepted') {
      return {
        ...c,
        reason: 'accepted_anchor' as const,
        note: c.note ?? 'URL present on travelOption.sourceUrl',
      }
    }
    if (
      c.decision === 'accepted' &&
      c.reason === 'accepted_partial' &&
      !anchored.has(c.url)
    ) {
      // Still a candidate — if never anchored, record as insufficient for verified
      return {
        ...c,
        decision: 'rejected' as const,
        reason: 'insufficient_evidence' as const,
        note: 'promising hit was not anchored to an entity sourceUrl',
      }
    }
    return c
  })

  return {
    goals,
    candidates: candidatesFinal,
    toolRounds: input.toolRounds,
    toolCallsUsed: input.toolCallsUsed,
    maxToolCalls: input.maxToolCalls,
    forcedExtraRounds: input.forcedExtraRounds,
    consultedSourceCount: consultedSourceCount(input.toolTrace),
    anchoredSourceCount: anchoredSourceCount(input.package),
  }
}

export function extractTripDatesFromPrompt(prompt: string): string[] {
  return extractYmd(prompt)
}
