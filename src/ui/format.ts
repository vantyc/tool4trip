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

export function formatTravelOptionStatus(status: string): string {
  const map: Record<string, string> = {
    researched: 'Investigada',
    shortlisted: 'Shortlist',
    selected: 'Seleccionada',
    booked: 'Convertida a reserva',
    rejected: 'Rechazada',
  }
  return map[status] ?? status
}

export function formatVerificationStatus(status?: string): string {
  const map: Record<string, string> = {
    verified: 'Verificada',
    estimated: 'Estimada',
    unverified: 'Sin verificar',
  }
  return status ? (map[status] ?? status) : '—'
}

export function formatTravelOptionType(type: string): string {
  const map: Record<string, string> = {
    flight: 'Vuelo',
    lodging: 'Hospedaje',
    bus: 'Autobús',
    train: 'Tren',
    transfer: 'Traslado',
    car_rental: 'Renta de auto',
    restaurant: 'Restaurante',
    activity: 'Actividad',
    event: 'Evento',
    other: 'Otro',
  }
  return map[type] ?? type
}

export function formatPriceObserved(
  price?: number,
  currency?: string,
): string {
  if (price === undefined) return '—'
  const amount = Number.isInteger(price) ? String(price) : price.toFixed(2)
  return currency ? `${amount} ${currency}` : amount
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
