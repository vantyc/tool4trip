import type { ToolTraceEntry } from '../../shared/agentContracts.ts'

type Rec = Record<string, unknown>

function asRec(v: unknown): Rec {
  return v && typeof v === 'object' ? (v as Rec) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Calendar nights between YYYY-MM-DD (end − start). 19→22 = 3. */
export function nightsBetween(startDate: string, endDate: string): number {
  const a = Date.parse(`${startDate}T12:00:00Z`)
  const b = Date.parse(`${endDate}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0
  return Math.floor((b - a) / 86_400_000)
}

const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre',
]
const MONTH_SRC = MONTH_NAMES.join('|')
const EXACT_DAY_RES = [
  /\b20\d{2}-\d{2}-\d{2}\b/,
  new RegExp(`\\b\\d{1,2}(?:\\s*(?:al?|-|–|y)\\s*\\d{1,2})?\\s*(?:de\\s+)?(?:${MONTH_SRC})\\b`),
  new RegExp(`\\b(?:${MONTH_SRC})\\s+\\d{1,2}\\b`),
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  /\b(?:hoy|pasado manana)\b|(?<!la )\bmanana\b/,
  /\b(?:este|esta|proxim[oa]|el)\s+(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\beste fin de semana\b/,
]

/** The prompt names concrete days (a date, a range, "mañana", "este viernes"), not only a month or season. */
export function promptPinsExactDays(prompt: string): boolean {
  const f = foldText(prompt)
  return EXACT_DAY_RES.some((re) => re.test(f))
}

function promptPeriodLabel(prompt: string): string {
  const f = foldText(prompt)
  const months = MONTH_NAMES.filter((m) => new RegExp(`\\b${m}\\b`).test(f)).sort(
    (a, b) => f.search(new RegExp(`\\b${a}\\b`)) - f.search(new RegExp(`\\b${b}\\b`)),
  )
  if (!months.length) return ''
  const year = f.match(/\b20\d{2}\b/)?.[0]
  return `${months.join(' o ')}${year ? ` de ${year}` : ''}`
}

/**
 * The package needs a trip window, but a prompt with only a month/period (or
 * none) fixes no days: the model's window stays as a labeled provisional
 * planning window, never presented as chosen dates.
 */
export function markTentativeTripWindow(
  pkgIn: unknown,
  userPrompt: string,
): { pkg: Rec; warnings: string[] } {
  const pkg = { ...asRec(pkgIn) }
  const trip = { ...asRec(pkg.trip) }
  const start = str(trip.startDate)
  const end = str(trip.endDate)
  if (!start || !end || promptPinsExactDays(userPrompt)) return { pkg, warnings: [] }
  const period = promptPeriodLabel(userPrompt)
  const asked = period ? `el usuario indicó ${period} sin día exacto` : 'el usuario no indicó fechas'
  if (!str(trip.notes).includes('Fechas tentativas')) {
    trip.notes = [
      str(trip.notes),
      `Fechas tentativas: ${asked}; ${start} → ${end} es una ventana de planificación provisional. Días exactos: UNKNOWN (pendientes de elegir vuelos).`,
    ]
      .filter(Boolean)
      .join('\n')
  }
  pkg.trip = trip
  return {
    pkg,
    warnings: [
      `server: fechas tentativas — ${period ? `el prompt indica sólo ${period}` : 'el prompt no indica fechas'}; la ventana ${start} → ${end} es provisional, no son fechas confirmadas.`,
    ],
  }
}

const AIRPORT_ITEM_RE =
  /arribo\s+al\s+aeropuerto|airport[-_]?arrival|check-?in\s+(online|mostrador)|documentar.*aeropuerto/i

/**
 * Remove LLM-authored generic airport-arrival itinerary rows so server policy
 * can add exactly one canonical reminder per flight.
 */
export function stripLlmAirportArrivalItems(pkgIn: unknown): Rec {
  const pkg = { ...asRec(pkgIn) }
  const items = Array.isArray(pkg.itineraryItems) ? pkg.itineraryItems : []
  pkg.itineraryItems = items.filter((raw) => {
    const r = asRec(raw)
    const id = str(r.externalId)
    if (id.startsWith('airport-arrival-')) return false
    if (AIRPORT_ITEM_RE.test(str(r.title))) return false
    return true
  })
  return pkg
}

export type ToolCallOutcome =
  | 'ok'
  | 'tool_failure'
  | 'planner_deferred'
  | 'planner_blocked'
  | 'budget_exhausted'
  | 'unusable_source'

/**
 * A call the server chose not to run (args.skipped) is never a tool failure:
 * it was deferred (ordering), blocked (discarded candidate) or out of budget.
 * A fetch that ran but returned a login/JS/consent wall or no evidence is an
 * unusable source, not a failure and not a verification.
 */
export function toolCallOutcome(t: ToolTraceEntry): ToolCallOutcome {
  if (t.ok) return 'ok'
  if (!asRec(t.args).skipped) {
    return /^unusable:/.test(str(t.error)) ? 'unusable_source' : 'tool_failure'
  }
  const err = str(t.error)
  if (/candidate_discarded|unusable_url_repeat|research_line_closed/.test(err)) {
    return 'planner_blocked'
  }
  if (/budget_exhausted|AGENT_MAX_TOOL_CALLS|exceeded/.test(err)) {
    return 'budget_exhausted'
  }
  return 'planner_deferred'
}

function plannerOutcomeWarnings(toolTrace: ToolTraceEntry[]): string[] {
  const n = (o: ToolCallOutcome) =>
    toolTrace.filter((t) => toolCallOutcome(t) === o).length
  const out: string[] = []
  const deferred = n('planner_deferred')
  const blocked = n('planner_blocked')
  const budget = n('budget_exhausted')
  const unusable = n('unusable_source')
  if (unusable) {
    out.push(
      `server: ${unusable} página(s) consultada(s) sin contenido utilizable (login, JavaScript, consentimiento o sin evidencia); no cuentan como verificación.`,
    )
  }
  if (deferred) {
    out.push(
      `server: ${deferred} llamada(s) diferida(s) por el planificador (orden de investigación); no es un fallo de herramienta.`,
    )
  }
  if (blocked) {
    out.push(
      `server: ${blocked} llamada(s) bloqueada(s) por el planificador (candidato ya descartado, URL ya comprobada como no utilizable o línea de investigación cerrada); no es un fallo de herramienta.`,
    )
  }
  if (budget) {
    out.push(
      `server: ${budget} llamada(s) no ejecutada(s) por presupuesto de investigación agotado; no es un fallo de herramienta.`,
    )
  }
  return out
}

/** Warnings when web tools failed or returned no usable sources. */
export function webResearchWarnings(toolTrace: ToolTraceEntry[]): string[] {
  const searches = toolTrace.filter(
    (t) => t.tool === 'webSearch' && !asRec(t.args).skipped,
  )
  if (searches.length === 0) {
    return [
      'No se ejecutó webSearch en esta propuesta: eventos, ferias y precios siguen pendientes de verificar con fuentes actuales.',
      ...plannerOutcomeWarnings(toolTrace),
    ]
  }
  const failed = searches.filter((t) => toolCallOutcome(t) === 'tool_failure')
  const emptyOk = searches.filter(
    (t) => t.ok && (!t.sources || t.sources.length === 0),
  )
  const out: string[] = [...plannerOutcomeWarnings(toolTrace)]
  if (failed.length > 0) {
    out.push(
      `webSearch falló (${failed.length}): no afirmar serenatas, ferias ni precios; dejar pendientes de verificación.`,
    )
  }
  if (emptyOk.length > 0 && failed.length === 0) {
    out.push(
      'webSearch no entregó resultados útiles: no afirmar eventos/ferias en fechas concretas sin fuente; marcarlos como pendientes de verificar.',
    )
  }
  const hasUrl = searches.some((t) =>
    (t.sources ?? []).some((s) => typeof s.url === 'string' && s.url.length > 0),
  )
  if (!hasUrl && searches.some((t) => t.ok)) {
    out.push(
      'Sin URLs en toolTrace: opciones de vuelo/hospedaje/evento deben quedar estimated/unverified sin sourceUrl inventada.',
    )
  }
  return out
}

function foldText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
}

/** Event nouns; modifiers like «patronal(es)» qualify a noun, never stand alone. */
const EVENT_NOUN_RE =
  /\b(serenatas?|grito|ferias?|fiestas?|conciertos?|festival(?:es)?|procesion(?:es)?|carnaval(?:es)?)\b(\s+(?:patronal(?:es)?|tradicional(?:es)?))?/
const EVENT_STEM_RE =
  /serenat|grito|feria|fiesta|concierto|festival|procesion|carnaval/

export type MainGoal = { noun: string; phrase: string }

/**
 * The traveler's main event goal: the earliest event noun in the prompt.
 * A prompt listing several event words still yields ONE goal, not one per keyword.
 */
export function findMainEventGoal(prompt: string): MainGoal | null {
  const m = EVENT_NOUN_RE.exec(foldText(prompt))
  if (!m) return null
  return { noun: m[1]!, phrase: `${m[1]}${m[2] ?? ''}` }
}

function mentionsEvent(text: string): boolean {
  return EVENT_STEM_RE.test(foldText(text))
}

const MONTH_ES: Record<string, string> = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  setiembre: '09',
  sep: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
}

/**
 * Parse YYYY-MM-DD near a goal keyword (prefer text AFTER the keyword).
 * Returns '' when the prompt does not state a date — never a guessed day.
 */
export function inferGoalDate(
  prompt: string,
  hint: string,
  tripStart: string,
  _tripEnd: string,
): string {
  const lower = foldText(prompt)
  const idx = lower.indexOf(foldText(hint))
  // Prefer the span after the goal word so "sábado 19… serenata … domingo 20" wins.
  const after =
    idx >= 0 ? lower.slice(idx, idx + hint.length + 120) : lower
  const around =
    idx >= 0
      ? lower.slice(Math.max(0, idx - 40), idx + hint.length + 120)
      : lower

  const pickFrom = (text: string): string | null => {
    const iso = text.match(/20\d{2}-\d{2}-\d{2}/)
    if (iso?.[0]) return iso[0]
    // "domingo 20 de septiembre de 2026" / "domingo 20" / "20 de septiembre"
    const weekdayDay = text.match(
      /(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\s+(\d{1,2})(?:\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|sep|octubre|noviembre|diciembre))?(?:\s+de\s+(20\d{2}))?/i,
    )
    if (weekdayDay) {
      const day = String(Number(weekdayDay[1])).padStart(2, '0')
      const monthName = weekdayDay[2]?.toLowerCase()
      const month = monthName ? MONTH_ES[monthName] : tripStart.slice(5, 7)
      const year = weekdayDay[3] || tripStart.slice(0, 4)
      if (month && year) return `${year}-${month}-${day}`
    }
    const es = text.match(
      /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|sep|octubre|noviembre|diciembre)(?:\s+de\s+)?(20\d{2})?/i,
    )
    if (es) {
      const day = String(Number(es[1])).padStart(2, '0')
      const month = MONTH_ES[es[2]!.toLowerCase()]
      const year = es[3] || tripStart.slice(0, 4)
      if (month && year) return `${year}-${month}-${day}`
    }
    return null
  }

  return pickFrom(after) ?? pickFrom(around) ?? ''
}

function isReturnFlight(o: Rec): boolean {
  if (str(o.type) !== 'flight') return false
  const title = str(o.title).toLowerCase()
  const dest = str(o.destination).toUpperCase()
  return (
    /regreso|return|vuelta/.test(title) ||
    dest.includes('MEX') ||
    dest.includes('CDMX') ||
    dest.includes('AICM')
  )
}

function flightDate(o: Rec): string {
  const startAt = str(o.startAt)
  if (/^\d{4}-\d{2}-\d{2}/.test(startAt)) return startAt.slice(0, 10)
  // After scrubUngroundedConcreteFields, clocks move to notes as date hints.
  const notes = str(o.notes)
  const fromNotes = notes.match(
    /Fecha asociada \(sin hora verificada\):\s*(\d{4}-\d{2}-\d{2})/i,
  )
  if (fromNotes?.[1]) return fromNotes[1]
  const fromGoal = notes.match(/Fecha objetivo:\s*(\d{4}-\d{2}-\d{2})/i)
  if (fromGoal?.[1]) return fromGoal[1]
  return ''
}

/**
 * Soft repairs for new_travel packages: lodging skeleton, goal itinerary,
 * preferred vs alternative returns. Mutates a shallow copy.
 */
export function ensureNewTravelSkeleton(
  pkgIn: unknown,
  userPrompt: string,
): Rec {
  const pkg = { ...asRec(pkgIn) }
  const trip = { ...asRec(pkg.trip) }
  pkg.trip = trip
  const start = str(trip.startDate)
  const end = str(trip.endDate)
  const nights = nightsBetween(start, end)
  const dest =
    str(trip.destination) ||
    'destino del viaje'
  const options = Array.isArray(pkg.travelOptions)
    ? [...pkg.travelOptions]
    : []
  const itinerary = Array.isArray(pkg.itineraryItems)
    ? [...pkg.itineraryItems]
    : []
  const checklist = Array.isArray(pkg.checklistItems)
    ? [...pkg.checklistItems]
    : []
  const notes = Array.isArray(pkg.notes) ? [...pkg.notes] : []

  // Lodging covering nights
  const lodging = options.filter((o) => str(asRec(o).type) === 'lodging')
  if (lodging.length === 0 && nights > 0) {
    options.push({
      externalId: 'lodge-skeleton-1',
      type: 'lodging',
      status: 'researched',
      title: `Hospedaje ${dest} (estimado · ${nights} noche(s))`,
      destination: dest,
      // No inventable check-in/out clocks — dates live in trip window + notes.
      verificationStatus: 'estimated',
      sourceType: 'agent',
      notes:
        `Esqueleto de hospedaje — ventana ${start || '?'} → ${end || '?'}. Pendiente de verificar disponibilidad y precio con fuente actual. Sin sourceUrl.`,
    })
  }

  // Preferred return = trip endDate; other returns → researched + alternativa note
  const returns = options
    .map((o, i) => ({ o: asRec(o), i }))
    .filter(({ o }) => isReturnFlight(o))
  if (returns.length > 1 && end) {
    for (const { o, i } of returns) {
      const d = flightDate(o)
      const isPreferred = d === end || (!d && str(o.status) === 'shortlisted')
      if (isPreferred) {
        options[i] = {
          ...o,
          status: 'shortlisted',
          notes: [str(o.notes), 'Regreso preferido.']
            .filter(Boolean)
            .join(' '),
        }
      } else {
        options[i] = {
          ...o,
          status: 'researched',
          notes: [
            str(o.notes),
            'Alternativa — no es el regreso preferido.',
          ]
            .filter(Boolean)
            .join(' '),
        }
      }
    }
    // If none matched endDate, keep first shortlisted or first as preferred
    const stillPreferred = options.filter(
      (o) => isReturnFlight(asRec(o)) && str(asRec(o).status) === 'shortlisted',
    )
    if (stillPreferred.length === 0 && returns[0]) {
      const { o, i } = returns[0]
      options[i] = {
        ...asRec(options[i]),
        status: 'shortlisted',
        notes: [str(o.notes), 'Regreso preferido (asignado por coherencia).']
          .filter(Boolean)
          .join(' '),
      }
    }
  }

  // One itinerary item for the traveler's main event goal (intent, not a fact)
  const mainGoal = findMainEventGoal(userPrompt)
  if (mainGoal && !mainGoalCovered(itinerary, options)) {
    const goalDate = inferGoalDate(userPrompt, mainGoal.noun, start, end)
    const id = `goal-${mainGoal.noun.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`
    const label =
      mainGoal.phrase.charAt(0).toUpperCase() + mainGoal.phrase.slice(1)
    itinerary.push({
      externalId: id,
      title: `${label} (objetivo del viajero)`,
      // Date only in notes — no invented clock time on estimated goals.
      place: dest,
      importance: 'crucial',
      notes: goalDate
        ? `Objetivo del viajero — Fecha objetivo: ${goalDate}. Pendiente de verificar con fuente actual. No afirmar que el evento ocurrirá sin sourceUrl en toolTrace.`
        : 'Objetivo del viajero — Fecha objetivo: UNKNOWN (el prompt no indica fecha). Pendiente de verificar con fuente actual. No afirmar que el evento ocurrirá sin sourceUrl en toolTrace.',
    })
    const chkId = `chk-${id}`
    if (!checklist.some((c) => str(asRec(c).externalId) === chkId)) {
      checklist.push({
        externalId: chkId,
        label: goalDate
          ? `Verificar ${mainGoal.phrase} el ${goalDate} con fuente oficial/actual`
          : `Verificar fecha de ${mainGoal.phrase} con fuente oficial/actual`,
        sortOrder: checklist.length,
      })
    }
  }

  // Nights note for narrative coherence
  if (nights > 0) {
    const noteId = 'note-nights-coherence'
    if (!notes.some((n) => str(asRec(n).externalId) === noteId)) {
      notes.push({
        externalId: noteId,
        title: 'Noches de hospedaje',
        body: `Ventana ${start} → ${end}: ${nights} noche(s) de hospedaje (días calendario inclusivos: ${nights + 1}). Distinguir estimado vs verificado; sin afirmar eventos sin fuente.`,
      })
    }
  }

  pkg.travelOptions = options
  pkg.itineraryItems = itinerary
  pkg.checklistItems = checklist
  pkg.notes = notes
  return pkg
}

/**
 * Soft coherence checks for new_travel packages — returns warnings only.
 */
export function newTravelCoherenceWarnings(
  pkgIn: unknown,
  userPrompt: string,
): string[] {
  const pkg = asRec(pkgIn)
  const trip = asRec(pkg.trip)
  const start = str(trip.startDate)
  const end = str(trip.endDate)
  const nights = nightsBetween(start, end)
  const warnings: string[] = []

  if (nights > 0) {
    warnings.push(
      `Ventana ${start} → ${end}: ${nights} noche(s) de hospedaje (no confundir con días calendario inclusivos).`,
    )
  }

  const options = Array.isArray(pkg.travelOptions) ? pkg.travelOptions : []
  const lodging = options.filter((o) => str(asRec(o).type) === 'lodging')
  if (lodging.length === 0 && nights > 0) {
    warnings.push(
      'Falta opción de hospedaje (type=lodging) para las noches del viaje — pendiente de verificar.',
    )
  }

  const returns = options.filter((o) => isReturnFlight(asRec(o)))
  if (returns.length > 1) {
    const alts = returns.filter((o) => {
      const r = asRec(o)
      return (
        str(r.status) !== 'shortlisted' ||
        /alternativa/i.test(str(r.notes))
      )
    })
    warnings.push(
      `Hay ${returns.length} vuelos de regreso: el preferido debe ser shortlisted; ${alts.length} alternativa(s) solo researched.`,
    )
  }

  const itinerary = Array.isArray(pkg.itineraryItems) ? pkg.itineraryItems : []
  const mainGoal = findMainEventGoal(userPrompt)
  if (mainGoal && !mainGoalCovered(itinerary, options)) {
    warnings.push(
      `El prompt pide «${mainGoal.phrase}» pero no hay ítem de itinerario/evento correspondiente (debe existir como pendiente de verificar, sin afirmarlo como hecho confirmado).`,
    )
  }

  return warnings
}

function mainGoalCovered(itinerary: unknown[], options: unknown[]): boolean {
  if (itinerary.some((i) => mentionsEvent(str(asRec(i).title)))) return true
  return options.some((o) => {
    const ty = str(asRec(o).type)
    return (
      (ty === 'event' || ty === 'activity' || ty === 'other') &&
      mentionsEvent(str(asRec(o).title))
    )
  })
}

/** Collect server warnings for hydrate after skeleton ensure. */
export function collectNewTravelServerWarnings(
  pkgIn: unknown,
  userPrompt: string,
  toolTrace: ToolTraceEntry[],
): string[] {
  return [
    ...webResearchWarnings(toolTrace),
    ...newTravelCoherenceWarnings(pkgIn, userPrompt),
  ]
}
