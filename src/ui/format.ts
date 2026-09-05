/** Display helpers — keep UI formatting out of domain. */

const importanceMark: Record<string, string> = {
  crucial: '★',
  recommended: '●',
  optional: '○',
}

export function importanceLabel(importance: string): string {
  return `${importanceMark[importance] ?? '·'} ${importance}`
}

/** Show local wall-clock from ISO-with-offset without converting to browser TZ. */
export function formatLocalFromIso(iso?: string): string {
  if (!iso) return '—'
  // Expect ...T HH:MM:SS±HH:MM or Z
  const m = iso.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(?:\.\d+)?([+-]\d{2}:\d{2}|Z)?/,
  )
  if (!m) return iso
  const [, date, hm, offset] = m
  return `${date} ${hm}${offset && offset !== 'Z' ? ` (${offset})` : offset === 'Z' ? ' (UTC)' : ''}`
}

export function formatBookingStatus(status: string): string {
  const map: Record<string, string> = {
    investigating: 'Investigando',
    selected: 'Seleccionado',
    ready_to_book: 'Listo para reservar',
    booked: 'Reservado',
    confirmed: 'Confirmado',
    cancelled: 'Cancelado',
  }
  return map[status] ?? status
}

export function groupByDate<T extends { startAt?: string }>(
  items: T[],
): { date: string; items: T[] }[] {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const date = item.startAt?.slice(0, 10) ?? 'sin-fecha'
    const list = map.get(date) ?? []
    list.push(item)
    map.set(date, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, grouped]) => ({ date, items: grouped }))
}
