/**
 * PostgreSQL text/jsonb cannot store U+0000 (NUL).
 * Node's JSON.stringify encodes it as "\\u0000", which Postgres then rejects
 * with 22P05 when casting to jsonb.
 *
 * This module is the single persistence-boundary sanitizer for trip-api payloads.
 */

export type PostgresSanitizeEvent = {
  path: string
  removed: 'U+0000'
  count: number
}

export type PostgresSanitizeResult<T> = {
  value: T
  changed: boolean
  events: PostgresSanitizeEvent[]
}

const NUL = '\u0000'

function sanitizeString(
  s: string,
  path: string,
  events: PostgresSanitizeEvent[],
): string {
  if (!s.includes(NUL)) return s
  let count = 0
  let out = ''
  for (const ch of s) {
    if (ch === NUL) {
      count += 1
      continue
    }
    out += ch
  }
  if (count > 0) {
    events.push({ path, removed: 'U+0000', count })
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Recursively strip characters PostgreSQL text/jsonb cannot store (U+0000).
 * Preserves valid Unicode (accents, emoji, CJK, etc.).
 * Does NOT interpret the four-char sequence "\\u0000" as a NUL — that remains literal text.
 */
export function sanitizeForPostgres<T>(
  value: T,
  path = '$',
): PostgresSanitizeResult<T> {
  const events: PostgresSanitizeEvent[] = []

  const walk = (v: unknown, p: string): unknown => {
    if (v === null || v === undefined) return v
    const t = typeof v
    if (t === 'string') return sanitizeString(v as string, p, events)
    if (t === 'number' || t === 'boolean' || t === 'bigint') return v
    if (Array.isArray(v)) {
      return v.map((item, i) => walk(item, `${p}[${i}]`))
    }
    if (v instanceof Date) return v
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {}
      for (const [k, child] of Object.entries(v)) {
        out[k] = walk(child, `${p}.${k}`)
      }
      return out
    }
    // Buffers, class instances, functions: leave untouched (not expected in payloads)
    return v
  }

  const next = walk(value, path) as T
  return {
    value: next,
    changed: events.length > 0,
    events,
  }
}

export type SanitizeLogContext = {
  collection?: string
  entityId?: string
  externalId?: string
  tripId?: string
}

/** Emit safe structured warnings when sanitization removes characters. */
export function logPostgresSanitize(
  ctx: SanitizeLogContext,
  events: PostgresSanitizeEvent[],
): void {
  if (!events.length) return
  for (const e of events) {
    console.warn(
      'postgres_sanitize',
      JSON.stringify({
        collection: ctx.collection ?? null,
        entityId: ctx.entityId ?? null,
        externalId: ctx.externalId ?? null,
        tripId: ctx.tripId ?? null,
        path: e.path,
        removed: e.removed,
        count: e.count,
      }),
    )
  }
}

/**
 * Sanitize + JSON.stringify for jsonb bind parameters.
 * Returns the JSON text safe for PostgreSQL.
 */
export function stringifyPayloadForPostgres(
  payload: unknown,
  ctx: SanitizeLogContext,
): string {
  const { value, events } = sanitizeForPostgres(payload, '$')
  logPostgresSanitize(ctx, events)
  return JSON.stringify(value)
}

/** True if a string contains a real U+0000 (not the literal "\\u0000" text). */
export function containsNul(s: string): boolean {
  return s.includes(NUL)
}
