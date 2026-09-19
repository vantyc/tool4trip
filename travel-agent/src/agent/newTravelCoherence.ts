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

/** Warnings when web tools failed or returned no usable sources. */
export function webResearchWarnings(toolTrace: ToolTraceEntry[]): string[] {
  const searches = toolTrace.filter((t) => t.tool === 'webSearch')
  if (searches.length === 0) {
    return [
      'No se ejecutó webSearch en esta propuesta: eventos, ferias y precios siguen pendientes de verificar con fuentes actuales.',
    ]
  }
  const failed = searches.filter((t) => !t.ok)
  const emptyOk = searches.filter(
    (t) => t.ok && (!t.sources || t.sources.length === 0),
  )
  const out: string[] = []
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

const GOAL_HINTS = [
  'serenata',
  'grito',
  'feria',
  'fiesta',
  'concierto',
  'patronal',
] as const

function findGoalHints(prompt: string): string[] {
  const lower = prompt.toLowerCase()
  return GOAL_HINTS.filter((h) => lower.includes(h))
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

/** Parse YYYY-MM-DD near a goal keyword (prefer text AFTER the keyword). */
export function inferGoalDate(
  prompt: string,
  hint: string,
  tripStart: string,
  tripEnd: string,
): string {
  const lower = prompt.toLowerCase()
  const idx = lower.indexOf(hint)
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
      const month = monthName
        ? MONTH_ES[monthName] ?? '09'
        : tripStart.slice(5, 7) || '09'
      const year = weekdayDay[3] || tripStart.slice(0, 4) || '2026'
      return `${year}-${month}-${day}`
    }
    const es = text.match(
      /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|sep|octubre|noviembre|diciembre)(?:\s+de\s+)?(20\d{2})?/i,
    )
    if (es) {
      const day = String(Number(es[1])).padStart(2, '0')
      const month = MONTH_ES[es[2]!.toLowerCase()] ?? '09'
      const year = es[3] || tripStart.slice(0, 4) || '2026'
      return `${year}-${month}-${day}`
    }
    return null
  }

  const fromAfter = pickFrom(after)
  if (fromAfter) return fromAfter
  const fromAround = pickFrom(around)
  if (fromAround) return fromAround

  if (tripStart && tripEnd && tripStart <= tripEnd) {
    if (hint === 'serenata') {
      const candidate = `${tripStart.slice(0, 4)}-09-20`
      if (candidate >= tripStart && candidate <= tripEnd) return candidate
    }
    return tripStart
  }
  return tripStart || '2026-01-01'
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

  // Goal itinerary items from prompt
  for (const hint of findGoalHints(userPrompt)) {
    const covered = itinerary.some((i) =>
      str(asRec(i).title).toLowerCase().includes(hint),
    )
    const asOption = options.some((o) => {
      const t = str(asRec(o).title).toLowerCase()
      const ty = str(asRec(o).type)
      return (
        t.includes(hint) &&
        (ty === 'event' || ty === 'activity' || ty === 'other')
      )
    })
    if (covered || asOption) continue
    const goalDate = inferGoalDate(userPrompt, hint, start, end)
    const id = `goal-${hint.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`
    itinerary.push({
      externalId: id,
      title: `${hint.charAt(0).toUpperCase() + hint.slice(1)} (objetivo del viajero)`,
      // Date only in notes — no invented clock time on estimated goals.
      place: dest,
      importance: 'crucial',
      notes:
        `Objetivo del viajero — Fecha objetivo: ${goalDate}. Pendiente de verificar con fuente actual. No afirmar que el evento ocurrirá sin sourceUrl en toolTrace.`,
    })
    const chkId = `chk-${id}`
    if (!checklist.some((c) => str(asRec(c).externalId) === chkId)) {
      checklist.push({
        externalId: chkId,
        label: `Verificar ${hint} el ${goalDate} con fuente oficial/actual`,
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
  for (const hint of findGoalHints(userPrompt)) {
    const covered = itinerary.some((i) =>
      str(asRec(i).title).toLowerCase().includes(hint),
    )
    const asOption = options.some((o) => {
      const t = str(asRec(o).title).toLowerCase()
      const ty = str(asRec(o).type)
      return (
        t.includes(hint) &&
        (ty === 'event' || ty === 'activity' || ty === 'other')
      )
    })
    if (!covered && !asOption) {
      warnings.push(
        `El prompt pide «${hint}» pero no hay ítem de itinerario/evento correspondiente (debe existir como pendiente de verificar, sin afirmarlo como hecho confirmado).`,
      )
    }
  }

  return warnings
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
