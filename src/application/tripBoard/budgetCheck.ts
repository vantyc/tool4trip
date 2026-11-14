import { stopTitle, type BoardItem, type TripBoard } from './buildTripBoard'

export type BudgetLine = {
  id: string
  text: string
  amount?: number
  currency?: string
  stopId?: string
  legId?: string
}

export type BudgetCheck = {
  currency: string
  /** Chosen items with a price (the board subtotal). */
  quoted: number
  quotedTransport: number
  quotedLodging: number
  /** Cheapest saved price for each item still undecided. */
  projected: BudgetLine[]
  /** What the plan costs so far: quoted plus projected. */
  total: number
  cap?: number
  remaining?: number
  over: boolean
  /** Items with no price yet: the total can only grow. */
  unpriced: BudgetLine[]
  /** Prices in another currency, left out of the total. */
  otherCurrency: BudgetLine[]
}

/**
 * What the plan costs so far against the trip budget: the quoted subtotal
 * plus the cheapest saved candidate for each undecided hotel or leg.
 */
export function checkBudget(board: TripBoard, budget: { cap?: number; currency: string }): BudgetCheck {
  const { currency } = budget
  const sameCurrency = (c?: string) => !c || c === currency
  const projected: BudgetLine[] = []
  const unpriced: BudgetLine[] = []
  const otherCurrency: BudgetLine[] = []

  const s = board.summary
  const inCurrency = sameCurrency(s.currency)
  if (!inCurrency && s.quoted > 0) {
    otherCurrency.push({ id: 'quoted', text: 'Subtotal cotizado', amount: s.quoted, currency: s.currency })
  }

  const cheapest = (items: Array<{ price?: number; currency?: string }>) =>
    items
      .filter((i) => i.price !== undefined && sameCurrency(i.currency))
      .sort((a, b) => a.price! - b.price!)[0]
  const foreign = (items: Array<{ price?: number; currency?: string }>) =>
    items.find((i) => i.price !== undefined && !sameCurrency(i.currency))

  for (const stop of board.stops) {
    if (stop.kind !== 'stay' || stop.nights === 0) continue
    const chosen = stop.lodging.filter((l) => l.role === 'chosen')
    if (chosen.length > 0) {
      for (const l of chosen) {
        if (l.price !== undefined || !l.countsInBudget) continue
        unpriced.push({ id: l.id, text: `Hotel ${l.provider ?? l.title} (${stopTitle(stop)})`, stopId: stop.id })
      }
      continue
    }
    const candidates: BoardItem[] = [...stop.lodging, ...stop.lodgingAlternatives]
    const best = cheapest(candidates) as BoardItem | undefined
    const text = `Hotel en ${stopTitle(stop)}`
    if (best) {
      projected.push({
        id: stop.id,
        text: best.provider ? `${text}: ${best.provider}` : text,
        amount: best.price,
        currency: best.currency,
        stopId: stop.id,
      })
      continue
    }
    const other = foreign(candidates)
    if (other) otherCurrency.push({ id: stop.id, text, amount: other.price, currency: other.currency, stopId: stop.id })
    else unpriced.push({ id: stop.id, text, stopId: stop.id })
  }

  for (const leg of board.legs) {
    const text = `${leg.fromLabel} → ${leg.toLabel}`
    if (leg.segments.length === 0) {
      const best = cheapest(leg.routes)
      if (best) {
        projected.push({ id: leg.id, text, amount: best.price, currency: best.currency, legId: leg.id })
        continue
      }
      const other = foreign(leg.routes)
      if (other) otherCurrency.push({ id: leg.id, text, amount: other.price, currency: other.currency, legId: leg.id })
      else unpriced.push({ id: leg.id, text, legId: leg.id })
      continue
    }
    for (const seg of leg.segments) {
      if (seg.price !== undefined || seg.includedWith || !seg.countsInBudget) continue
      unpriced.push({ id: seg.id, text: seg.flightNumber ?? seg.title, legId: leg.id })
    }
  }

  const quoted = inCurrency ? s.quoted : 0
  const total = quoted + projected.reduce((t, l) => t + (l.amount ?? 0), 0)
  const remaining = budget.cap !== undefined ? budget.cap - total : undefined
  return {
    currency,
    quoted,
    quotedTransport: inCurrency ? s.quotedTransport : 0,
    quotedLodging: inCurrency ? s.quotedLodging : 0,
    projected,
    total,
    cap: budget.cap,
    remaining,
    over: remaining !== undefined && remaining < 0,
    unpriced,
    otherCurrency,
  }
}
