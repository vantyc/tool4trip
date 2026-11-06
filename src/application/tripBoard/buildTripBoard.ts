import type {
  Booking,
  ChecklistItem,
  TravelOption,
  Trip,
  VerificationStatus,
} from '../../domain/types'
import { quoteLedger } from '../../../shared/quoteLedger'
import { placeKey, resolvePlace, type PlaceInfo } from './places'
import {
  daysBetween,
  formatDayEs,
  formatDuration,
  instantMs,
  localDate,
  minutesBetween,
} from './time'

/**
 * Trip board: the saved options and bookings read as a route of stops
 * joined by legs. Chosen transport with times sets the order; lodging dates
 * add stays; a gap between two places becomes a leg still to decide, with
 * the saved candidates grouped as routes.
 */

export type BoardStatus = 'booked' | 'quoted' | 'pending'
export type BoardRole = 'chosen' | 'alternative' | 'pending'
export type BoardItemKind = 'flight' | 'ground' | 'lodging' | 'activity'
export type LegMode = 'flight' | 'ground' | 'mixed' | 'unknown'
export type StopKind = 'origin' | 'layover' | 'stay' | 'end'

export type BoardItem = {
  id: string
  option?: TravelOption
  booking?: Booking
  kind: BoardItemKind
  type: string
  role: BoardRole
  status: BoardStatus
  title: string
  provider?: string
  flightNumber?: string
  startAt?: string
  endAt?: string
  origin?: string
  destination?: string
  address?: string
  phone?: string
  price?: number
  currency?: string
  countsInBudget: boolean
  /** Ticket that already includes this row's price (return leg). */
  includedWith?: string
  paid?: number
  url?: string
  confirmation?: string
  seat?: string
  terminal?: string
  gate?: string
  /** Baggage sentences quoted from the notes. */
  baggage?: string
  notes?: string
  nextAction?: string
  verification?: VerificationStatus
  checkedAt?: string
}

export type BoardRoute = {
  id: string
  items: BoardItem[]
  mode: LegMode
  price?: number
  currency?: string
}

export type BoardLeg = {
  id: string
  index: number
  fromStopId: string
  toStopId: string
  fromLabel: string
  toLabel: string
  mode: LegMode
  /** Chosen transport, in order. Empty while the leg is undecided. */
  segments: BoardItem[]
  /** Saved candidates for an undecided leg. */
  routes: BoardRoute[]
  alternatives: BoardItem[]
  extras: BoardItem[]
  departAt?: string
  arriveAt?: string
  durationMinutes?: number
  /** Date implied by the neighbouring hotel when the leg has no times. */
  dateHint?: string
  status: BoardStatus
  isNow: boolean
}

export type BoardStop = {
  id: string
  index: number
  kind: StopKind
  key: string
  label: string
  place?: PlaceInfo
  placeRaw?: string
  /** 1-based stay number at this place (Manila 1 and Manila 2); 1 for non-stays. */
  visit: number
  visits: number
  /** Last stop back at the first stop's place. */
  returnsToStart: boolean
  arriveAt?: string
  departAt?: string
  arrivalLegId?: string
  departureLegId?: string
  checkIn?: string
  checkOut?: string
  nights?: number
  layoverMinutes?: number
  lodging: BoardItem[]
  lodgingAlternatives: BoardItem[]
  extras: BoardItem[]
  status: BoardStatus
  pending: string[]
  isNow: boolean
}

export type BoardAlert = {
  id: string
  level: 'warn' | 'info'
  text: string
  stopId?: string
  legId?: string
}

export type BoardSummary = {
  startDate?: string
  endDate?: string
  nights?: number
  currency?: string
  quoted: number
  paid: number
  toPay: number
  toQuote: string[]
  toDecide: string[]
  toBook: string[]
  checklistOpen: number
}

export type TripBoard = {
  stops: BoardStop[]
  legs: BoardLeg[]
  alerts: BoardAlert[]
  summary: BoardSummary
  /** Saved items that fit no stop or leg (other routes, loose activities). */
  unplaced: BoardItem[]
}

const GROUND_TYPES = new Set(['bus', 'train', 'transfer', 'car_rental'])
const STATUS_RANK: Record<BoardStatus, number> = {
  pending: 0,
  quoted: 1,
  booked: 2,
}

