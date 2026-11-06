import type { ReactNode } from 'react'
import type { TripPanelCard, VisualStatus } from '../../application/tripPanel'
import { VISUAL_STATUS_LABEL } from '../../application/tripPanel'
import { formatClockEs } from '../../../shared/airportArrivalPolicy'
import {
  ComponentActionControls,
  type ComponentActionControlsProps,
} from './ComponentActionControls'

function formatWhen(iso?: string): string | undefined {
  if (!iso) return undefined
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/)
  if (m) return `${m[1]} ${m[2]}:${m[3]}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  return iso
}

function quoteExtraRows(
  card: TripPanelCard,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  const consulted = formatWhen(card.checkedAt)
  if (consulted) rows.push({ label: 'Consulta', value: consulted })
  if (card.nextAction) {
    rows.push({ label: 'Siguiente acción', value: card.nextAction })
  }
  for (const prior of card.priceHistory ?? []) {
    const when = formatWhen(prior.checkedAt) ?? prior.checkedAt
    rows.push({
      label: `Precio anterior ${when}`,
      value: formatPrice(prior.amount, prior.currency) ?? String(prior.amount),
    })
  }
  return rows
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
  actionSlot,
}: {
  card: TripPanelCard
  children?: ReactNode
  actionSlot?: ReactNode
}) {
  return (
    <article className={`tp-card tp-card-${card.kind} tp-card-${card.status}`}>
      <header className="tp-card-head">
        <h4 className="tp-card-title">{card.title}</h4>
        <div className="tp-card-head-right">
          <StatusBadge status={card.status} />
          {actionSlot}
        </div>
      </header>
      {children}
    </article>
  )
}

/** Long source URLs read as a short "Ver fuente · host" link. */
function sourceLabel(url: string): string {
  try {
    return `Ver fuente · ${new URL(url).hostname.replace(/^www\./, '')}`
  } catch {
    return 'Ver fuente'
  }
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

export function FlightCard({
  card,
  actionProps,
}: {
  card: TripPanelCard
  actionProps?: Omit<ComponentActionControlsProps, 'card'>
}) {
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
    card.status === 'alternative' ||
    card.status === 'user_supplied'
  ) {
    if (card.status !== 'user_supplied') {
      rows.push({ label: 'Horario', value: 'Pendiente de verificar' })
    }
  }
  if (card.sourceType === 'flight_schedule') {
    rows.push({
      label: 'Tipo',
      value:
        'HORARIO PUBLICADO — verifica disponibilidad y reserva con la aerolínea',
    })
  }
  if (card.origin) rows.push({ label: 'Origen', value: card.origin })
  if (card.destination) rows.push({ label: 'Destino', value: card.destination })
  if (card.provider) rows.push({ label: 'Aerolínea', value: card.provider })
  if (price) rows.push({ label: 'Precio', value: price })
  if (card.sourceUrl) {
    rows.push({ label: 'Fuente', value: sourceLabel(card.sourceUrl), href: card.sourceUrl })
  }
  rows.push(...quoteExtraRows(card))
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })

  const arrival = card.airportArrival
  const actionSlot = actionProps ? (
    <ComponentActionControls card={card} {...actionProps} />
  ) : undefined

  return (
    <CardShell card={card} actionSlot={actionSlot}>
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

export function LodgingCard({
  card,
  actionProps,
}: {
  card: TripPanelCard
  actionProps?: Omit<ComponentActionControlsProps, 'card'>
}) {
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
    rows.push({ label: 'Fuente', value: sourceLabel(card.sourceUrl), href: card.sourceUrl })
  }
  rows.push(...quoteExtraRows(card))
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })
  return (
    <CardShell
      card={card}
      actionSlot={
        actionProps ? (
          <ComponentActionControls card={card} {...actionProps} />
        ) : undefined
      }
    >
      <FieldList rows={rows} />
    </CardShell>
  )
}

export function GroundCard({
  card,
  actionProps,
}: {
  card: TripPanelCard
  actionProps?: Omit<ComponentActionControlsProps, 'card'>
}) {
  const when = formatWhen(card.startAt)
  const price = formatPrice(card.price, card.currency)
  const rows: Array<{ label: string; value: string; href?: string }> = []
  if (when) rows.push({ label: 'Inicio', value: when })
  if (card.origin) rows.push({ label: 'Desde', value: card.origin })
  if (card.destination) rows.push({ label: 'Hasta', value: card.destination })
  if (card.provider) rows.push({ label: 'Operador', value: card.provider })
  if (price) rows.push({ label: 'Precio', value: price })
  if (card.sourceUrl) {
    rows.push({ label: 'Fuente', value: sourceLabel(card.sourceUrl), href: card.sourceUrl })
  }
  rows.push(...quoteExtraRows(card))
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })
  return (
    <CardShell
      card={card}
      actionSlot={
        actionProps ? (
          <ComponentActionControls card={card} {...actionProps} />
        ) : undefined
      }
    >
      <FieldList rows={rows} />
    </CardShell>
  )
}

export function ActivityCard({
  card,
  actionProps,
}: {
  card: TripPanelCard
  actionProps?: Omit<ComponentActionControlsProps, 'card'>
}) {
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
    rows.push({ label: 'Fuente', value: sourceLabel(card.sourceUrl), href: card.sourceUrl })
  }
  rows.push(...quoteExtraRows(card))
  if (card.notes) rows.push({ label: 'Notas', value: card.notes })
  return (
    <CardShell
      card={card}
      actionSlot={
        actionProps ? (
          <ComponentActionControls card={card} {...actionProps} />
        ) : undefined
      }
    >
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
          <a href={card.sourceUrl} target="_blank" rel="noreferrer" title={card.sourceUrl}>
            {sourceLabel(card.sourceUrl)}
          </a>
        </p>
      )}
    </CardShell>
  )
}

export function OptionCard({
  card,
  actionProps,
}: {
  card: TripPanelCard
  actionProps?: Omit<ComponentActionControlsProps, 'card'>
}) {
  switch (card.kind) {
    case 'flight_out':
    case 'flight_return':
      return <FlightCard card={card} actionProps={actionProps} />
    case 'lodging':
      return <LodgingCard card={card} actionProps={actionProps} />
    case 'missing_slot':
      return <CardShell card={card} />
    case 'ground':
      return <GroundCard card={card} actionProps={actionProps} />
    case 'activity':
      return <ActivityCard card={card} actionProps={actionProps} />
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
  getActionProps,
}: {
  title: string
  cards: TripPanelCard[]
  emptyLabel?: string
  getActionProps?: (
    card: TripPanelCard,
  ) => Omit<ComponentActionControlsProps, 'card'> | undefined
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
          <OptionCard
            key={c.id}
            card={c}
            actionProps={getActionProps?.(c)}
          />
        ))}
      </div>
    </section>
  )
}
