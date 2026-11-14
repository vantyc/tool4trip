/**
 * Deterministic ISO-8601-with-offset normalization for AgentProposal drafts.
 * Never invents a clock time. May attach a zone offset when wall-clock + IANA zone are known.
 */

export type DatetimeNormalizeWarning = string

export type NormalizeDatetimesResult = {
  value: unknown
  warnings: DatetimeNormalizeWarning[]
}

const HAS_OFFSET_RE = /([Zz]|[+-]\d{2}:\d{2})$/
const WALL_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/

/** Well-known IANA zones we can apply without guessing. */
const KNOWN_ZONES = new Set([
  'America/Mexico_City',
  'America/Cancun',
  'America/Tijuana',
  'America/Hermosillo',
  'America/Mazatlan',
  'America/Monterrey',
  'America/Merida',
  'America/Chihuahua',
  'America/Ojinaga',
  'America/Bahia_Banderas',
  'UTC',
  'Etc/UTC',
])

const PLACE_ZONE_HINTS: Array<{ re: RegExp; zone: string }> = [
  { re: /\b(mex|cdmx|aicm|ciudad de m[eé]xico|mexico city)\b/i, zone: 'America/Mexico_City' },
  { re: /\b(gdl|guadalajara|jalisco|san miguel el alto|los altos)\b/i, zone: 'America/Mexico_City' },
  { re: /\b(cun|canc[uú]n)\b/i, zone: 'America/Cancun' },
  { re: /\b(tij|tijuana)\b/i, zone: 'America/Tijuana' },
]

export function isIsoWithOffset(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return false
  return HAS_OFFSET_RE.test(v)
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

/** Offset string (±HH:MM or Z) that `timeZone` uses at UTC instant `utcMs`. */
export function offsetLabelAt(utcMs: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcMs))
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value
    if (!tz) return null
    if (/GMT|UTC/i.test(tz) && !/[+-]/.test(tz)) return 'Z'
    const m = tz.match(/([+-])(\d{1,2})(?::?(\d{2}))?/)
    if (!m) return null
    const sign = m[1]
    const hh = pad(Number(m[2]))
    const mm = pad(Number(m[3] ?? '0'))
    if (sign === '+' && hh === '00' && mm === '00') return 'Z'
    return `${sign}${hh}:${mm}`
  } catch {
    return null
  }
}

/**
 * Convert a wall-clock local datetime (no offset) + IANA zone → ISO with offset.
 * Does not invent hours: requires hour+minute in the input.
 */
export function applyZoneToWallClock(
  wallIso: string,
  timeZone: string,
): string | null {
  if (!KNOWN_ZONES.has(timeZone) && timeZone !== 'America/Mexico_City') {
    // Still try Intl for any IANA string that looks valid
    if (!/^[A-Za-z]+\/[A-Za-z_]+/.test(timeZone) && timeZone !== 'UTC') {
      return null
    }
  }
  const m = wallIso.trim().match(WALL_RE)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (m[4] === undefined || m[5] === undefined) {
    // Date-only — would require inventing a time
    return null
  }
  const h = Number(m[4])
  const mi = Number(m[5])
  const s = Number(m[6] ?? '0')

  // Iterate: interpret components as UTC, read zone offset, adjust
  let utcMs = Date.UTC(y, mo - 1, d, h, mi, s)
  for (let i = 0; i < 3; i++) {
    const label = offsetLabelAt(utcMs, timeZone)
    if (!label) return null
    const offMin =
      label === 'Z' || label === 'z'
        ? 0
        : (label[0] === '-' ? -1 : 1) *
          (Number(label.slice(1, 3)) * 60 + Number(label.slice(4, 6)))
    // Desired: wall = utc + offMin → utc = wall_as_utc - offMin
    const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s)
    const next = wallAsUtc - offMin * 60_000
    if (next === utcMs) {
      return `${pad(y)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${label === 'z' ? 'Z' : label}`
    }
    utcMs = next
  }
  const label = offsetLabelAt(utcMs, timeZone)
  if (!label) return null
  return `${pad(y)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${label === 'z' ? 'Z' : label}`
}

export function inferZoneFromText(
  ...texts: Array<string | undefined | null>
): string | null {
  const blob = texts.filter(Boolean).join(' ')
  if (!blob.trim()) return null
  for (const { re, zone } of PLACE_ZONE_HINTS) {
    if (re.test(blob)) return zone
  }
  return null
}

export type NormalizeFieldCtx = {
  tripTimezone?: string
  placeHints?: string[]
  path: string
}