function itemKind(type: string): BoardItemKind {
  if (type === 'flight') return 'flight'
  if (type === 'lodging') return 'lodging'
  if (GROUND_TYPES.has(type)) return 'ground'
  return 'activity'
}

export function extractFlightNumber(text?: string): string | undefined {
  const m = text?.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/)
  return m ? `${m[1]}${m[2]}` : undefined
}

export function baggageFromNotes(notes?: string): string | undefined {
  if (!notes) return undefined
  const hits = notes
    .split(/(?<=[.;])\s+/)
    .filter((s) =>
      /maleta|equipaje|art[ií]culo personal|de mano|documentad|carry-?on|baggage|\bbags?\b/i.test(
        s,
      ),
    )
  return hits.length ? hits.join(' ') : undefined
}

function isBookedBooking(b?: Booking): boolean {
  return b?.status === 'booked' || b?.status === 'confirmed'
}

function itemFromOption(
  o: TravelOption,
  bookingsById: Map<string, Booking>,
): BoardItem {
  const linked = o.bookingId ? bookingsById.get(o.bookingId) : undefined
  const booking = linked && linked.status !== 'cancelled' ? linked : undefined
  const booked =
    isBookedBooking(booking) || (o.status === 'booked' && !booking)
  const role: BoardRole = booked
    ? 'chosen'
    : o.budgetRole === 'alternative'
      ? 'alternative'
      : o.budgetRole === 'pending'
        ? 'pending'
        : o.budgetRole === 'primary' ||
            o.status === 'selected' ||
            o.status === 'booked' ||
            booking
          ? 'chosen'
          : 'pending'
  const price = booking?.cost ?? o.priceObserved
  return {
    id: o.id,
    option: o,
    booking,
    kind: itemKind(o.type),
    type: o.type,
    role,
    status: booked ? 'booked' : price !== undefined ? 'quoted' : 'pending',
    title: o.title,
    provider: o.provider,
    flightNumber:
      booking?.flightNumber ??
      (o.type === 'flight' ? extractFlightNumber(o.title) : undefined),
    startAt: booking?.startAt ?? o.startAt,
    endAt: booking?.endAt ?? o.endAt,
    origin: booking?.origin ?? o.origin,
    destination: booking?.destination ?? o.destination,
    address: booking?.address ?? o.address,
    phone: booking?.phone ?? o.phone,
    price,
    currency: booking?.currency ?? o.currency,
    countsInBudget: o.countsInBudget !== false,
    paid:
      isBookedBooking(booking) && typeof booking?.cost === 'number'
        ? booking.cost
        : o.amountPaid,
    url: o.sourceUrl ?? booking?.externalUrl,
    confirmation: booking?.confirmationNumber,
    seat: booking?.seat,
    terminal: booking?.terminal,
    gate: booking?.gate,
    baggage: baggageFromNotes(o.notes),
    notes: o.notes,
    nextAction: o.nextAction,
    verification: o.verificationStatus,
    checkedAt: o.checkedAt,
  }
}

function itemFromBooking(b: Booking): BoardItem {
  return {
    id: b.id,
    booking: b,
    kind: itemKind(b.type),
    type: b.type,
    role: 'chosen',
    status: isBookedBooking(b)
      ? 'booked'
      : b.cost !== undefined
        ? 'quoted'
        : 'pending',
    title: b.title,
    provider: b.provider,
    flightNumber:
      b.flightNumber ??
      (b.type === 'flight' ? extractFlightNumber(b.title) : undefined),
    startAt: b.startAt,
    endAt: b.endAt,
    origin: b.origin,
    destination: b.destination,
    address: b.address,
    phone: b.phone,
    price: b.cost,
    currency: b.currency,
    countsInBudget: true,
    paid: isBookedBooking(b) ? b.cost : undefined,
    url: b.externalUrl,
    confirmation: b.confirmationNumber,
    seat: b.seat,
    terminal: b.terminal,
    gate: b.gate,
    baggage: baggageFromNotes(b.notes),
    notes: b.notes,
  }
}

function keyOf(raw?: string): string {
  return placeKey(raw) ?? 'desconocido'
}

