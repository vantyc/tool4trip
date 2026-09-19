import type { ReactNode } from 'react'
import type { TripPanelCard, VisualStatus } from '../../application/tripPanel'
import { VISUAL_STATUS_LABEL } from '../../application/tripPanel'
import { formatClockEs } from '../../../shared/airportArrivalPolicy'

function formatWhen(iso?: string): string | undefined {
  if (!iso) return undefined
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/)
  if (m) return `${m[1]} ${m[2]}:${m[3]}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  return iso
}

function formatPrice(price?: number, currency?: string): string | undefined {
  if (price === undefined) return undefined
  if (currency) return `${price} ${currency}`
  return String(price)
}

export function StatusBadge({ status }: { status: VisualStatus }) {
  return (
    <span className={`tp-badge tp-badge-${status}`}>
      {VISUAL_STATUS_LABEL[status]}
    </span>
  )
}

function CardShell({
  card,
  children,
}: {
  card: TripPanelCard
  children?: ReactNode
}) {
  return (
    <article className={`tp-card tp-card-${card.kind} tp-card-${card.status}`}>
      <header className="tp-card-head">
        <h4 className="tp-card-title">{card.title}</h4>
        <StatusBadge status={card.status} />
      </header>
      {children}
    </article>
  )
}

function FieldList({
  rows,
}: {
  rows: Array<{ label: string; value: string; href?: string }>
}) {
  if (rows.length === 0) return null
  return (
    <dl className="tp-card-fields">
      {rows.map((r) => (
        <div key={r.label}>
          <dt>{r.label}</dt>
          <dd>
            {r.href ? (
              <a href={r.href} target="_blank" rel="noreferrer">
                {r.value}
              </a>
            ) : (
              r.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function FlightCard({ card }: { card: TripPanelCard }) {
  const when = formatWhen(card.startAt)
  const until = formatWhen(card.endAt)
  const price = formatPrice(card.price, card.currency)
  const rows: Array<{ label: string; value: string; href?: string }> = []
  if (when) {
    rows.push({
      label: 'Salida',
      value: until ? `${when} → ${until}` : when,
    })
  } else if (
    card.status === 'estimated' ||
    card.status === 'pending' ||
    card.status === 'alternative'
  ) {
    rows.push({ label: 'Horario', value: 'Pendiente de verificar' })
  }
  if (card.origin) rows.push({ label: 'Origen', value: card.origin })
  if (card.destination) rows.push({ label: 'Destino', value: card.destination })
  if (card.provider) rows.push({ label: 'Aerolínea', value: card.provider })
  if (price) rows.push({ label: 'Precio', value: price })
  if (card.sourceUrl) {
    rows.push({ label: 'Fuente', value: card.sourceUrl, href: card.sourceUrl })
  }
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })

  const arrival = card.airportArrival

  return (
    <CardShell card={card}>
      <FieldList rows={rows} />
      {arrival && (
        <div className="tp-flight-arrival">
          <p className="tp-flight-arrival-title">
            Arribo al aeropuerto ({arrival.airportLabel})
          </p>
          <p className="tp-flight-arrival-body">
            {arrival.scope === 'domestic' ? 'Nacional' : 'Internacional'}: estar
            en mostrador a más tardar{' '}
            <strong>{formatClockEs(arrival.deskAt)}</strong> (+
            {arrival.deskMinutes} min). Si ya documentaste en línea:{' '}
            <strong>{formatClockEs(arrival.onlineAt)}</strong> (+
            {arrival.onlineMinutes} min).
          </p>
        </div>
      )}
    </CardShell>
  )
}

export function LodgingCard({ card }: { card: TripPanelCard }) {
  const checkIn = formatWhen(card.startAt)
  const checkOut = formatWhen(card.endAt)
  const price = formatPrice(card.price, card.currency)
  const rows: Array<{ label: string; value: string; href?: string }> = []
  if (checkIn || checkOut) {
    rows.push({
      label: 'Estancia',
      value:
        checkIn && checkOut
          ? `${checkIn} → ${checkOut}`
          : (checkIn ?? checkOut)!,
    })
  }
  if (card.destination) rows.push({ label: 'Ciudad', value: card.destination })
  if (card.place) rows.push({ label: 'Dirección', value: card.place })
  if (card.provider) rows.push({ label: 'Establecimiento', value: card.provider })
  if (price) rows.push({ label: 'Precio', value: price })
  else if (card.status === 'estimated' || card.status === 'pending') {
    rows.push({ label: 'Precio', value: 'Pendiente de verificar' })
  }
  if (card.sourceUrl) {
    rows.push({ label: 'Fuente', value: card.sourceUrl, href: card.sourceUrl })
  }
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })
  return (
    <CardShell card={card}>
      <FieldList rows={rows} />
    </CardShell>
  )
}

export function GroundCard({ card }: { card: TripPanelCard }) {
  const when = formatWhen(card.startAt)
  const price = formatPrice(card.price, card.currency)
  const rows: Array<{ label: string; value: string; href?: string }> = []
  if (when) rows.push({ label: 'Inicio', value: when })
  if (card.origin) rows.push({ label: 'Desde', value: card.origin })
  if (card.destination) rows.push({ label: 'Hasta', value: card.destination })
  if (card.provider) rows.push({ label: 'Operador', value: card.provider })
  if (price) rows.push({ label: 'Precio', value: price })
  if (card.sourceUrl) {
    rows.push({ label: 'Fuente', value: card.sourceUrl, href: card.sourceUrl })
  }
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })
  return (
    <CardShell card={card}>
      <FieldList rows={rows} />
    </CardShell>
  )
}

export function ActivityCard({ card }: { card: TripPanelCard }) {
  const when = formatWhen(card.startAt)
  const until = formatWhen(card.endAt)
  const rows: Array<{ label: string; value: string; href?: string }> = []
  if (when) {
    rows.push({
      label: 'Cuándo',
      value: until ? `${when} → ${until}` : when,
    })
  }
  if (card.place || card.destination) {
    rows.push({
      label: 'Lugar',
      value: card.place || card.destination || '',
    })
  }
  if (card.sourceUrl) {
    rows.push({ label: 'Fuente', value: card.sourceUrl, href: card.sourceUrl })
  }
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })
  return (
    <CardShell card={card}>
      <FieldList rows={rows} />
    </CardShell>
  )
}

export function ChecklistCard({ card }: { card: TripPanelCard }) {
  const when = formatWhen(card.startAt)
  const rows: Array<{ label: string; value: string }> = []
  if (when) rows.push({ label: 'Vence', value: when })
  return (
    <CardShell card={card}>
      <FieldList rows={rows} />
    </CardShell>
  )
}

export function NoteCard({ card }: { card: TripPanelCard }) {
  const rows: Array<{ label: string; value: string }> = []
  if (card.body) rows.push({ label: 'Texto', value: card.body })
  return (
    <CardShell card={card}>
      <FieldList rows={rows} />
    </CardShell>
  )
}

export function SourceCard({ card }: { card: TripPanelCard }) {
  return (
    <CardShell card={card}>
      {card.sourceUrl && (
        <p className="tp-source-link">
          <a href={card.sourceUrl} target="_blank" rel="noreferrer">
            {card.sourceUrl}
          </a>
        </p>
      )}
    </CardShell>
  )
}

export function OptionCard({ card }: { card: TripPanelCard }) {
  switch (card.kind) {
    case 'flight_out':
    case 'flight_return':
      return <FlightCard card={card} />
    case 'lodging':
    case 'missing_slot':
      return card.kind === 'lodging' ? (
        <LodgingCard card={card} />
      ) : (
        <CardShell card={card} />
      )
    case 'ground':
      return <GroundCard card={card} />
    case 'activity':
      return <ActivityCard card={card} />
    case 'checklist':
      return <ChecklistCard card={card} />
    case 'note':
      return <NoteCard card={card} />
    case 'source':
      return <SourceCard card={card} />
    default:
      return <CardShell card={card} />
  }
}

export function CardSection({
  title,
  cards,
  emptyLabel,
}: {
  title: string
  cards: TripPanelCard[]
  emptyLabel?: string
}) {
  if (cards.length === 0) {
    if (!emptyLabel) return null
    return (
      <section className="tp-section">
        <h3 className="tp-section-title">{title}</h3>
        <p className="muted tp-empty">{emptyLabel}</p>
      </section>
    )
  }
  return (
    <section className="tp-section">
      <h3 className="tp-section-title">{title}</h3>
      <div className="tp-card-grid">
        {cards.map((c) => (
          <OptionCard key={c.id} card={c} />
        ))}
      </div>
    </section>
  )
}
