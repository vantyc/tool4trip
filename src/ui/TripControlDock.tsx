import { PrintButton } from './PrintButton'
import type { TripControlSheet } from '../../shared/quoteLedger'

const MONTHS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
]

function formatWhen(iso?: string): string {
  if (!iso) return '—'
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/)
  if (!match) return iso
  const day = Number(match[3])
  const month = MONTHS[Number(match[2]) - 1] ?? match[2]
  const clock = match[4] ? `, ${match[4]}:${match[5]}` : ''
  return `${day} ${month} ${match[1]}${clock}`
}

function formatMoney(amount: number, currency?: string): string {
  const formatted = new Intl.NumberFormat('es-MX', {
    maximumFractionDigits: 0,
  }).format(amount)
  return currency ? `${formatted} ${currency}` : formatted
}

export function TripControlDock({
  title,
  sheet,
}: {
  title: string
  sheet: TripControlSheet
}) {
  const hotelValue =
    sheet.hotels !== undefined
      ? formatMoney(sheet.hotels, sheet.currency)
      : sheet.hotelsUnquoted
        ? 'Sin cotizar'
        : '—'

  return (
    <section className="trip-control" aria-label="Ficha de control">
      <div className="trip-control-bar">
        <p className="trip-control-label">Ficha de control</p>
        <PrintButton subject={title} scopeSelector=".trip-layout" />
      </div>
      <dl className="trip-ficha">
        <div>
          <dt>Salida</dt>
          <dd>{formatWhen(sheet.departure)}</dd>
        </div>
        <div>
          <dt>Regreso</dt>
          <dd>{formatWhen(sheet.returnAt)}</dd>
        </div>
        <div>
          <dt>Subtotal cotizado</dt>
          <dd>{formatMoney(sheet.total, sheet.currency)}</dd>
        </div>
        <div>
          <dt>Vuelos cotizados</dt>
          <dd>
            {sheet.flights !== undefined
              ? formatMoney(sheet.flights, sheet.currency)
              : 'Sin cotizar'}
          </dd>
        </div>
        <div>
          <dt>Hoteles cotizados</dt>
          <dd>{hotelValue}</dd>
        </div>
      </dl>
    </section>
  )
}
