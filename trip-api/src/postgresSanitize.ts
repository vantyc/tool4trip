/**
 * PostgreSQL text/jsonb cannot store U+0000 (NUL). Node's JSON.stringify
 * encodes it as "\\u0000", which Postgres rejects with 22P05.
 *
 * Broader policy: strip non-textual C0 controls that commonly arrive as
 * LLM/tool corruption (e.g. U+0015 / U+0018 standing in for punctuation).
 * Legitimate whitespace (\t \n \r) is preserved. Valid Unicode is untouched.
 *
 * This module is the single persistence-boundary sanitizer for trip-api payloads.
 */

export type PostgresSanitizeRemoved = 'U+0000' | 'C0_CONTROL'

export type PostgresSanitizeEvent = {
  path: string
  removed: PostgresSanitizeRemoved
  count: number
}

export type PostgresSanitizeResult<T> = {
  value: T
  changed: boolean
  events: PostgresSanitizeEvent[]
}

const NUL = '\u0000'

/** C0 / DEL controls allowed in free-text fields. */
export function isAllowedControl(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d
}

/** True if code point is a disallowed control (NUL–US except tab/LF/CR, or DEL). */
export function isDisallowedControl(codePoint: number): boolean {
  if (codePoint === 0x7f) return true
  if (codePoint <= 0x1f) return !isAllowedControl(codePoint)
  return false
}

/** True if string contains any disallowed C0/DEL control (including U+0000). */
export function containsDisallowedControl(s: string): boolean {
  for (const ch of s) {
    if (isDisallowedControl(ch.codePointAt(0)!)) return true
  }
  return false
}

/** True if a string contains a real U+0000 (not the literal "\\u0000" text). */
export function containsNul(s: string): boolean {
  return s.includes(NUL)
}

export type StripControlsResult = {
  value: string
  nulCount: number
  c0Count: number
}

/**
 * Remove disallowed controls. Preserves \t \n \r and all non-control Unicode.
 * Does NOT attempt to guess original punctuation for U+0015/U+0018/etc.
 */
export function stripDisallowedControls(s: string): StripControlsResult {
  let nulCount = 0
  let c0Count = 0
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp === 0) {
      nulCount += 1
      continue
    }
    if (isDisallowedControl(cp)) {
      c0Count += 1
      continue
    }
    out += ch
  }
  return { value: out, nulCount, c0Count }
}

function sanitizeString(
  s: string,
  path: string,
  events: PostgresSanitizeEvent[],
): string {
  if (!containsDisallowedControl(s)) return s
  const { value, nulCount, c0Count } = stripDisallowedControls(s)
  if (nulCount > 0) {
    events.push({ path, removed: 'U+0000', count: nulCount })
  }
  if (c0Count > 0) {
    events.push({ path, removed: 'C0_CONTROL', count: c0Count })
  }
  return value
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Recursively strip characters unsafe/undesired for PostgreSQL text/jsonb:
 * U+0000 and other C0 controls except tab/LF/CR, plus DEL (U+007F).
 * Preserves valid Unicode (accents, emoji, CJK, dashes, middle dots, etc.).
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
