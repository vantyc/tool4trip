import type {
  BoardStatus,
  BoardStop,
  LegMode,
} from '../../application/tripBoard/buildTripBoard'

/** Material icon paths (Apache 2.0). The plane points north. */
export const GLYPH_PATH = {
  plane:
    'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z',
  car:
    'M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z',
  dots:
    'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
} as const

export type GlyphName = keyof typeof GLYPH_PATH

export function legGlyph(mode: LegMode): GlyphName {
  if (mode === 'flight' || mode === 'mixed') return 'plane'
  if (mode === 'ground') return 'car'
  return 'dots'
}

/** HTML string for Leaflet divIcons. `heading` is the screen angle of travel (0 = east). */
export function glyphHtml(name: GlyphName, heading: number, color: string): string {
  const rotate = name === 'plane' ? heading + 90 : 0
  return `<svg viewBox="0 0 24 24" width="20" height="20" style="transform:rotate(${rotate.toFixed(1)}deg)" aria-hidden="true"><path fill="${color}" d="${GLYPH_PATH[name]}"/></svg>`
}

const MONEY = new Map<string, Intl.NumberFormat>()

export function money(amount?: number, currency?: string): string | undefined {
  if (amount === undefined) return undefined
  const cur = currency || 'MXN'
  let fmt = MONEY.get(cur)
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat('es-MX', {
        style: 'currency',
        currency: cur,
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 0,
      })
    } catch {
      fmt = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 })
    }
    MONEY.set(cur, fmt)
  }
  return `${fmt.format(amount)} ${cur}`
}

export const STATUS_LABEL: Record<BoardStatus, string> = {
  booked: 'Reservado',
  quoted: 'Cotizado, sin reservar',
  pending: 'Pendiente',
}

export function kindLabel(stop: BoardStop): string {
  if (stop.kind === 'origin') return 'Salida'
  if (stop.kind === 'layover') return 'Escala'
  if (stop.kind === 'end') return stop.returnsToStart ? 'Regreso' : 'Llegada'
  return 'Estancia'
}

export const TYPE_LABEL: Record<string, string> = {
  flight: 'Vuelo',
  lodging: 'Hotel',
  bus: 'Autobús',
  train: 'Tren',
  transfer: 'Traslado',
  car_rental: 'Renta de auto',
  restaurant: 'Restaurante',
  activity: 'Actividad',
  event: 'Evento',
  ticket: 'Boleto',
  other: 'Otro',
}

export const ROLE_LABEL = {
  chosen: 'Elegido',
  alternative: 'Alternativa',
  pending: 'Por decidir',
} as const
