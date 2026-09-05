import {
  buildDemoBookings,
  buildDemoChecklist,
  buildDemoItineraryItems,
  buildDemoReminders,
  buildDemoTrip,
  demoIds,
} from './demoSanMiguel'
import { resolveItineraryItems } from '../domain/resolveItinerary'
import {
  buildTripSummary,
  getCurrentItem,
  getNextItem,
  getOpenChecklistItems,
  getTodayItems,
  getUpcomingCrucialItems,
} from '../application/summary'
import type { ValidationResult } from './validateResolution'

function assert(
  checks: ValidationResult['checks'],
  name: string,
  pass: boolean,
  detail: string,
) {
  checks.push({ name, pass, detail })
}

export function validateSummaryInvariants(): ValidationResult {
  const checks: ValidationResult['checks'] = []
  const trip = buildDemoTrip()
  const bookings = buildDemoBookings()
  const items = buildDemoItineraryItems()
  const checklist = buildDemoChecklist()
  const reminders = buildDemoReminders()
  const resolved = resolveItineraryItems(items, bookings)

  // 10:00 on departure day — after flight start 07:30/end 08:45, before bus 11:00
  const midMorning = new Date('2026-09-20T10:00:00-06:00')
  const nextAt10 = getNextItem(resolved, midMorning)
  assert(
    checks,
    'next at 10:00 is bus',
    nextAt10?.item.id === demoIds.itemBusOut,
    `next=${nextAt10?.title}`,
  )

  const duringBus = new Date('2026-09-20T12:00:00-06:00')
  const currentBus = getCurrentItem(resolved, duringBus)
  assert(
    checks,
    'current during bus window',
    currentBus?.item.id === demoIds.itemBusOut,
    `current=${currentBus?.title}`,
  )
  const nextDuringBus = getNextItem(resolved, duringBus)
  assert(
    checks,
    'next during bus is check-in',
    nextDuringBus?.item.id === demoIds.itemCheckIn,
    `next=${nextDuringBus?.title}`,
  )

  const afterTrip = new Date('2026-10-01T12:00:00-06:00')
  assert(
    checks,
    'next empty after trip',
    getNextItem(resolved, afterTrip) === undefined,
    'no next after trip end',
  )

  const today = getTodayItems(resolved, midMorning, trip.timezone)
  assert(
    checks,
    'today only 20 sep',
    today.length > 0 &&
      today.every((r) => r.startAt?.startsWith('2026-09-20')),
    `count=${today.length} dates=${today.map((t) => t.startAt?.slice(0, 10)).join(',')}`,
  )

  const day21 = new Date('2026-09-21T10:00:00-06:00')
  const today21 = getTodayItems(resolved, day21, trip.timezone)
  assert(
    checks,
    'today 21 sep is event day',
    today21.some((r) => r.item.id === demoIds.itemEvent) &&
      today21.every((r) => r.startAt?.startsWith('2026-09-21')),
    `ids=${today21.map((t) => t.item.id).join(',')}`,
  )

  const linked = today.find((r) => r.item.id === demoIds.itemFlightOut)
  assert(
    checks,
    'linked item has no copied startAt on entity',
    linked !== undefined &&
      linked.item.startAt === undefined &&
      linked.startAt === '2026-09-20T07:30:00-06:00',
    `resolved=${linked?.startAt} raw=${linked?.item.startAt}`,
  )

  const crucial = getUpcomingCrucialItems(resolved, midMorning)
  assert(
    checks,
    'crucial only importance=crucial',
    crucial.length > 0 && crucial.every((r) => r.importance === 'crucial'),
    `n=${crucial.length}`,
  )
  assert(
    checks,
    'crucial excludes recommended walk',
    !crucial.some((r) => r.item.id === demoIds.itemWalk),
    'walk not in crucial',
  )

  const open = getOpenChecklistItems(checklist)
  assert(
    checks,
    'open checklist only',
    open.every((c) => c.status === 'open') &&
      open.length === checklist.filter((c) => c.status === 'open').length,
    `open=${open.length}`,
  )
  assert(
    checks,
    'done checklist excluded',
    !open.some((c) => c.status === 'done'),
    'no done items',
  )

  // Booking time change reflected in summary
  const shifted = bookings.map((b) =>
    b.id === demoIds.busOut
      ? { ...b, startAt: '2026-09-20T12:30:00-06:00', endAt: '2026-09-20T15:30:00-06:00' }
      : b,
  )
  const resolvedShifted = resolveItineraryItems(items, shifted)
  const nextAfterShift = getNextItem(resolvedShifted, midMorning)
  assert(
    checks,
    'summary reflects booking time change',
    nextAfterShift?.item.id === demoIds.itemBusOut &&
      nextAfterShift.startAt === '2026-09-20T12:30:00-06:00',
    `next start=${nextAfterShift?.startAt}`,
  )
  assert(
    checks,
    'offset preserved after shift',
    nextAfterShift?.startAt?.endsWith('-06:00') === true,
    `offset=${nextAfterShift?.startAt}`,
  )

  const summary = buildTripSummary({
    resolvedItems: resolved,
    checklist,
    reminders,
    tripTimeZone: trip.timezone,
    now: midMorning,
  })
  assert(
    checks,
    'summary next excludes from crucial',
    summary.next !== undefined &&
      !summary.crucial.some((c) => c.item.id === summary.next!.item.id),
    'siguiente not repeated in crucial',
  )

  return { ok: checks.every((c) => c.pass), checks }
}
