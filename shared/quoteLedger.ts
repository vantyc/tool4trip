/**
 * Quote bookkeeping stored on the existing TravelOption payload.
 * Alternatives and unpriced pending items stay out of the chosen subtotal.
 * A price change appends the previous amount and its consultation date.
 */

export type BudgetRole = 'primary' | 'alternative' | 'pending'

export interface PriceObservation {
  amount: number
  currency: string
  checkedAt: string
  sourceUrl?: string
}

export interface QuoteFields {
  priceObserved?: number
  currency?: string
  checkedAt?: string
  sourceUrl?: string
  priceHistory?: PriceObservation[]
  budgetRole?: BudgetRole
  /** Primary rows with this false are shown, but not added again (same ticket). */
  countsInBudget?: boolean
  amountPaid?: number
  nextAction?: string
  status?: string
  bookingId?: string
}

export interface BookingPaid {
  id: string
  status?: string
  cost?: number
}

export function applyQuoteRevision<T extends QuoteFields>(
  existing: QuoteFields | undefined,
  next: T,
): T {
  const prevPrice = existing?.priceObserved
  const nextPrice = next.priceObserved
  const samePrice =
    prevPrice === nextPrice &&
    (existing?.currency ?? '') === (next.currency ?? existing?.currency ?? '')
  if (!existing || prevPrice === undefined || samePrice) {
    return {
      ...next,
      priceHistory: next.priceHistory ?? existing?.priceHistory,
    }
  }
  const prior: PriceObservation = {
    amount: prevPrice,
    currency: existing.currency ?? next.currency ?? 'MXN',
    checkedAt: existing.checkedAt ?? new Date().toISOString(),
  }
  if (existing.sourceUrl) prior.sourceUrl = existing.sourceUrl
  return {
    ...next,
    priceHistory: [...(existing.priceHistory ?? []), prior],
  }
}

/** Keep ledger fields when a later package import omits them, and record a new price. */
export function mergeImportedQuote<T extends QuoteFields>(
  existing: QuoteFields | undefined,
  incoming: T,
): T {
  const drafted: T = {
    ...incoming,
    priceHistory: incoming.priceHistory ?? existing?.priceHistory,
    nextAction: incoming.nextAction ?? existing?.nextAction,
    budgetRole: incoming.budgetRole ?? existing?.budgetRole,
    countsInBudget: incoming.countsInBudget ?? existing?.countsInBudget,
    amountPaid: incoming.amountPaid ?? existing?.amountPaid,
  }
  return applyQuoteRevision(existing, drafted)
}

export function optionCountsInBudget(o: QuoteFields): boolean {
  if (o.countsInBudget === false) return false
  if (o.budgetRole === 'alternative' || o.budgetRole === 'pending') return false
  if (o.priceObserved === undefined) return false
  if (o.budgetRole === 'primary' || o.status === 'selected') return true
  return false
}

export function quoteLedger(
  options: QuoteFields[],
  bookings: BookingPaid[] = [],
): {
  currency?: string
  subtotal: number
  paid: number
  pending: number
  unquotedPending: number
} {
  const counted = options.filter(optionCountsInBudget)
  const subtotal = counted.reduce((sum, o) => sum + (o.priceObserved ?? 0), 0)
  const paid = counted.reduce((sum, o) => {
    const booking = o.bookingId
      ? bookings.find((b) => b.id === o.bookingId)
      : undefined
    if (
      booking &&
      (booking.status === 'booked' || booking.status === 'confirmed') &&
      typeof booking.cost === 'number'
    ) {
      return sum + booking.cost
    }
    return sum + (o.amountPaid ?? 0)
  }, 0)
  return {
    currency:
      counted.find((o) => o.currency)?.currency ??
      options.find((o) => o.currency)?.currency,
    subtotal,
    paid,
    pending: Math.max(0, subtotal - paid),
    unquotedPending: options.filter(
      (o) => o.budgetRole === 'pending' && o.priceObserved === undefined,
    ).length,
  }
}

export type ControlOption = QuoteFields & {
  type?: string
  title?: string
  origin?: string
  destination?: string
  startAt?: string
  endAt?: string
}

function isChosenOption(o: QuoteFields): boolean {
  return o.budgetRole === 'primary' || (o.budgetRole == null && o.status === 'selected')
}

function isReturnFlight(o: ControlOption): boolean {
  if (o.type !== 'flight') return false
  if (/regreso|return|vuelta|inbound/i.test(o.title ?? '')) return true
  return /\bMEX\b|\bCDMX\b|\bAICM\b/i.test(o.destination ?? '')
}

function earliest(values: Array<string | undefined>): string | undefined {
  const dated = values.filter((v): v is string => Boolean(v))
  dated.sort((a, b) => Date.parse(a) - Date.parse(b))
  return dated[0]
}

function latest(values: Array<string | undefined>): string | undefined {
  const dated = values.filter((v): v is string => Boolean(v))
  dated.sort((a, b) => Date.parse(a) - Date.parse(b))
  return dated[dated.length - 1]
}

export type TripControlSheet = {
  departure?: string
  returnAt?: string
  currency?: string
  /** Quoted chosen flights. Undefined when none of them have a price. */
  flights?: number
  /** Quoted chosen hotels. Undefined when none of them have a price. */
  hotels?: number
  /** Quoted chosen items. Unpriced hotels and alternatives are not included. */
  total: number
  hotelsUnquoted: boolean
}

/** Control card for the chosen plan. Alternatives stay out of every sum. */
export function tripControlSheet(input: {
  startDate?: string
  endDate?: string
  options: ControlOption[]
}): TripControlSheet {
  const chosenFlights = input.options.filter(
    (o) => o.type === 'flight' && isChosenOption(o),
  )
  const outbound = chosenFlights.filter((o) => !isReturnFlight(o))
  const returns = chosenFlights.filter((o) => isReturnFlight(o))
  const ledger = quoteLedger(input.options)
  const flightSum = quoteLedger(
    input.options.filter((o) => o.type === 'flight'),
  ).subtotal
  const hotelSum = quoteLedger(
    input.options.filter((o) => o.type === 'lodging'),
  ).subtotal
  const pricedFlights = input.options.some(
    (o) => o.type === 'flight' && optionCountsInBudget(o),
  )
  const pricedHotels = input.options.some(
    (o) => o.type === 'lodging' && optionCountsInBudget(o),
  )
  const hotelsUnquoted = input.options.some(
    (o) =>
      o.type === 'lodging' &&
      o.priceObserved === undefined &&
      o.budgetRole !== 'alternative',
  )
  return {
    departure: earliest(outbound.map((o) => o.startAt)) ?? input.startDate,
    returnAt: latest(returns.map((o) => o.endAt ?? o.startAt)) ?? input.endDate,
    currency: ledger.currency,
    flights: pricedFlights ? flightSum : undefined,
    hotels: pricedHotels ? hotelSum : undefined,
    total: ledger.subtotal,
    hotelsUnquoted,
  }
}