/**
 * Normalize one datetime string.
 * - keep if already Z/offset
 * - apply zone if wall clock has time + known zone
 * - else drop (return undefined) — caller warns
 */
export function normalizeDatetimeField(
  raw: unknown,
  ctx: NormalizeFieldCtx,
): { value?: string; dropped: boolean; warning?: string } {
  if (raw === undefined || raw === null) return { dropped: false }
  if (typeof raw !== 'string') {
    return {
      dropped: true,
      warning: `${ctx.path}: datetime no textual — omitido.`,
    }
  }
  const s = raw.trim()
  if (!s) return { dropped: false }

  if (isIsoWithOffset(s)) {
    // Normalize trailing z → Z; leave otherwise untouched
    return { value: s.endsWith('z') ? `${s.slice(0, -1)}Z` : s, dropped: false }
  }

  const zone =
    (ctx.tripTimezone && ctx.tripTimezone.trim()) ||
    inferZoneFromText(...(ctx.placeHints ?? [])) ||
    null

  if (zone) {
    const applied = applyZoneToWallClock(s, zone)
    if (applied) {
      return {
        value: applied,
        dropped: false,
        warning: `${ctx.path}: se aplicó zona ${zone} a datetime sin offset.`,
      }
    }
  }

  return {
    dropped: true,
    warning: `${ctx.path}: datetime sin offset/zona determinable ("${s.slice(0, 40)}") — omitido; confirmar manualmente.`,
  }
}

type Rec = Record<string, unknown>

function asRec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}
}

function pushChecklist(
  pkg: Rec,
  id: string,
  label: string,
): void {
  const list = Array.isArray(pkg.checklistItems) ? [...pkg.checklistItems] : []
  if (list.some((c) => asRec(c).externalId === id)) {
    pkg.checklistItems = list
    return
  }
  list.push({ externalId: id, label, sortOrder: list.length })
  pkg.checklistItems = list
}

/**
 * Walk AgentProposal draft (pre- or post-hydrate shape) and normalize datetimes.
 * Soft-drops optional datetime fields that cannot be fixed.
 */
export function normalizeProposalDatetimes(
  draftIn: unknown,
  opts?: { tripTimezoneFallback?: string },
): NormalizeDatetimesResult {
  const warnings: string[] = []
  const draft = structuredClone(draftIn) as Rec
  const pkg = asRec(draft.package)
  draft.package = pkg
  const trip = asRec(pkg.trip)
  const tripTz =
    (typeof trip.timezone === 'string' && trip.timezone) ||
    opts?.tripTimezoneFallback ||
    'America/Mexico_City'

  const fixObj = (
    obj: Rec,
    fields: string[],
    pathPrefix: string,
    placeHints: string[],
  ) => {
    for (const f of fields) {
      if (!(f in obj)) continue
      const r = normalizeDatetimeField(obj[f], {
        tripTimezone: tripTz,
        placeHints,
        path: `${pathPrefix}.${f}`,
      })
      if (r.warning) warnings.push(r.warning)
      if (r.dropped) {
        delete obj[f]
        const id = `chk-dt-${pathPrefix.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 60)}-${f}`
        pushChecklist(
          pkg,
          id,
          `Confirmar ${f} de ${pathPrefix} (datetime inválido u omitido)`,
        )
      } else if (r.value !== undefined) {
        obj[f] = r.value
      }
    }
  }

  // package.generatedAt
  if ('generatedAt' in pkg) {
    const r = normalizeDatetimeField(pkg.generatedAt, {
      tripTimezone: 'UTC',
      path: 'package.generatedAt',
    })
    if (r.warning) warnings.push(r.warning)
    if (r.dropped) delete pkg.generatedAt
    else if (r.value) pkg.generatedAt = r.value
  }

  const options = Array.isArray(pkg.travelOptions) ? pkg.travelOptions : []
  pkg.travelOptions = options.map((raw, i) => {
    const o = { ...asRec(raw) }
    fixObj(
      o,
      ['startAt', 'endAt', 'checkedAt'],
      `package.travelOptions[${i}]`,
      [
        String(o.origin ?? ''),
        String(o.destination ?? ''),
        String(o.address ?? ''),
        String(o.title ?? ''),
        String(trip.destination ?? ''),
      ],
    )
    return o
  })

  const itinerary = Array.isArray(pkg.itineraryItems) ? pkg.itineraryItems : []
  pkg.itineraryItems = itinerary.map((raw, i) => {
    const o = { ...asRec(raw) }
    fixObj(
      o,
      ['startAt', 'endAt'],
      `package.itineraryItems[${i}]`,
      [String(o.place ?? ''), String(o.title ?? ''), String(trip.destination ?? '')],
    )
    return o
  })

  const checklist = Array.isArray(pkg.checklistItems) ? pkg.checklistItems : []
  pkg.checklistItems = checklist.map((raw, i) => {
    const o = { ...asRec(raw) }
    fixObj(o, ['dueAt'], `package.checklistItems[${i}]`, [
      String(trip.destination ?? ''),
    ])
    return o
  })

  // Top-level createdAt (if model wrongly emitted it) — keep only if valid offset
  if ('createdAt' in draft && typeof draft.createdAt === 'string') {
    const r = normalizeDatetimeField(draft.createdAt, {
      tripTimezone: 'UTC',
      path: 'createdAt',
    })
    if (r.dropped) delete draft.createdAt
    else if (r.value) draft.createdAt = r.value
  }

  return { value: draft, warnings }
}

