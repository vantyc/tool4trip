import type { Booking, TravelOption, TravelOptionType } from '../../domain/types'
import { newId } from '../ids'
import type { BoardItem, BoardLeg, BoardStop } from './buildTripBoard'
import { placeKey, resolvePlace } from './places'
import { minutesBetween, offsetForZone } from './time'

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

function stamp(date: string, clock: string, place?: string, fallbackOffset?: string): string {
  const tz = resolvePlace(place)?.tz
  const offset = (tz ? offsetForZone(tz, `${date}T${clock}`) : undefined) ?? fallbackOffset
  return `${date}T${clock}:00${offset ?? ''}`
}

const NOW = () => new Date().toISOString()

export function newStayOption(
  tripId: string,
  input: {
    place: string
    checkIn: string
    checkOut: string
    hotel?: string
    price?: number
    currency?: string
    address?: string
    /** Offset to use when the place zone is unknown (a neighbouring stop's). */
    fallbackOffset?: string
  },
): TravelOption {
  const place = input.place.trim()
  const hotel = input.hotel?.trim()
  const now = NOW()
  return {
    id: newId(),
    tripId,
    type: 'lodging',
    status: 'researched',
    budgetRole: 'pending',
    title: hotel
      ? `${hotel} — ${place}`
      : `Pendiente — hotel en ${place}, ${input.checkIn} al ${input.checkOut}`,
    provider: hotel || undefined,
    destination: place,
    address: input.address?.trim() || undefined,
    startAt: stamp(input.checkIn, '15:00', place, input.fallbackOffset),
    endAt: stamp(input.checkOut, '11:00', place, input.fallbackOffset),
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
