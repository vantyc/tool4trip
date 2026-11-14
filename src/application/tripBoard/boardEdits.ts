import type { Booking, TravelOption, TravelOptionType } from '../../domain/types'
import { newId } from '../ids'
import type { BoardItem, BoardLeg, BoardStop, NightSplit, TripBoard } from './buildTripBoard'
import { placeKey, resolvePlace } from './places'
import {
  addDays,
  daysBetween,
  isoOffset,
  localClock,
  localDate,
  minutesBetween,
  offsetForZone,
} from './time'

export type OptionPatch = Partial<
  Pick<
    TravelOption,
    | 'title'
    | 'provider'
    | 'startAt'
    | 'endAt'
    | 'origin'
    | 'destination'
    | 'address'
    | 'phone'
    | 'priceObserved'
    | 'currency'
    | 'sourceUrl'
    | 'amountPaid'
    | 'nextAction'
    | 'notes'
    | 'status'
    | 'budgetRole'
    | 'stayWindow'
  >
>

export type PlannedChange = { option: TravelOption; patch: OptionPatch }

const CHOSEN: OptionPatch = { budgetRole: 'primary', status: 'selected' }
const SET_ASIDE: OptionPatch = { budgetRole: 'alternative', status: 'shortlisted' }

/** Choosing one saved route for an undecided leg; the other routes stay as alternatives. */
export function chooseRoutePlan(leg: BoardLeg, routeId: string): PlannedChange[] {
  const route = leg.routes.find((r) => r.id === routeId)
  if (!route) return []
  const changes: PlannedChange[] = []
  for (const r of leg.routes) {
    for (const item of r.items) {
      if (!item.option) continue
      changes.push({ option: item.option, patch: r === route ? CHOSEN : SET_ASIDE })
    }
  }
  return changes
}

/** Choosing one hotel for a stay; the other candidates stay as alternatives. */
export function chooseLodgingPlan(stop: BoardStop, itemId: string): PlannedChange[] {
  const target = [...stop.lodging, ...stop.lodgingAlternatives].find((l) => l.id === itemId)
  if (!target?.option) return []
  const changes: PlannedChange[] = [{ option: target.option, patch: CHOSEN }]
  for (const other of stop.lodging) {
    if (other.id === itemId || !other.option || other.status === 'booked') continue
    changes.push({ option: other.option, patch: SET_ASIDE })
  }
  return changes
}

/**
 * Only a one-way option between the same two places can replace a leg here.
 * Round trips and multi-leg tickets change several legs at once.
 */
export function canSwapAlternative(leg: BoardLeg, alt: BoardItem): boolean {
  if (!alt.option || leg.segments.length === 0) return false
  const first = leg.segments[0]!
  const last = leg.segments.at(-1)!
  if (placeKey(alt.origin) !== placeKey(first.origin)) return false
  if (placeKey(alt.destination) !== placeKey(last.destination)) return false
  const span = minutesBetween(alt.startAt, alt.endAt)
  return span === undefined || span <= 36 * 60
}

export function swapAlternativePlan(leg: BoardLeg, altId: string): PlannedChange[] {
  const alt = leg.alternatives.find((a) => a.id === altId)
  if (!alt?.option || !canSwapAlternative(leg, alt)) return []
  return [
    { option: alt.option, patch: CHOSEN },
    ...leg.segments
      .filter((s) => s.option)
      .map((s) => ({ option: s.option!, patch: SET_ASIDE })),
  ]
}

/** Lodging rows that make up a stay's dates (chosen, pending and set-aside hotels). */
function stayRows(stop: BoardStop): TravelOption[] {
  const inDay = localDate(stop.checkIn)
  return [...stop.lodging, ...stop.lodgingAlternatives]
    .filter((l) => l.option && l.status !== 'booked')
    .filter((l) => (l.window ? stop.window !== undefined : !inDay || localDate(l.startAt) === inDay))
    .map((l) => l.option!)
}

/** True when a booked hotel fixes this stay's dates; edit those with the hotel. */
export function stayHasBooking(stop: BoardStop): boolean {
  return stop.lodging.some((l) => l.status === 'booked')
}

/** Same wall clock and offset as `previous` on a new date; defaults for new stamps. */
function moveStamp(
  previous: string | undefined,
  date: string,
  defaultClock: string,
  place?: string,
  fallbackOffset?: string,
): string {
  const clock = localClock(previous) ?? defaultClock
  const offset = isoOffset(previous)
  return offset ? `${date}T${clock}:00${offset}` : stamp(date, clock, place, fallbackOffset)
}

