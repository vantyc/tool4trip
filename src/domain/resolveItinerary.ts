import type {
  Booking,
  BookingAnchor,
  ItineraryItem,
  Reminder,
  ResolvedItineraryItem,
} from './types'

/**
 * Maps a Booking + bookingAnchor to concrete schedule fields.
 * Single source of truth: Booking owns times; ItineraryItem only points.
 */
export function scheduleFromBooking(
  booking: Booking,
  anchor: BookingAnchor = 'start',
): Pick<
  ResolvedItineraryItem,
  'startAt' | 'endAt' | 'startTimeZone' | 'endTimeZone' | 'place' | 'title'
> {
  const place =
    booking.address ??
    (anchor === 'end' || anchor === 'arrival' || anchor === 'check_out'
      ? booking.destination
      : booking.origin) ??
    booking.destination ??
    booking.origin

  switch (anchor) {
    case 'end':
    case 'arrival':
    case 'check_out':
      return {
        title: booking.title,
        startAt: booking.endAt ?? booking.startAt,
        endAt: booking.endAt,
        startTimeZone: booking.endTimeZone ?? booking.startTimeZone,
        endTimeZone: booking.endTimeZone,
        place,
      }
    case 'start':
    case 'departure':
    case 'check_in':
    default:
      return {
        title: booking.title,
        startAt: booking.startAt,
        endAt: booking.endAt,
        startTimeZone: booking.startTimeZone,
        endTimeZone: booking.endTimeZone,
        place,
      }
  }
}

export function resolveItineraryItem(
  item: ItineraryItem,
  bookingById: Map<string, Booking>,
): ResolvedItineraryItem {
  if (item.bookingId) {
    const booking = bookingById.get(item.bookingId)
    if (!booking) {
      return {
        item,
        title: item.title ?? 'Reserva no encontrada',
        startAt: undefined,
        endAt: undefined,
        place: item.place,
        importance: item.importance,
        goalIds: item.goalIds,
      }
    }
    const fromBooking = scheduleFromBooking(
      booking,
      item.bookingAnchor ?? 'start',
    )
    return {
      item,
      booking,
      title: item.title ?? fromBooking.title,
      startAt: fromBooking.startAt,
      endAt: fromBooking.endAt,
      startTimeZone: fromBooking.startTimeZone,
      endTimeZone: fromBooking.endTimeZone,
      place: fromBooking.place,
      importance: item.importance,
      goalIds: item.goalIds,
    }
  }

  return {
    item,
    title: item.title ?? 'Sin título',
    startAt: item.startAt,
    endAt: item.endAt,
    startTimeZone: item.startTimeZone,
    endTimeZone: item.endTimeZone,
    place: item.place,
    importance: item.importance,
    goalIds: item.goalIds,
  }
}

export function resolveItineraryItems(
  items: ItineraryItem[],
  bookings: Booking[],
): ResolvedItineraryItem[] {
  const bookingById = new Map(bookings.map((b) => [b.id, b]))
  return items
    .map((item) => resolveItineraryItem(item, bookingById))
    .sort((a, b) => {
      const aKey = a.startAt ?? ''
      const bKey = b.startAt ?? ''
      return aKey.localeCompare(bKey)
    })
}

/** Instant when a reminder fires, derived from the resolved itinerary schedule. */
export function resolveReminderTriggerAt(
  reminder: Reminder,
  resolved: ResolvedItineraryItem,
): string | undefined {
  if (reminder.kind === 'absolute') {
    return reminder.triggerAt
  }

  const anchorAt =
    reminder.anchor === 'end'
      ? (resolved.endAt ?? resolved.startAt)
      : resolved.startAt

  if (!anchorAt) return undefined

  return shiftIsoKeepingOffset(anchorAt, reminder.offsetMinutes)
}

/** Shift an ISO-with-offset timestamp by minutes, preserving the numeric offset. */
export function shiftIsoKeepingOffset(
  iso: string,
  offsetMinutes: number,
): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso

  const offsetMatch = iso.match(/([+-]\d{2}:\d{2}|Z)$/)
  const offset = offsetMatch?.[1] ?? 'Z'
  const offsetMin =
    offset === 'Z'
      ? 0
      : (offset.startsWith('-') ? -1 : 1) *
        (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)))

  const wall = new Date(ms + offsetMinutes * 60_000 + offsetMin * 60_000)
  const y = wall.getUTCFullYear()
  const mo = String(wall.getUTCMonth() + 1).padStart(2, '0')
  const d = String(wall.getUTCDate()).padStart(2, '0')
  const h = String(wall.getUTCHours()).padStart(2, '0')
  const mi = String(wall.getUTCMinutes()).padStart(2, '0')
  const s = String(wall.getUTCSeconds()).padStart(2, '0')
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`
}
