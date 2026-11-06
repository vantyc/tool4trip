/**
 * Wall-clock helpers for ISO strings that carry their own offset
 * (2026-11-15T21:10:00+08:00). Local date and time come from the string
 * itself, so each event shows the time of the place where it happens.
 */

export function instantMs(iso?: string): number | undefined {
  if (!iso) return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : undefined
}

export function localDate(iso?: string): string | undefined {
  return iso?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
}

export function localClock(iso?: string): string | undefined {
  return iso?.match(/T(\d{2}:\d{2})/)?.[1]
}

export function isoOffset(iso?: string): string | undefined {
  const m = iso?.match(/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/)
  if (!m) return undefined
  return m[1] === 'Z' ? '+00:00' : m[1]
}

export function minutesBetween(a?: string, b?: string): number | undefined {
  const x = instantMs(a)
  const y = instantMs(b)
  if (x === undefined || y === undefined) return undefined
  return Math.round((y - x) / 60000)
}

/** Calendar days between two YYYY-MM-DD dates (b − a). */
export function daysBetween(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined
  const x = Date.parse(`${a}T00:00:00Z`)
  const y = Date.parse(`${b}T00:00:00Z`)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return Math.round((y - x) / 86400000)
}

export function formatDuration(minutes?: number): string | undefined {
  if (minutes === undefined) return undefined
  const sign = minutes < 0 ? '−' : ''
  const abs = Math.abs(minutes)
  const h = Math.floor(abs / 60)
  const m = abs % 60
  if (h === 0) return `${sign}${m} min`
  if (h >= 48 && m === 0) return `${sign}${Math.round(h / 24)} días`
  return `${sign}${h} h${m ? ` ${String(m).padStart(2, '0')} min` : ''}`
}

const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const MON = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
]

/** "sáb 14 nov" from YYYY-MM-DD (or the date part of an ISO string). */
export function formatDayEs(dateOrIso?: string, withWeekday = true): string | undefined {
  const date = localDate(dateOrIso)
  if (!date) return undefined
  const d = new Date(`${date}T12:00:00Z`)
  const day = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`
  return withWeekday ? `${DOW[d.getUTCDay()]} ${day}` : day
}

/** "sáb 14 nov · 05:45" in the event's own local time. */
export function formatWhenEs(iso?: string): string | undefined {
  const day = formatDayEs(iso)
  if (!day) return undefined
  const clock = localClock(iso)
  return clock ? `${day} · ${clock}` : day
}

/** UTC offset ("+08:00") of an IANA zone at a given wall-clock time. */
export function offsetForZone(tz: string, wall: string): string | undefined {
  const m = wall.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!m) return undefined
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    })
  } catch {
    return undefined
  }
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)
  const offsetAt = (ms: number) => {
    const name =
      fmt.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')
        ?.value ?? 'GMT'
    const o = name.match(/GMT([+-])(\d{2}):?(\d{2})?/)
    if (!o) return 0
    const mins = +o[2]! * 60 + +(o[3] ?? 0)
    return o[1] === '-' ? -mins : mins
  }
  const first = offsetAt(asUtc)
  const minutes = offsetAt(asUtc - first * 60000)
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/**
 * ISO with offset from a datetime-local value. The place zone wins (DST-safe);
 * otherwise the offset the value already had.
 */
export function wallToIso(
  wall: string,
  opts: { tz?: string; fallbackOffset?: string },
): string | undefined {
  const m = wall.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  if (!m) return undefined
  const offset =
    (opts.tz ? offsetForZone(opts.tz, wall) : undefined) ?? opts.fallbackOffset
  if (!offset) return undefined
  return `${m[1]}T${m[2]}:00${offset}`
}

/** datetime-local value (YYYY-MM-DDTHH:mm) of an ISO string's wall clock. */
export function isoToWall(iso?: string): string {
  return iso?.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)?.[1] ?? ''
}