function retitle(o: TravelOption, from: string, to: string): Partial<TravelOption> {
  const m = o.title.match(PLACEHOLDER_TITLE)
  return m ? { title: placeholderTitle(m[1]!, from, to) } : {}
}

/** New check-in / check-out dates for every hotel row of a stay. Clocks stay as they were. */
export function stayDatesPlan(
  stop: BoardStop,
  checkIn: string,
  checkOut: string,
  fallbackOffset?: string,
): PlannedChange[] {
  if (!(daysBetween(checkIn, checkOut)! > 0)) return []
  return stayRows(stop).map((o) => ({
    option: o,
    patch: {
      startAt: moveStamp(o.startAt, checkIn, '15:00', o.destination ?? stop.label, fallbackOffset),
      endAt: moveStamp(o.endAt, checkOut, '11:00', o.destination ?? stop.label, fallbackOffset),
      stayWindow: undefined,
      ...retitle(o, checkIn, checkOut),
    },
  }))
}

/**
 * Moves the boundary between two consecutive stays: the first keeps
 * `firstNights`, the second gets the rest up to the end of the shared span.
 */
export function splitNightsPlan(
  board: TripBoard,
  split: NightSplit,
  firstNights: number,
): PlannedChange[] {
  if (firstNights < 1 || firstNights >= split.total) return []
  const a = board.stops.find((s) => s.id === split.firstStopId)
  const b = board.stops.find((s) => s.id === split.secondStopId)
  if (!a || !b || stayHasBooking(a) || stayHasBooking(b)) return []
  const boundary = addDays(split.from, firstNights)
  const firstOffset = isoOffset(a.checkIn)
  const changes: PlannedChange[] = []
  for (const o of stayRows(a)) {
    changes.push({
      option: o,
      patch: {
        endAt: moveStamp(o.endAt, boundary, '11:00', o.destination ?? a.label, firstOffset),
        ...retitle(o, localDate(o.startAt) ?? split.from, boundary),
      },
    })
  }
  for (const o of stayRows(b)) {
    const place = o.destination ?? b.label
    changes.push({
      option: o,
      patch: {
        startAt: moveStamp(o.startAt, boundary, '15:00', place, firstOffset),
        endAt: moveStamp(o.endAt, localDate(o.endAt) ?? split.to, '11:00', place, firstOffset),
        stayWindow: undefined,
        ...retitle(o, boundary, localDate(o.endAt) ?? split.to),
      },
    })
  }
  return changes
}

function stamp(date: string, clock: string, place?: string, fallbackOffset?: string): string {
  const tz = resolvePlace(place)?.tz
  const offset = (tz ? offsetForZone(tz, `${date}T${clock}`) : undefined) ?? fallbackOffset
  return `${date}T${clock}:00${offset ?? ''}`
}

const NOW = () => new Date().toISOString()

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** "17 al 23 nov 2026" (or "28 nov al 2 dic 2026"). */
function rangeText(from: string, to: string): string {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number]
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number]
  const mon = (m: number) => MONTHS[m - 1]
  if (y1 === y2 && m1 === m2) return `${d1} al ${d2} ${mon(m2)} ${y2}`
  if (y1 === y2) return `${d1} ${mon(m1)} al ${d2} ${mon(m2)} ${y2}`
  return `${d1} ${mon(m1)} ${y1} al ${d2} ${mon(m2)} ${y2}`
}

const PLACEHOLDER_TITLE = /^Pendiente — hotel en (.+?), /

function placeholderTitle(place: string, from?: string, to?: string): string {
  return `Pendiente — hotel en ${place}, ${from && to ? rangeText(from, to) : 'fechas por definir'}`
}

export function newStayOption(
  tripId: string,
  input: {
    place: string
    hotel?: string
    price?: number
    currency?: string
    address?: string
    /** Offset to use when the place zone is unknown (a neighbouring stop's). */
    fallbackOffset?: string
  } & (
    | { checkIn: string; checkOut: string; window?: undefined }
    | { checkIn?: undefined; checkOut?: undefined; window: { from: string; to: string } }
  ),
): TravelOption {
  const place = input.place.trim()
  const hotel = input.hotel?.trim()
  const now = NOW()
  const dated = input.checkIn !== undefined
  return {
    id: newId(),
    tripId,
    type: 'lodging',
    status: 'researched',
    budgetRole: 'pending',
    title: hotel ? `${hotel} — ${place}` : placeholderTitle(place, input.checkIn, input.checkOut),
    provider: hotel || undefined,
    destination: place,
    address: input.address?.trim() || undefined,
    startAt: dated ? stamp(input.checkIn!, '15:00', place, input.fallbackOffset) : undefined,
    endAt: dated ? stamp(input.checkOut!, '11:00', place, input.fallbackOffset) : undefined,
    stayWindow: dated ? undefined : input.window,
    priceObserved: input.price,
    currency: input.price !== undefined ? (input.currency ?? 'MXN') : undefined,
    sourceType: 'manual',
    verificationStatus: 'unverified',
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
  }
}

