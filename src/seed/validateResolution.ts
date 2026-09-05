import {
  resolveItineraryItems,
  resolveReminderTriggerAt,
} from '../domain/resolveItinerary'
import type { Booking, ItineraryItem, Reminder } from '../domain/types'
import {
  buildDemoBookings,
  buildDemoItineraryItems,
  buildDemoReminders,
  demoIds,
} from './demoSanMiguel'

export interface ValidationResult {
  ok: boolean
  checks: { name: string; pass: boolean; detail: string }[]
}

function assert(
  checks: ValidationResult['checks'],
  name: string,
  pass: boolean,
  detail: string,
) {
  checks.push({ name, pass, detail })
}

/**
 * Pure in-memory validation of single-source-of-truth rules.
 * Does not touch IndexedDB.
 */
export function validateResolutionInvariants(): ValidationResult {
  const checks: ValidationResult['checks'] = []

  const bookings = buildDemoBookings()
  const items = buildDemoItineraryItems()
  const reminders = buildDemoReminders()

  const flightItem = items.find((i) => i.id === demoIds.itemFlightOut)!
  assert(
    checks,
    'linked item has no own startAt',
    flightItem.startAt === undefined && flightItem.endAt === undefined,
    'ItineraryItem del vuelo no debe copiar horarios',
  )

  const resolvedBefore = resolveItineraryItems(items, bookings)
  const flightResolved = resolvedBefore.find(
    (r) => r.item.id === demoIds.itemFlightOut,
  )!
  assert(
    checks,
    'resolve from booking',
    flightResolved.startAt === '2026-09-20T07:30:00-06:00',
    `startAt resuelto=${flightResolved.startAt}`,
  )
  assert(
    checks,
    'offset preserved',
    flightResolved.startAt?.endsWith('-06:00') === true,
    `offset en startAt: ${flightResolved.startAt}`,
  )

  // Mutate booking only — item unchanged
  const bookingsAfter: Booking[] = bookings.map((b) =>
    b.id === demoIds.flightOut
      ? {
          ...b,
          startAt: '2026-09-20T09:15:00-06:00',
          endAt: '2026-09-20T10:30:00-06:00',
        }
      : b,
  )
  const itemSnapshot: ItineraryItem = { ...flightItem }
  const resolvedAfter = resolveItineraryItems(items, bookingsAfter)
  const flightAfter = resolvedAfter.find(
    (r) => r.item.id === demoIds.itemFlightOut,
  )!
  assert(
    checks,
    'booking time change propagates',
    flightAfter.startAt === '2026-09-20T09:15:00-06:00',
    `nuevo startAt=${flightAfter.startAt}`,
  )
  assert(
    checks,
    'itinerary item unchanged',
    itemSnapshot.startAt === undefined &&
      JSON.stringify(itemSnapshot) === JSON.stringify(flightItem),
    'ItineraryItem no se mutó al cambiar Booking',
  )

  const rem24 = reminders.find((r) => r.id === demoIds.rem24h)! as Reminder
  const rem3 = reminders.find((r) => r.id === demoIds.rem3h)! as Reminder
  const before24 = resolveReminderTriggerAt(rem24, flightResolved)!
  const after24 = resolveReminderTriggerAt(rem24, flightAfter)!
  const before3 = resolveReminderTriggerAt(rem3, flightResolved)!
  const after3 = resolveReminderTriggerAt(rem3, flightAfter)!

  assert(
    checks,
    'relative 24h before change',
    Date.parse(before24) ===
      Date.parse('2026-09-20T07:30:00-06:00') - 24 * 60 * 60 * 1000,
    `trigger=${before24}`,
  )
  assert(
    checks,
    'relative 24h after booking change',
    Date.parse(after24) ===
      Date.parse('2026-09-20T09:15:00-06:00') - 24 * 60 * 60 * 1000,
    `trigger=${after24}`,
  )
  assert(
    checks,
    'relative 3h recalculates',
    Date.parse(after3) - Date.parse(before3) ===
      Date.parse('2026-09-20T09:15:00-06:00') -
        Date.parse('2026-09-20T07:30:00-06:00'),
    `delta 3h rem = delta vuelo`,
  )

  const abs = reminders.find((r) => r.id === demoIds.remAbs)!
  assert(
    checks,
    'absolute reminder unchanged by booking',
    abs.kind === 'absolute' &&
      resolveReminderTriggerAt(abs, flightAfter) ===
        '2026-09-21T12:00:00-06:00',
    'reminder absoluto conserva triggerAt',
  )

  // Chronological order in memory
  const order = resolvedBefore.map((r) => r.title)
  const times = resolvedBefore.map((r) => r.startAt ?? '')
  const sortedTimes = [...times].sort((a, b) => a.localeCompare(b))
  assert(
    checks,
    'chronological sort in memory',
    times.every((t, i) => t === sortedTimes[i]),
    `orden: ${order.join(' → ')}`,
  )

  // Distinct offsets example: mutate flight arrival to a different offset string
  const crossZone: Booking[] = bookings.map((b) =>
    b.id === demoIds.flightOut
      ? {
          ...b,
          startAt: '2026-09-20T07:30:00-06:00',
          endAt: '2026-09-20T14:00:00-05:00',
          endTimeZone: 'America/New_York',
        }
      : b,
  )
  const crossResolved = resolveItineraryItems(items, crossZone).find(
    (r) => r.item.id === demoIds.itemFlightOut,
  )!
  assert(
    checks,
    'distinct offsets on start/end',
    crossResolved.startAt === '2026-09-20T07:30:00-06:00' &&
      crossResolved.endAt === '2026-09-20T14:00:00-05:00',
    `start=${crossResolved.startAt} end=${crossResolved.endAt}`,
  )

  return {
    ok: checks.every((c) => c.pass),
    checks,
  }
}
