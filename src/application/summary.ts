import type {
  ChecklistItem,
  Reminder,
  ResolvedItineraryItem,
} from '../domain/types'
import { resolveReminderTriggerAt } from '../domain/resolveItinerary'

/** Calendar YYYY-MM-DD in an IANA timezone. */
export function calendarDateInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Local calendar date from an ISO-8601 string with offset (date at that place). */
export function localDateFromIso(iso: string): string {
  return iso.slice(0, 10)
}

export function parseInstant(iso?: string): number | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Activity currently in progress: startAt <= now < endAt.
 * Items without endAt are not treated as "current".
 */
export function getCurrentItem(
  items: ResolvedItineraryItem[],
  now: Date,
): ResolvedItineraryItem | undefined {
  const nowMs = now.getTime()
  return items.find((item) => {
    const start = parseInstant(item.startAt)
    const end = parseInstant(item.endAt)
    if (start === undefined || end === undefined) return false
    return start <= nowMs && nowMs < end
  })
}

/** Next upcoming item strictly after now (by startAt). */
export function getNextItem(
  items: ResolvedItineraryItem[],
  now: Date,
): ResolvedItineraryItem | undefined {
  const nowMs = now.getTime()
  return items.find((item) => {
    const start = parseInstant(item.startAt)
    return start !== undefined && start > nowMs
  })
}

/**
 * Items whose local start date (from ISO offset / Booking local time)
 * matches "today" in the trip reference timezone.
 */
export function getTodayItems(
  items: ResolvedItineraryItem[],
  now: Date,
  tripTimeZone: string,
): ResolvedItineraryItem[] {
  const today = calendarDateInTimeZone(now, tripTimeZone)
  return items.filter((item) => {
    if (!item.startAt) return false
    return localDateFromIso(item.startAt) === today
  })
}

/**
 * Upcoming crucial items (startAt >= now), excluding ids already featured
 * (e.g. SIGUIENTE) to avoid noisy repetition.
 */
export function getUpcomingCrucialItems(
  items: ResolvedItineraryItem[],
  now: Date,
  options?: { excludeIds?: string[]; limit?: number },
): ResolvedItineraryItem[] {
  const nowMs = now.getTime()
  const exclude = new Set(options?.excludeIds ?? [])
  const limit = options?.limit ?? 8
  return items
    .filter((item) => {
      if (item.importance !== 'crucial') return false
      if (exclude.has(item.item.id)) return false
      const start = parseInstant(item.startAt)
      return start !== undefined && start >= nowMs
    })
    .slice(0, limit)
}

export function getOpenChecklistItems(
  items: ChecklistItem[],
): ChecklistItem[] {
  return items
    .filter((item) => item.status === 'open')
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

export interface ResolvedReminderView {
  reminder: Reminder
  triggerAt: string
  item: ResolvedItineraryItem
}

/** Reminders whose trigger is between now and horizonMs ahead (default 6h). */
export function getUpcomingReminders(
  reminders: Reminder[],
  resolvedItems: ResolvedItineraryItem[],
  now: Date,
  horizonMs = 6 * 60 * 60 * 1000,
): ResolvedReminderView[] {
  const nowMs = now.getTime()
  const byId = new Map(resolvedItems.map((r) => [r.item.id, r]))
  const out: ResolvedReminderView[] = []

  for (const reminder of reminders) {
    if (reminder.done) continue
    const item = byId.get(reminder.itineraryItemId)
    if (!item) continue
    const triggerAt = resolveReminderTriggerAt(reminder, item)
    if (!triggerAt) continue
    const triggerMs = Date.parse(triggerAt)
    if (Number.isNaN(triggerMs)) continue
    if (triggerMs >= nowMs && triggerMs <= nowMs + horizonMs) {
      out.push({ reminder, triggerAt, item })
    }
  }

  return out.sort(
    (a, b) => Date.parse(a.triggerAt) - Date.parse(b.triggerAt),
  )
}

export interface TripSummary {
  now: Date
  todayLabel: string
  current: ResolvedItineraryItem | undefined
  next: ResolvedItineraryItem | undefined
  today: ResolvedItineraryItem[]
  crucial: ResolvedItineraryItem[]
  openChecklist: ChecklistItem[]
  nextReminders: ResolvedReminderView[]
}

export function buildTripSummary(input: {
  resolvedItems: ResolvedItineraryItem[]
  checklist: ChecklistItem[]
  reminders: Reminder[]
  tripTimeZone: string
  now: Date
}): TripSummary {
  const { resolvedItems, checklist, reminders, tripTimeZone, now } = input
  const current = getCurrentItem(resolvedItems, now)
  const next = getNextItem(resolvedItems, now)
  const excludeIds = [
    ...(next ? [next.item.id] : []),
    ...(current ? [current.item.id] : []),
  ]

  return {
    now,
    todayLabel: calendarDateInTimeZone(now, tripTimeZone),
    current,
    next,
    today: getTodayItems(resolvedItems, now, tripTimeZone),
    crucial: getUpcomingCrucialItems(resolvedItems, now, { excludeIds }),
    openChecklist: getOpenChecklistItems(checklist),
    nextReminders: next
      ? getUpcomingReminders(reminders, resolvedItems, now).filter(
          (r) => r.reminder.itineraryItemId === next.item.id,
        )
      : getUpcomingReminders(reminders, resolvedItems, now).slice(0, 1),
  }
}

/** Human-readable remaining time until an ISO instant. */
export function formatTimeUntil(iso: string, now: Date): string {
  const target = Date.parse(iso)
  const diff = target - now.getTime()
  if (diff <= 0) return 'Ahora'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `Faltan ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  if (hours < 48) {
    return rem === 0 ? `Faltan ${hours} h` : `Faltan ${hours} h ${rem} min`
  }
  const days = Math.floor(hours / 24)
  return days === 1 ? 'Falta 1 día' : `Faltan ${days} días`
}

export function formatClockHm(iso?: string): string {
  if (!iso) return '—'
  const m = iso.match(/T(\d{2}:\d{2})/)
  return m?.[1] ?? '—'
}

export function formatShortDate(isoDate: string): string {
  // 2026-09-20 → 20 SEP
  const m = isoDate.match(/^\d{4}-(\d{2})-(\d{2})$/)
  if (!m) return isoDate
  const months = [
    'ENE',
    'FEB',
    'MAR',
    'ABR',
    'MAY',
    'JUN',
    'JUL',
    'AGO',
    'SEP',
    'OCT',
    'NOV',
    'DIC',
  ]
  const month = months[Number(m[1]) - 1] ?? m[1]
  return `${Number(m[2])} ${month}`
}