/**
 * After Zod failure: soft-drop only the failing optional datetime fields / bad array
 * elements referenced by issues, then return a patched draft.
 */
export function softDropInvalidDatetimePaths(
  draftIn: unknown,
  zodIssues: Array<{ path: PropertyKey[]; message?: string }>,
): { value: unknown; warnings: string[] } {
  const warnings: string[] = []
  const draft = structuredClone(draftIn) as Rec

  const datetimeLeaves = new Set([
    'startAt',
    'endAt',
    'checkedAt',
    'dueAt',
    'generatedAt',
  ])

  // Field-level drops first
  for (const issue of zodIssues) {
    const path = issue.path.map(String)
    if (path.length < 2 || path[0] !== 'package') continue
    const leaf = path[path.length - 1]!
    if (!datetimeLeaves.has(leaf)) continue
    let cur: unknown = draft
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!
      if (cur == null) break
      if (Array.isArray(cur)) cur = cur[Number(key)]
      else if (typeof cur === 'object') cur = (cur as Rec)[key]
      else break
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      delete (cur as Rec)[leaf]
      warnings.push(
        `Se omitió ${path.join('.')} por fallar validación ISO 8601 con offset.`,
      )
    }
  }

  // Element-level drops (non-datetime required failures) — highest index first
  const elementDrops: Array<{ arrName: string; idx: number }> = []
  for (const issue of zodIssues) {
    const path = issue.path.map(String)
    if (path.length < 3 || path[0] !== 'package') continue
    const leaf = path[path.length - 1]!
    if (datetimeLeaves.has(leaf)) continue
    if (
      path[1] === 'travelOptions' ||
      path[1] === 'itineraryItems' ||
      path[1] === 'checklistItems' ||
      path[1] === 'notes'
    ) {
      const idx = Number(path[2])
      if (Number.isInteger(idx) && idx >= 0) {
        elementDrops.push({ arrName: path[1], idx })
      }
    }
  }
  elementDrops.sort((a, b) => b.idx - a.idx)
  const seen = new Set<string>()
  for (const { arrName, idx } of elementDrops) {
    const key = `${arrName}:${idx}`
    if (seen.has(key)) continue
    seen.add(key)
    const pkg = asRec(draft.package)
    const arr = Array.isArray(pkg[arrName])
      ? [...(pkg[arrName] as unknown[])]
      : []
    if (idx < arr.length) {
      const removed = asRec(arr[idx])
      arr.splice(idx, 1)
      pkg[arrName] = arr
      draft.package = pkg
      warnings.push(
        `Se omitió ${arrName}[${idx}] (${String(removed.title || removed.label || removed.externalId || 'elemento')}) por dato inválido.`,
      )
    }
  }

  return { value: draft, warnings }
}

/** Friendly user-facing message — never dump raw Zod JSON. */
export function formatProposalValidationUserError(raw: string): string {
  if (/Datetime debe ser ISO|ISO 8601 con offset/i.test(raw)) {
    return 'No se pudo armar la propuesta: algunas fechas u horas vinieron mal formadas. Puedes pulsar Reintentar sin perder el texto.'
  }
  if (/ungrounded|evidence|sourceUrl/i.test(raw)) {
    return 'No se pudo verificar alguna afirmación con las fuentes disponibles. Puedes pulsar Reintentar.'
  }
  if (/JSON inválido|invalid_proposal|Zod|safeParse/i.test(raw)) {
    return 'No se pudo armar la propuesta (formato incompleto). Puedes pulsar Reintentar sin perder el texto.'
  }
  // Cap length
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (oneLine.length > 180) return `${oneLine.slice(0, 177)}…`
  return oneLine || 'No se pudo armar la propuesta. Puedes pulsar Reintentar.'
}
