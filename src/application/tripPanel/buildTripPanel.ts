import type {
  SharedTripPackageV1,
  AgentProposal,
} from '../../../shared/agentContracts'
import {
  arrivalOffsetsFor,
  extractIataCode,
  subtractMinutesIso,
} from '../../../shared/airportArrivalPolicy'
import type {
  Booking,
  ChecklistItem,
  ItineraryItem,
  Note,
  TravelOption,
  Trip,
} from '../../domain/types'
import type {
  AirportArrivalInfo,
  TripPanelCard,
  TripPanelDiagnostics,
  TripPanelHeader,
  TripPanelModel,
  VisualStatus,
} from './types'

const UNKNOWN = 'UNKNOWN'

function inclusiveDays(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined
  const a = Date.parse(`${start}T12:00:00Z`)
  const b = Date.parse(`${end}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined
  return Math.floor((b - a) / 86_400_000) + 1
}

function nightsBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined
  const a = Date.parse(`${start}T12:00:00Z`)
  const b = Date.parse(`${end}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined
  return Math.floor((b - a) / 86_400_000)
}

export function normPlace(s?: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Collapse near-duplicate place labels (substring / same normalized form). */
export function dedupeDestinations(raw: string[]): string[] {
  const cleaned = raw
    .map((s) => s.trim())
    .filter((s) => s && s !== UNKNOWN)
  // Prefer longer / more specific labels first
  const ranked = [...cleaned].sort(
    (a, b) => normPlace(b).length - normPlace(a).length || b.length - a.length,
  )
  const out: string[] = []
  for (const d of ranked) {
    const n = normPlace(d)
    if (!n) continue
    const subsumed = out.some((kept) => {
      const k = normPlace(kept)
      return k === n || k.includes(n) || n.includes(k)
    })
    if (!subsumed) out.push(d)
  }
  // Prefer trip.destination order: keep first raw's cluster first when possible
  if (cleaned[0]) {
    const firstNorm = normPlace(cleaned[0])
    out.sort((a, b) => {
      const aHit = normPlace(a) === firstNorm || normPlace(a).includes(firstNorm) ? 0 : 1
      const bHit = normPlace(b) === firstNorm || normPlace(b).includes(firstNorm) ? 0 : 1
      return aHit - bHit
    })
  }
  return out
}

export function isAirportArrivalActivity(
  id: string,
  title: string,
): boolean {
  if (id.startsWith('airport-arrival-')) return true
  return /arribo al aeropuerto|airport arrival|check-?in aeropuerto/i.test(
    title,
  )
}

function filterNonEmptyWarnings(ws: string[] | undefined): string[] {
  if (!ws?.length) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of ws) {
    const t = w.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function isReturnFlight(o: {
  type: string
  title: string
  destination?: string
  origin?: string
  notes?: string
}): boolean {
  if (o.type !== 'flight') return false
  const title = o.title.toLowerCase()
  if (/regreso|return|vuelta|inbound/.test(title)) return true
  if (/alternativa/.test((o.notes ?? '').toLowerCase()) && /mex|cdmx|aicm/i.test(o.destination ?? ''))
    return true
  const dest = (o.destination ?? '').toUpperCase()
  return /\bMEX\b|\bCDMX\b|\bAICM\b/.test(dest)
}

function isAlternative(o: { status?: string; notes?: string }): boolean {
  const notes = (o.notes ?? '').toLowerCase()
  if (/alternativa|no es el regreso preferido|alternative/.test(notes)) return true
  return false
}

function visualFromOption(o: {
  status?: string
  verificationStatus?: string
  sourceUrl?: string
  notes?: string
  bookingId?: string
}): VisualStatus {
  if (o.bookingId || o.status === 'booked' || o.status === 'confirmed') {
    return 'confirmed'
  }
  if (isAlternative(o)) return 'alternative'
  if (o.verificationStatus === 'verified' && o.sourceUrl) return 'verified'
  if (o.verificationStatus === 'verified') return 'verified'
  if (o.verificationStatus === 'estimated') return 'estimated'
  if (o.verificationStatus === 'unverified' || !o.verificationStatus) {
    return 'pending'
  }
  return 'pending'
}

/** Soft statuses must not surface inventable concrete price/clock in the UI. */
function allowsConcreteDisplay(status: VisualStatus): boolean {
  return status === 'verified' || status === 'confirmed'
}

function truncate(s: string, n: number): string {
  const t = s.trim()
  if (t.length <= n) return t
  return `${t.slice(0, n - 1)}…`
}

export function deriveAirportArrival(o: {
  startAt?: string
  origin?: string
  destination?: string
}): AirportArrivalInfo | undefined {
  if (!o.startAt) return undefined
  const { scope, deskMinutes, onlineMinutes } = arrivalOffsetsFor(
    o.origin,
    o.destination,
  )
  const deskAt = subtractMinutesIso(o.startAt, deskMinutes)
  const onlineAt = subtractMinutesIso(o.startAt, onlineMinutes)
  if (!deskAt || !onlineAt) return undefined
  const airportLabel =
    extractIataCode(o.origin) || o.origin?.trim() || 'aeropuerto de salida'
  return {
    deskAt,
    onlineAt,
    deskMinutes,
    onlineMinutes,
    scope,
    airportLabel,
  }
}

function optionToCard(
  o: {
    externalId?: string
    id?: string
    type: string
    title: string
    status?: string
    verificationStatus?: string
    sourceUrl?: string
    notes?: string
    startAt?: string
    endAt?: string
    origin?: string
    destination?: string
    provider?: string
    priceObserved?: number
    currency?: string
    address?: string
    bookingId?: string
  },
  kind: TripPanelCard['kind'],
  opts?: { retainSchedule?: boolean },
): TripPanelCard {
  const status = visualFromOption(o)
  const card: TripPanelCard = {
    id: o.externalId || o.id || `${kind}-${o.title}`,
    kind,
    title: o.title,
    status,
  }
  const concrete = allowsConcreteDisplay(status)
  const scheduleOk = concrete || Boolean(opts?.retainSchedule)
  if (scheduleOk && o.startAt) card.startAt = o.startAt
  if (scheduleOk && o.endAt) card.endAt = o.endAt
  if (o.origin) card.origin = o.origin
  if (o.destination) card.destination = o.destination
  if (o.provider) card.provider = o.provider
  if (concrete && o.priceObserved !== undefined) card.price = o.priceObserved
  if (concrete && o.currency) card.currency = o.currency
  if (o.sourceUrl) card.sourceUrl = o.sourceUrl
  if (o.address) card.place = o.address
  if (o.notes) card.notes = o.notes
  if (
    (kind === 'flight_out' || kind === 'flight_return') &&
    scheduleOk &&
    o.startAt
  ) {
    const arrival = deriveAirportArrival(o)
    if (arrival) card.airportArrival = arrival
  }
  return card
}

function missingCard(id: string, kind: TripPanelCard['kind'], title: string): TripPanelCard {
  return { id, kind, title, status: 'missing' }
}

/** Derive integrity diagnostics without mutating source data. */
export function computeTripPanelDiagnostics(input: {
  cards: TripPanelCard[]
  sourceUrls: string[]
  agentWarnings?: string[]
  nights?: number
  hasOutboundFlight: boolean
  hasReturnFlight: boolean
  hasLodging: boolean
  hasGround: boolean
  destinationsRaw: string[]
  activityTitles: string[]
  transportLegs: Array<{ origin?: string; destination?: string; startAt?: string; title: string }>
}): TripPanelDiagnostics {
  const warnings: string[] = filterNonEmptyWarnings(input.agentWarnings)
  const sourceCount = input.sourceUrls.length

  if (sourceCount === 0) {
    warnings.push('Ausencia de fuentes: ninguna URL verificable en las opciones.')
  }

  const priced = input.cards.filter(
    (c) =>
      ['flight_out', 'flight_return', 'ground', 'lodging'].includes(c.kind) &&
      c.status !== 'missing' &&
      allowsConcreteDisplay(c.status),
  )
  const withoutPrice = priced.filter((c) => c.price === undefined)
  if (withoutPrice.length > 0) {
    warnings.push(
      `Opciones verificadas sin precio: ${withoutPrice.length} (transporte/hospedaje sin priceObserved).`,
    )
  }

  const missing: TripPanelCard[] = []
  if ((input.nights ?? 0) > 0 && !input.hasLodging) {
    missing.push(missingCard('miss-lodging', 'missing_slot', 'Hospedaje'))
    warnings.push('Componente faltante: hospedaje para las noches del viaje.')
  }
  if (input.hasOutboundFlight && !input.hasReturnFlight) {
    missing.push(missingCard('miss-return', 'missing_slot', 'Vuelo de regreso'))
    warnings.push('Componente faltante: vuelo de regreso.')
  }
  if (input.hasOutboundFlight && input.hasLodging && !input.hasGround) {
    // Soft: only warn if destination looks multi-city (outbound dest != lodging dest)
    warnings.push(
      'Posible tramo faltante: hay vuelo y hospedaje pero no aparece traslado terrestre explícito.',
    )
  }

  // Duplicate destinations (same normalized place listed >1 as distinct raw strings)
  const destUniqueCheck = dedupeDestinations(input.destinationsRaw)
  if (destUniqueCheck.length < input.destinationsRaw.filter((d) => normPlace(d)).length) {
    warnings.push(
      'Destinos del header normalizados: se colapsaron etiquetas repetidas o contenidas.',
    )
  }

  // Duplicate activities
  const actNorms = input.activityTitles.map(normPlace).filter(Boolean)
  const actCounts = new Map<string, number>()
  for (const a of actNorms) actCounts.set(a, (actCounts.get(a) ?? 0) + 1)
  for (const [a, n] of actCounts) {
    if (n > 1) {
      warnings.push(`Posibles actividades duplicadas: «${a}» (${n}).`)
    }
  }

  // Transport continuity (sorted by startAt when present)
  const legs = [...input.transportLegs].sort((a, b) =>
    (a.startAt ?? '').localeCompare(b.startAt ?? ''),
  )
  for (let i = 0; i < legs.length - 1; i++) {
    const a = legs[i]!
    const b = legs[i + 1]!
    const ad = normPlace(a.destination)
    const bo = normPlace(b.origin)
    if (ad && bo && ad !== bo && !ad.includes(bo) && !bo.includes(ad)) {
      warnings.push(
        `Posible discontinuidad de transporte: «${a.title}» llega a ${a.destination ?? '?'} y «${b.title}» sale de ${b.origin ?? '?'}.`,
      )
    }
  }

  // Lodging quality
  for (const c of input.cards.filter((x) => x.kind === 'lodging' && x.status !== 'missing')) {
    const generic =
      /hospedaje|estimado| lodging|hotel gen[eé]rico/i.test(c.title) && !c.provider
    if (generic || (!c.provider && c.price === undefined)) {
      warnings.push(
        `Hospedaje incompleto («${c.title}»): sin establecimiento, disponibilidad o precio confirmados.`,
      )
    }
  }

  // Missing dates on verified/confirmed cards only (estimado omits clocks by design)
  for (const c of input.cards) {
    if (!allowsConcreteDisplay(c.status)) continue
    if (
      ['flight_out', 'flight_return', 'ground', 'lodging', 'activity'].includes(
        c.kind,
      ) &&
      !c.startAt
    ) {
      warnings.push(`Fecha/hora ausente: «${c.title}».`)
    }
  }

  // Estimated presented as confirmed (not "confirmar" checklist language)
  for (const c of input.cards) {
    if (
      c.status === 'estimated' &&
      /\bconfirmad[oa]s?\b/i.test(`${c.title} ${c.notes ?? ''}`)
    ) {
      warnings.push(
        `Elemento estimado presentado como confirmado: «${c.title}».`,
      )
    }
  }

  const returns = input.cards.filter((c) => c.kind === 'flight_return')
  const primary = returns.filter((c) => c.status !== 'alternative' && c.status !== 'missing')
  const alts = returns.filter((c) => c.status === 'alternative')
  if (returns.length > 1 && primary.length > 1 && alts.length === 0) {
    warnings.push(
      'Hay varios vuelos de regreso sin marcar alternativas; conviene distinguir el principal.',
    )
  } else if (primary.length === 1 && alts.length > 0) {
    warnings.push(
      `Regreso principal + ${alts.length} alternativa(s) detectados.`,
    )
  }

  const allCards = [...input.cards, ...missing]
  const verifiedCount = allCards.filter(
    (c) => c.status === 'verified' || c.status === 'confirmed',
  ).length
  const pendingCount = allCards.filter(
    (c) =>
      c.status === 'pending' ||
      c.status === 'estimated' ||
      c.status === 'alternative',
  ).length
  const missingCount = allCards.filter((c) => c.status === 'missing').length

  const needsCreateConfirm = missingCount > 0 || sourceCount === 0
  let integrityLight: TripPanelDiagnostics['integrityLight'] = 'green'
  if (missingCount > 0 || sourceCount === 0) integrityLight = 'red'
  else if (verifiedCount === 0 || pendingCount > verifiedCount) integrityLight = 'amber'

  // Dedupe warnings (keep order)
  const uniq = filterNonEmptyWarnings(warnings)

  return {
    verifiedCount,
    pendingCount,
    missingCount,
    sourceCount,
    warnings: uniq,
    needsCreateConfirm,
    integrityLight,
  }
}

function progressFromDiagnostics(
  d: TripPanelDiagnostics,
  totalSlots: number,
): number {
  if (totalSlots <= 0) return 0
  const done = d.verifiedCount
  return Math.max(0, Math.min(100, Math.round((done / totalSlots) * 100)))
}

function collectDestinationsFromPkg(pkg: SharedTripPackageV1): string[] {
  const out: string[] = []
  const push = (v?: string) => {
    const s = v?.trim()
    if (!s || s === UNKNOWN) return
    out.push(s)
  }
  push(pkg.trip.destination)
  for (const o of pkg.travelOptions) {
    if (o.type === 'lodging' || o.type === 'activity' || o.type === 'event') {
      push(o.destination ?? o.address)
    } else {
      push(o.destination)
    }
  }
  return out
}

export function buildTripPanelFromPackage(
  pkg: SharedTripPackageV1,
  opts?: {
    narrative?: string
    warnings?: string[]
    statusLabel?: string
    budgetAmount?: number
    budgetCurrency?: string
    budgetConfidence?: string
    includeTechnicalJson?: boolean
  },
): TripPanelModel {
  const flights = pkg.travelOptions.filter((o) => o.type === 'flight')
  const returns = flights.filter((o) => isReturnFlight(o))
  const outbound = flights.filter((o) => !isReturnFlight(o))
  const ground = pkg.travelOptions.filter((o) =>
    ['bus', 'train', 'transfer', 'car_rental'].includes(o.type),
  )
  const lodging = pkg.travelOptions.filter((o) => o.type === 'lodging')
  const activityOpts = pkg.travelOptions.filter((o) =>
    ['activity', 'event', 'restaurant'].includes(o.type),
  )
  const itineraryActivities = pkg.itineraryItems
    .filter((i) => !isAirportArrivalActivity(i.externalId, i.title))
    .map((i) => ({
      externalId: i.externalId,
      type: 'activity',
      title: i.title,
      startAt: i.startAt,
      endAt: i.endAt,
      destination: i.place,
      notes: i.notes,
      verificationStatus: undefined as string | undefined,
      sourceUrl: undefined as string | undefined,
    }))
  const flightsOut = outbound.map((o) => optionToCard(o, 'flight_out'))
  const flightsReturn = returns.map((o) => {
    const c = optionToCard(o, 'flight_return')
    if (isAlternative(o)) c.status = 'alternative'
    // Alternative inherits soft status → no concrete clocks/prices
    if (c.status === 'alternative') {
      delete c.startAt
      delete c.endAt
      delete c.price
      delete c.currency
      delete c.airportArrival
    }
    return c
  })
  const groundCards = ground.map((o) => optionToCard(o, 'ground'))
  const lodgingCards = lodging.map((o) => optionToCard(o, 'lodging'))
  const activityCards = [
    ...activityOpts.map((o) => optionToCard(o, 'activity')),
    ...itineraryActivities.map((o) =>
      optionToCard(o, 'activity', { retainSchedule: true }),
    ),
  ]

  const nights = nightsBetween(pkg.trip.startDate, pkg.trip.endDate)
  const cards: TripPanelCard[] = [
    ...flightsOut,
    ...flightsReturn,
    ...groundCards,
    ...lodgingCards,
    ...activityCards,
  ]

  if ((nights ?? 0) > 0 && lodgingCards.length === 0) {
    cards.push(missingCard('miss-lodging', 'missing_slot', 'Hospedaje'))
  }
  if (flightsOut.length > 0 && flightsReturn.length === 0) {
    cards.push(
      missingCard('miss-return', 'missing_slot', 'Vuelo de regreso'),
    )
  }

  const sourceUrls = [
    ...new Set(
      pkg.travelOptions
        .map((o) => o.sourceUrl)
        .filter((u): u is string => Boolean(u)),
    ),
  ]
  const sourceCards: TripPanelCard[] = sourceUrls.map((url, i) => ({
    id: `src-${i}`,
    kind: 'source',
    title: url,
    status: 'verified',
    sourceUrl: url,
  }))

  const checklist: TripPanelCard[] = pkg.checklistItems.map((c) => ({
    id: c.externalId,
    kind: 'checklist',
    title: c.label,
    status: 'pending',
    startAt: c.dueAt,
  }))

  const notes: TripPanelCard[] = pkg.notes.map((n) => ({
    id: n.externalId,
    kind: 'note',
    title: n.title || 'Nota',
    status: 'pending',
    body: n.body,
  }))

  const destinationsRaw = collectDestinationsFromPkg(pkg)
  const diagnostics = computeTripPanelDiagnostics({
    cards,
    sourceUrls,
    agentWarnings: filterNonEmptyWarnings(opts?.warnings),
    nights,
    hasOutboundFlight: flightsOut.length > 0,
    hasReturnFlight: flightsReturn.length > 0,
    hasLodging: lodgingCards.length > 0,
    hasGround: groundCards.length > 0,
    destinationsRaw,
    activityTitles: activityCards.map((c) => c.title),
    transportLegs: [...outbound, ...returns, ...ground].map((o) => ({
      origin: o.origin,
      destination: o.destination,
      startAt: o.startAt,
      title: o.title,
    })),
  })

  const destUnique = dedupeDestinations(destinationsRaw)

  const origin =
    outbound[0]?.origin ??
    pkg.travelOptions.find((o) => o.origin)?.origin

  const totalSlots =
    cards.filter((c) => c.status !== 'alternative').length || 1

  const header: TripPanelHeader = {
    title: pkg.trip.title || UNKNOWN,
    statusLabel: opts?.statusLabel ?? pkg.trip.status,
    origin,
    destinations: destUnique.length > 0 ? destUnique : [UNKNOWN],
    startDate: pkg.trip.startDate,
    endDate: pkg.trip.endDate,
    days: inclusiveDays(pkg.trip.startDate, pkg.trip.endDate),
    nights,
    budgetAmount: opts?.budgetAmount,
    budgetCurrency: opts?.budgetCurrency,
    budgetConfidence: opts?.budgetConfidence,
    progressPct: progressFromDiagnostics(diagnostics, totalSlots),
  }

  const agentWarnings = filterNonEmptyWarnings(opts?.warnings)

  return {
    header,
    diagnostics,
    flightsOut,
    flightsReturn,
    ground: groundCards,
    lodging: lodgingCards.length
      ? lodgingCards
      : cards.filter((c) => c.id === 'miss-lodging'),
    activities: activityCards,
    checklist,
    notes,
    sources: sourceCards,
    executiveSummary: opts?.narrative
      ? truncate(opts.narrative, 220)
      : undefined,
    technical: {
      narrative: opts?.narrative,
      warnings: agentWarnings,
      jsonText: opts?.includeTechnicalJson
        ? JSON.stringify(pkg, null, 2)
        : undefined,
    },
  }
}

export function buildTripPanelFromProposal(
  proposal: AgentProposal,
): TripPanelModel {
  const budget = proposal.estimatedCostDelta
  return buildTripPanelFromPackage(proposal.package, {
    narrative: proposal.narrative,
    warnings: proposal.warnings,
    statusLabel: 'DRAFT → planned',
    budgetAmount: budget?.amount,
    budgetCurrency: budget?.currency,
    budgetConfidence: budget?.confidence,
    includeTechnicalJson: true,
  })
}

export function buildTripPanelFromPersisted(input: {
  trip: Trip
  options: TravelOption[]
  itinerary: ItineraryItem[]
  checklist: ChecklistItem[]
  notes: Note[]
  bookings?: Booking[]
}): TripPanelModel {
  const { trip, options, itinerary, checklist, notes, bookings = [] } = input

  // Elevate options linked to confirmed bookings
  const confirmedBookingIds = new Set(
    bookings
      .filter((b) => b.status === 'confirmed' || b.status === 'booked')
      .map((b) => b.id),
  )

  const enriched = options.map((o) => ({
    ...o,
    externalId: o.externalId ?? o.id,
    verificationStatus:
      o.bookingId && confirmedBookingIds.has(o.bookingId)
        ? ('verified' as const)
        : o.verificationStatus,
    status:
      o.bookingId && confirmedBookingIds.has(o.bookingId)
        ? ('booked' as const)
        : o.status,
  }))

  const pkgLike = {
    schemaVersion: 1 as const,
    packageId: `persisted-${trip.id}`,
    revision: 1,
    trip: {
      id: trip.id,
      title: trip.title,
      destination: trip.destination,
      startDate: trip.startDate,
      endDate: trip.endDate,
      timezone: trip.timezone,
      goals: trip.goals.map((g) => g.label),
      status: trip.status,
      notes: trip.notes,
    },
    travelOptions: enriched.map((o) => ({
      externalId: o.externalId!,
      type: o.type,
      status:
        o.status === 'researched' || o.status === 'shortlisted'
          ? o.status
          : o.status === 'selected' || o.status === 'booked'
            ? ('shortlisted' as const)
            : ('researched' as const),
      title: o.title,
      provider: o.provider,
      description: o.description,
      startAt: o.startAt,
      endAt: o.endAt,
      origin: o.origin,
      destination: o.destination,
      address: o.address,
      phone: o.phone,
      priceObserved: o.priceObserved,
      currency: o.currency,
      sourceUrl: o.sourceUrl,
      checkedAt: o.checkedAt,
      verificationStatus: o.verificationStatus,
      sourceType: o.sourceType,
      notes: o.notes,
    })),
    itineraryItems: itinerary.map((i) => ({
      externalId: i.id,
      title: i.title || 'Actividad',
      startAt: i.startAt,
      endAt: i.endAt,
      place: i.place,
      importance: i.importance,
      notes: i.notes,
    })),
    checklistItems: checklist.map((c) => ({
      externalId: c.id,
      label: c.label,
      dueAt: c.dueAt,
    })),
    notes: notes.map((n) => ({
      externalId: n.id,
      title: n.title,
      body: n.body,
    })),
  } satisfies SharedTripPackageV1

  const model = buildTripPanelFromPackage(pkgLike, {
    statusLabel: trip.status,
    warnings: [],
    includeTechnicalJson: false,
  })

  // Re-map confirmed from bookings onto cards
  for (const list of [
    model.flightsOut,
    model.flightsReturn,
    model.ground,
    model.lodging,
    model.activities,
  ]) {
    for (const card of list) {
      const opt = enriched.find(
        (o) => (o.externalId ?? o.id) === card.id || o.id === card.id,
      )
      if (opt?.bookingId && confirmedBookingIds.has(opt.bookingId)) {
        card.status = 'confirmed'
      }
    }
  }

  model.checklist = checklist.map((c) => ({
    id: c.id,
    kind: 'checklist' as const,
    title: c.label,
    status: c.status === 'done' ? ('confirmed' as const) : ('pending' as const),
    startAt: c.dueAt,
  }))

  return model
}