function lodgingPlace(item: BoardItem): string | undefined {
  if (item.destination) return item.destination
  if (resolvePlace(item.address)) return item.address
  const fromTitle = resolvePlace(item.title)
  return fromTitle?.city ?? item.address
}

function worst(statuses: BoardStatus[]): BoardStatus {
  if (statuses.length === 0) return 'pending'
  return statuses.reduce((a, b) => (STATUS_RANK[b] < STATUS_RANK[a] ? b : a))
}

function legModeOf(items: BoardItem[]): LegMode {
  const kinds = new Set(items.map((i) => i.kind))
  if (kinds.size === 0) return 'unknown'
  if (kinds.size === 1 && kinds.has('flight')) return 'flight'
  if (!kinds.has('flight')) return 'ground'
  return 'mixed'
}

function sumPrices(items: BoardItem[]): { price?: number; currency?: string } {
  if (items.length === 0 || items.some((i) => i.price === undefined)) return {}
  const currencies = new Set(items.map((i) => i.currency ?? ''))
  if (currencies.size > 1) return {}
  return {
    price: items.reduce((s, i) => s + (i.price ?? 0), 0),
    currency: items[0]!.currency,
  }
}

function fmtDay(date?: string): string {
  return formatDayEs(date, false) ?? date ?? '—'
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

type StaySlot = {
  key: string
  placeRaw?: string
  checkIn: string
  checkOut?: string
  items: BoardItem[]
}

type TimelineEvent =
  | { t: 'transport'; at: number; item: BoardItem }
  | { t: 'stay'; at: number; slot: StaySlot }

export function buildTripBoard(input: {
  trip: Trip
  options: TravelOption[]
  bookings?: Booking[]
  checklist?: ChecklistItem[]
  now?: Date
}): TripBoard {
  const { trip, options, bookings = [], checklist = [] } = input
  const nowMs = input.now?.getTime()

  const bookingsById = new Map(bookings.map((b) => [b.id, b]))
  const liveOptions = options.filter((o) => o.status !== 'rejected')
  const linkedBookingIds = new Set(
    liveOptions.map((o) => o.bookingId).filter(Boolean) as string[],
  )
  const items: BoardItem[] = [
    ...liveOptions.map((o) => itemFromOption(o, bookingsById)),
    ...bookings
      .filter((b) => b.status !== 'cancelled' && !linkedBookingIds.has(b.id))
      .map(itemFromBooking),
  ]

  markIncludedTickets(items)

  const isTransport = (i: BoardItem) => i.kind === 'flight' || i.kind === 'ground'
  const timedChosen = items.filter(
    (i) => isTransport(i) && i.role === 'chosen' && instantMs(i.startAt) !== undefined,
  )

  const slots = new Map<string, StaySlot>()
  for (const i of items) {
    if (i.kind !== 'lodging' || i.role === 'alternative') continue
    if (instantMs(i.startAt) === undefined) continue
    const raw = lodgingPlace(i)
    const key = keyOf(raw)
    const id = `${key}|${localDate(i.startAt)}|${localDate(i.endAt) ?? ''}`
    const slot = slots.get(id)
    if (slot) {
      slot.items.push(i)
    } else {
      slots.set(id, {
        key,
        placeRaw: raw,
        checkIn: i.startAt!,
        checkOut: i.endAt,
        items: [i],
      })
    }
  }

  const events: TimelineEvent[] = [
    ...timedChosen.map((item) => ({
      t: 'transport' as const,
      at: instantMs(item.startAt)!,
      item,
    })),
    ...[...slots.values()].map((slot) => ({
      t: 'stay' as const,
      at: instantMs(slot.checkIn)!,
      slot,
    })),
  ].sort((a, b) => a.at - b.at || (a.t === b.t ? 0 : a.t === 'transport' ? -1 : 1))

  const stops: BoardStop[] = []
  const legs: BoardLeg[] = []

  const mkStop = (raw?: string, key?: string): BoardStop => {
    const place = resolvePlace(raw)
    const stop: BoardStop = {
      id: `stop-${stops.length + 1}`,
      index: stops.length,
      kind: 'stay',
      key: key ?? keyOf(raw),
      label: place?.city ?? raw?.trim() ?? '—',
      place,
      placeRaw: raw,
      visit: 1,
      visits: 1,
      returnsToStart: false,
      lodging: [],
      lodgingAlternatives: [],
      extras: [],
      status: 'pending',
      pending: [],
      isNow: false,
    }
    stops.push(stop)
    return stop
  }

  const mkLeg = (
    from: BoardStop,
    to: BoardStop,
    segments: BoardItem[],
    dateHint?: string,
  ): BoardLeg => {
    const leg: BoardLeg = {
      id: `leg-${legs.length + 1}`,
      index: legs.length,
      fromStopId: from.id,
      toStopId: to.id,
      fromLabel: from.label,
      toLabel: to.label,
      mode: 'unknown',
      segments,
      routes: [],
      alternatives: [],
      extras: [],
      dateHint,
      status: 'pending',
      isNow: false,
    }
    from.departureLegId = leg.id
    to.arrivalLegId = leg.id
    legs.push(leg)
    return leg
  }

  const attachSlot = (stop: BoardStop, slot: StaySlot) => {
    const ordered = [...slot.items].sort(
      (a, b) =>
        (a.role === 'chosen' ? 0 : 1) - (b.role === 'chosen' ? 0 : 1) ||
        STATUS_RANK[b.status] - STATUS_RANK[a.status],
    )
    stop.lodging.push(...ordered)
    if (!stop.checkIn || instantMs(slot.checkIn)! < instantMs(stop.checkIn)!) {
      stop.checkIn = slot.checkIn
    }
    if (
      slot.checkOut &&
      (!stop.checkOut || instantMs(slot.checkOut)! > instantMs(stop.checkOut)!)
    ) {
      stop.checkOut = slot.checkOut
    }
    if (!stop.place && slot.placeRaw) {
      stop.place = resolvePlace(slot.placeRaw)
      if (stop.place) stop.label = stop.place.city
    }
  }

  let cur: BoardStop | undefined
  for (const ev of events) {
    if (ev.t === 'transport') {
      const t = ev.item
      if (!cur) {
        cur = mkStop(t.origin)
      } else if (t.origin && cur.key !== keyOf(t.origin)) {
        const gap = mkStop(t.origin)
        mkLeg(cur, gap, [], localDate(t.startAt))
        cur = gap
      }
      const dest = mkStop(t.destination)
      dest.arriveAt = t.endAt
      cur.departAt = t.startAt
      mkLeg(cur, dest, [t])
      cur = dest
    } else {
      const slot = ev.slot
      if (!cur) {
        cur = mkStop(slot.placeRaw, slot.key)
      } else if (cur.key !== slot.key) {
        const next = mkStop(slot.placeRaw, slot.key)
        mkLeg(cur, next, [], localDate(slot.checkIn))
        cur = next
      }
      attachSlot(cur, slot)
    }
  }

  const used = new Set<string>()
  for (const leg of legs) for (const s of leg.segments) used.add(s.id)
  for (const stop of stops) for (const l of stop.lodging) used.add(l.id)

  const stopById = new Map(stops.map((s) => [s.id, s]))
  const transportPool = () =>
    items.filter((i) => isTransport(i) && !used.has(i.id))

  // Undecided legs: direct candidates, then two-part routes through one place.
  for (const leg of legs) {
    if (leg.segments.length > 0) continue
    const a = stopById.get(leg.fromStopId)!.key
    const b = stopById.get(leg.toStopId)!.key
    const pool = transportPool()
    const routes: BoardItem[][] = pool
      .filter((i) => keyOf(i.origin) === a && keyOf(i.destination) === b)
      .map((i) => [i])
    for (const first of pool) {
      const mid = keyOf(first.destination)
      if (keyOf(first.origin) !== a || mid === b) continue
      const second = pool.find(
        (s) => s !== first && keyOf(s.origin) === mid && keyOf(s.destination) === b,
      )
      if (second) routes.push([first, second])
    }
    const seen = new Set<string>()
    for (const route of routes) {
      if (route.some((i) => seen.has(i.id))) continue
      route.forEach((i) => {
        seen.add(i.id)
        used.add(i.id)
      })
      leg.routes.push({
        id: `${leg.id}-r${leg.routes.length + 1}`,
        items: route,
        mode: legModeOf(route),
        ...sumPrices(route),
      })
    }
  }

  // Alternatives to a chosen leg: same start place, ending at its stop or a later one.
  for (const alt of transportPool()) {
    if (alt.role !== 'alternative') continue
    const from = keyOf(alt.origin)
    const to = keyOf(alt.destination)
    const leg = legs.find((l) => {
      if (l.segments.length === 0) return false
      const fromStop = stopById.get(l.fromStopId)!
      if (fromStop.key !== from) return false
      const laterKeys = stops.slice(fromStop.index + 1).map((s) => s.key)
      if (!laterKeys.includes(to)) return false
      const altDay = localDate(alt.startAt)
      return !altDay || altDay === localDate(l.segments[0]!.startAt)
    })
    if (leg) {
      leg.alternatives.push(alt)
      used.add(alt.id)
    }
  }

  // Activities and other extras: on a matching leg, else at a matching stop.
  for (const extra of items) {
    if (extra.kind !== 'activity' || used.has(extra.id)) continue
    const from = extra.origin ? keyOf(extra.origin) : undefined
    const to = extra.destination ? keyOf(extra.destination) : undefined
    const leg =
      from && to
        ? legs.find(
            (l) =>
              stopById.get(l.fromStopId)!.key === from &&
              stopById.get(l.toStopId)!.key === to,
          )
        : undefined
    if (leg) {
      leg.extras.push(extra)
      used.add(extra.id)
      continue
    }
    const placeK = to ?? (extra.address ? keyOf(extra.address) : undefined)
    const at = instantMs(extra.startAt)
    const stop = stops.find(
      (s) =>
        s.key === placeK &&
        (at === undefined ||
          ((instantMs(s.arriveAt ?? s.checkIn) ?? -Infinity) <= at &&
            at <= (instantMs(s.departAt ?? s.checkOut) ?? Infinity))),
    )
    if (stop) {
      stop.extras.push(extra)
      used.add(extra.id)
    }
  }

  // Lodging alternatives: same place, overlapping dates when known.
  for (const alt of items) {
    if (alt.kind !== 'lodging' || used.has(alt.id)) continue
    const key = keyOf(lodgingPlace(alt))
    const start = localDate(alt.startAt)
    const stop =
      stops.find(
        (s) =>
          s.key === key &&
          start !== undefined &&
          s.checkIn !== undefined &&
          start >= localDate(s.checkIn)! &&
          (!s.checkOut || start < localDate(s.checkOut)!),
      ) ?? stops.find((s) => s.key === key && s.lodging.length > 0)
    if (stop) {
      stop.lodgingAlternatives.push(alt)
      used.add(alt.id)
    }
  }

  const unplaced = items.filter((i) => !used.has(i.id))

  finishLegs(legs, nowMs)
  finishStops(stops, legs, nowMs)

  const alerts = buildAlerts(stops, legs)
  const summary = buildSummary({
    stops,
    legs,
    options: liveOptions,
    bookings,
    checklist,
  })
  if (summary.endDate && trip.endDate && summary.endDate !== trip.endDate) {
    const last = legs.at(-1)
    if (last?.arriveAt && stops.at(-1)?.kind === 'end') {
      alerts.unshift({
        id: 'trip-end',
        level: 'warn',
        text: `El viaje guardado termina el ${fmtDay(trip.endDate)}, pero el último tramo llega el ${fmtDay(summary.endDate)}.`,
        legId: last.id,
      })
    }
  }
  if (summary.startDate && trip.startDate && summary.startDate !== trip.startDate) {
    const first = legs[0]
    if (first?.departAt && stops[0]?.kind === 'origin') {
      alerts.unshift({
        id: 'trip-start',
        level: 'warn',
        text: `El viaje guardado empieza el ${fmtDay(trip.startDate)}, pero el primer tramo sale el ${fmtDay(summary.startDate)}.`,
        legId: first.id,
      })
    }
  }

  return { stops, legs, alerts, summary, unplaced }
}

/** Return legs priced on the outbound ticket point at that ticket. */
function markIncludedTickets(items: BoardItem[]): void {
  for (const item of items) {
    if (item.countsInBudget || item.role !== 'chosen') continue
    const twin = items.find(
      (o) =>
        o !== item &&
        o.role === 'chosen' &&
        o.countsInBudget &&
        o.price !== undefined &&
        o.price === item.price &&
        (o.currency ?? '') === (item.currency ?? '') &&
        keyOf(o.origin) === keyOf(item.destination) &&
        keyOf(o.destination) === keyOf(item.origin),
    )
    item.includedWith =
      twin?.flightNumber ??
      twin?.title ??
      item.notes?.match(/mismo boleto que ([A-Z0-9]{2}\s?\d{1,4})/i)?.[1]
  }
}

function finishLegs(legs: BoardLeg[], nowMs?: number): void {
  for (const leg of legs) {
    if (leg.segments.length > 0) {
      leg.mode = legModeOf(leg.segments)
      leg.departAt = leg.segments[0]!.startAt
      leg.arriveAt = leg.segments.at(-1)!.endAt
      leg.durationMinutes = minutesBetween(leg.departAt, leg.arriveAt)
      leg.status = leg.segments.every((s) => s.status === 'booked')
        ? 'booked'
        : leg.segments.every(
              (s) => s.status !== 'pending' || s.includedWith !== undefined,
            )
          ? 'quoted'
          : 'pending'
      const a = instantMs(leg.departAt)
      const b = instantMs(leg.arriveAt)
      leg.isNow =
        nowMs !== undefined && a !== undefined && b !== undefined && a <= nowMs && nowMs < b
    } else {
      const modes = new Set(leg.routes.map((r) => r.mode))
      leg.mode =
        modes.size === 0
          ? 'unknown'
          : modes.size === 1
            ? [...modes][0]!
            : modes.has('flight') || modes.has('mixed')
              ? 'mixed'
              : 'ground'
      leg.status = 'pending'
    }
  }
}

function finishStops(stops: BoardStop[], legs: BoardLeg[], nowMs?: number): void {
  const legById = new Map(legs.map((l) => [l.id, l]))

  for (const stop of stops) {
    const arrival = stop.arrivalLegId ? legById.get(stop.arrivalLegId) : undefined
    const departure = stop.departureLegId
      ? legById.get(stop.departureLegId)
      : undefined
    const isFirst = stop.index === 0
    const isLast = stop.index === stops.length - 1
    const hasLodging = stop.lodging.length > 0

    stop.layoverMinutes = minutesBetween(stop.arriveAt, stop.departAt)
    if (hasLodging) stop.kind = 'stay'
    else if (isFirst && departure) stop.kind = 'origin'
    else if (isLast && arrival) stop.kind = 'end'
    else if (stop.layoverMinutes !== undefined && stop.layoverMinutes < 24 * 60)
      stop.kind = 'layover'
    else stop.kind = 'stay'
    if (stop.kind !== 'layover') stop.layoverMinutes = undefined

    const arriveDay = localDate(stop.arriveAt) ?? arrival?.dateHint
    const departDay = localDate(stop.departAt) ?? departure?.dateHint
    if (stop.kind === 'stay') {
      stop.nights = hasLodging
        ? daysBetween(localDate(stop.checkIn), localDate(stop.checkOut))
        : daysBetween(arriveDay, departDay)
    }

    const chosen = stop.lodging.filter((l) => l.role === 'chosen')
    if (stop.kind === 'stay') {
      stop.status = chosen.length ? worst(chosen.map((l) => l.status)) : 'pending'
    } else {
      stop.status = worst(
        [arrival?.status, departure?.status].filter(Boolean) as BoardStatus[],
      )
    }

    const pending: string[] = []
    if (stop.kind === 'stay') {
      if (!hasLodging) {
        pending.push(
          stop.nights
            ? `Falta hotel (${plural(stop.nights, 'noche', 'noches')})`
            : 'Falta hotel',
        )
      } else if (chosen.length === 0) {
        const priced = stop.lodging.some((l) => l.price !== undefined)
        pending.push(priced ? 'Elegir hotel' : 'Cotizar y elegir hotel')
      } else if (chosen.some((l) => l.status !== 'booked')) {
        pending.push('Reservar hotel')
      }
    }
    if (arrival && arrival.segments.length === 0) pending.push('Elegir cómo llegar')
    if (departure && departure.segments.length === 0) pending.push('Elegir cómo salir')
    stop.pending = pending

    const start = instantMs(stop.arriveAt ?? stop.checkIn)
    const end = instantMs(stop.departAt ?? stop.checkOut)
    stop.isNow =
      nowMs !== undefined &&
      start !== undefined &&
      start <= nowMs &&
      (end === undefined || nowMs < end)
  }

  const staysAt = new Map<string, BoardStop[]>()
  for (const stop of stops) {
    if (stop.kind !== 'stay') continue
    staysAt.set(stop.key, [...(staysAt.get(stop.key) ?? []), stop])
  }
  for (const group of staysAt.values()) {
    group.forEach((stop, i) => {
      stop.visit = i + 1
      stop.visits = group.length
    })
  }
  const last = stops.at(-1)
  if (last && stops.length > 1 && last.kind === 'end' && last.key === stops[0]!.key) {
    last.returnsToStart = true
  }
}

function buildAlerts(stops: BoardStop[], legs: BoardLeg[]): BoardAlert[] {
  const alerts: BoardAlert[] = []
  const legById = new Map(legs.map((l) => [l.id, l]))

  for (const stop of stops) {
    const arrival = stop.arrivalLegId ? legById.get(stop.arrivalLegId) : undefined
    const departure = stop.departureLegId
      ? legById.get(stop.departureLegId)
      : undefined
    const arriveDay = localDate(stop.arriveAt) ?? arrival?.dateHint
    const departDay = localDate(stop.departAt) ?? departure?.dateHint
    const where = stop.visits > 1 ? `${stop.label} (${stop.visit}ª vez)` : stop.label

    if (stop.lodging.length > 0) {
      const inDay = localDate(stop.checkIn)
      const outDay = localDate(stop.checkOut)
      if (arriveDay && inDay && arriveDay < inDay) {
        alerts.push({
          id: `${stop.id}-early`,
          level: 'warn',
          text: `Noche sin hotel en ${where}: llegas el ${fmtDay(arriveDay)} y el hotel empieza el ${fmtDay(inDay)}.`,
          stopId: stop.id,
        })
      }
      if (arriveDay && inDay && arriveDay > inDay) {
        alerts.push({
          id: `${stop.id}-late`,
          level: 'info',
          text: `En ${where} llegas el ${fmtDay(arriveDay)}, pero el hotel empieza el ${fmtDay(inDay)}.`,
          stopId: stop.id,
        })
      }
      if (departDay && outDay && departDay > outDay) {
        alerts.push({
          id: `${stop.id}-gap`,
          level: 'warn',
          text: `Noche sin hotel en ${where}: el hotel termina el ${fmtDay(outDay)} y sales el ${fmtDay(departDay)}.`,
          stopId: stop.id,
        })
      }
      if (departDay && outDay && departDay < outDay) {
        alerts.push({
          id: `${stop.id}-leave-early`,
          level: 'info',
          text: `En ${where} sales el ${fmtDay(departDay)}, antes de que termine el hotel (${fmtDay(outDay)}).`,
          stopId: stop.id,
        })
      }
    }

    if (stop.kind === 'stay' && stop.lodging.length === 0 && (stop.nights ?? 0) > 0) {
      alerts.push({
        id: `${stop.id}-nohotel`,
        level: 'warn',
        text: `${plural(stop.nights!, 'noche', 'noches')} sin hotel en ${where}.`,
        stopId: stop.id,
      })
    }

    const gap = minutesBetween(stop.arriveAt, stop.departAt)
    if (gap !== undefined && gap < 0) {
      alerts.push({
        id: `${stop.id}-negative`,
        level: 'warn',
        text: `En ${where} la salida es antes de la llegada (${formatDuration(gap)}).`,
        stopId: stop.id,
      })
    } else if (stop.kind === 'layover' && gap !== undefined && gap < 60) {
      alerts.push({
        id: `${stop.id}-short`,
        level: 'warn',
        text: `Conexión corta en ${where}: ${formatDuration(gap)}.`,
        stopId: stop.id,
      })
    }
  }

  const withLodging = stops.filter((s) => s.lodging.length > 0)
  for (let i = 1; i < withLodging.length; i++) {
    const prev = withLodging[i - 1]!
    const next = withLodging[i]!
    const prevOut = localDate(prev.checkOut)
    const nextIn = localDate(next.checkIn)
    if (prevOut && nextIn && prevOut > nextIn) {
      const dup = alerts.findIndex((a) => a.id === `${prev.id}-leave-early`)
      if (dup >= 0) alerts.splice(dup, 1)
      alerts.push({
        id: `${prev.id}-${next.id}-overlap`,
        level: 'warn',
        text: `El hotel en ${prev.label} (hasta el ${fmtDay(prevOut)}) se traslapa con ${next.label} (desde el ${fmtDay(nextIn)}).`,
        stopId: next.id,
      })
    }
  }

  for (const leg of legs) {
    if (leg.segments.length === 0 && leg.routes.length === 0) {
      alerts.push({
        id: `${leg.id}-empty`,
        level: 'info',
        text: `No hay opciones guardadas para ${leg.fromLabel} → ${leg.toLabel}.`,
        legId: leg.id,
      })
    }
  }
  for (let i = 1; i < legs.length; i++) {
    const prevEnd = instantMs(legs[i - 1]!.arriveAt)
    const nextStart = instantMs(legs[i]!.departAt)
    if (prevEnd !== undefined && nextStart !== undefined && nextStart < prevEnd) {
      alerts.push({
        id: `${legs[i]!.id}-overlap`,
        level: 'warn',
        text: `${legs[i]!.fromLabel} → ${legs[i]!.toLabel} sale antes de que llegue el tramo anterior.`,
        legId: legs[i]!.id,
      })
    }
  }
  return alerts
}

function buildSummary(input: {
  stops: BoardStop[]
  legs: BoardLeg[]
  options: TravelOption[]
  bookings: Booking[]
  checklist: ChecklistItem[]
}): BoardSummary {
  const { stops, legs, options, bookings, checklist } = input
  const days = [
    ...legs.flatMap((l) => [localDate(l.departAt), localDate(l.arriveAt), l.dateHint]),
    ...stops.flatMap((s) => [localDate(s.checkIn), localDate(s.checkOut)]),
  ].filter(Boolean) as string[]
  days.sort()
  const startDate = days[0]
  const endDate = days.at(-1)
  const ledger = quoteLedger(options, bookings)

  const toQuote: string[] = []
  const toDecide: string[] = []
  const toBook: string[] = []

  for (const stop of stops) {
    if (stop.kind !== 'stay') continue
    const when = stop.checkIn
      ? `${fmtDay(localDate(stop.checkIn))}–${fmtDay(localDate(stop.checkOut))}`
      : undefined
    const label = `Hotel en ${stop.label}${when ? ` (${when})` : ''}`
    const chosen = stop.lodging.filter((l) => l.role === 'chosen')
    if (stop.lodging.length === 0) {
      toQuote.push(`${label}: sin opciones`)
    } else if (chosen.length === 0) {
      if (!stop.lodging.some((l) => l.price !== undefined)) toQuote.push(label)
      toDecide.push(
        stop.lodging.length > 1 ? `${label}: ${stop.lodging.length} opciones` : label,
      )
    } else {
      for (const l of chosen) {
        if (l.price === undefined) toQuote.push(label)
        if (l.status !== 'booked') toBook.push(l.provider ?? l.title)
      }
    }
  }

  for (const leg of legs) {
    const label = `${leg.fromLabel} → ${leg.toLabel}`
    if (leg.segments.length === 0) {
      toDecide.push(
        leg.routes.length > 0
          ? `${label}: ${plural(leg.routes.length, 'opción', 'opciones')}`
          : `${label}: sin opciones`,
      )
      if (!leg.routes.some((r) => r.price !== undefined)) toQuote.push(label)
      continue
    }
    for (const s of leg.segments) {
      if (s.includedWith) continue
      if (s.price === undefined) toQuote.push(s.flightNumber ?? s.title)
      if (s.status !== 'booked') toBook.push(s.flightNumber ?? s.title)
    }
  }

  return {
    startDate,
    endDate,
    nights: daysBetween(startDate, endDate),
    currency: ledger.currency,
    quoted: ledger.subtotal,
    paid: ledger.paid,
    toPay: ledger.pending,
    toQuote,
    toDecide,
    toBook,
    checklistOpen: checklist.filter((c) => c.status === 'open').length,
  }
}

export function stopTitle(stop: BoardStop): string {
  if (stop.returnsToStart) return `${stop.label} · regreso`
  return stop.visits > 1 ? `${stop.label} · ${stop.visit}ª vez` : stop.label
}