export function newLegOption(
  tripId: string,
  input: {
    type: TravelOptionType
    origin: string
    destination: string
    date?: string
    title?: string
    provider?: string
    price?: number
    currency?: string
    sourceUrl?: string
  },
): TravelOption {
  const now = NOW()
  const origin = input.origin.trim()
  const destination = input.destination.trim()
  return {
    id: newId(),
    tripId,
    type: input.type,
    status: 'researched',
    budgetRole: 'pending',
    title:
      input.title?.trim() ||
      `Pendiente — ${origin} → ${destination}${input.date ? `, ${input.date}` : ''}`,
    provider: input.provider?.trim() || undefined,
    origin,
    destination,
    priceObserved: input.price,
    currency: input.price !== undefined ? (input.currency ?? 'MXN') : undefined,
    sourceUrl: input.sourceUrl?.trim() || undefined,
    sourceType: 'manual',
    verificationStatus: 'unverified',
    createdAt: now,
    updatedAt: now,
    syncStatus: 'synced',
  }
}

type OptionService = {
  save: (o: TravelOption) => Promise<TravelOption>
  get: (id: string) => Promise<TravelOption | undefined>
  updateQuote: (
    id: string,
    patch: {
      priceObserved?: number | null
      currency?: string
      sourceUrl?: string | null
      nextAction?: string | null
    },
  ) => Promise<TravelOption>
  convertToBooking: (id: string) => Promise<{ option: TravelOption; booking: Booking }>
}

type BookingService = {
  save: (b: Booking) => Promise<Booking>
}

/**
 * Price changes go through updateQuote so the previous quote lands in
 * priceHistory; the rest of the fields are a plain save.
 */
export async function saveOptionEdit(
  travelOptions: OptionService,
  option: TravelOption,
  patch: OptionPatch,
): Promise<TravelOption> {
  let current = option
  const quoteKeys = ['priceObserved', 'currency', 'sourceUrl', 'nextAction'] as const
  if (quoteKeys.some((k) => k in patch && patch[k] !== option[k])) {
    current = await travelOptions.updateQuote(option.id, {
      priceObserved: 'priceObserved' in patch ? (patch.priceObserved ?? null) : undefined,
      currency: patch.currency,
      sourceUrl: 'sourceUrl' in patch ? (patch.sourceUrl ?? null) : undefined,
      nextAction: 'nextAction' in patch ? (patch.nextAction ?? null) : undefined,
    })
  }
  const rest: OptionPatch = { ...patch }
  for (const k of quoteKeys) delete rest[k]
  if (Object.keys(rest).length === 0) return current
  return travelOptions.save({ ...current, ...rest })
}

export async function applyPlan(
  travelOptions: OptionService,
  changes: PlannedChange[],
): Promise<void> {
  for (const { option, patch } of changes) {
    const fresh = (await travelOptions.get(option.id)) ?? option
    await travelOptions.save({ ...fresh, ...patch })
  }
}

/**
 * Converts the option into a Booking marked booked. Without "fully paid"
 * the booking carries no cost, so the ledger keeps using amountPaid.
 */
export async function markOptionBooked(
  services: { travelOptions: OptionService; bookings: BookingService },
  option: TravelOption,
  input: { confirmation?: string; fullyPaid: boolean; amountPaid?: number },
): Promise<void> {
  const { booking } = await services.travelOptions.convertToBooking(option.id)
  await services.bookings.save({
    ...booking,
    status: 'booked',
    confirmationNumber: input.confirmation?.trim() || booking.confirmationNumber,
    cost: input.fullyPaid ? (booking.cost ?? option.priceObserved) : undefined,
  })
  const linked = (await services.travelOptions.get(option.id)) ?? option
  await services.travelOptions.save({
    ...linked,
    budgetRole: 'primary',
    ...(!input.fullyPaid && input.amountPaid !== undefined
      ? { amountPaid: input.amountPaid }
      : {}),
  })
}
