import { useState, type ReactNode } from 'react'
import type { BoardItem } from '../../application/tripBoard/buildTripBoard'
import { airportLabel, placeLabel } from '../../application/tripBoard/places'
import {
  daysBetween,
  formatDuration,
  formatWhenEs,
  localDate,
  minutesBetween,
} from '../../application/tripBoard/time'
import type { TripPanelCard } from '../../application/tripPanel'
import {
  ComponentActionControls,
  type ComponentActionControlsProps,
} from '../tripPanel/ComponentActionControls'
import { BookForm, ItemEditForm } from './BoardForms'
import {
  hostOf,
  ITEM_STATUS_LABEL,
  money,
  PAY_LABEL,
  payState,
  ROLE_LABEL,
  splitLinks,
  TYPE_LABEL,
} from './boardFormat'

export type GetActionProps = (card: TripPanelCard) => Omit<ComponentActionControlsProps, 'card'>

function agentCard(item: BoardItem): TripPanelCard | undefined {
  const o = item.option
  if (!o) return undefined
  const kind: TripPanelCard['kind'] =
    item.kind === 'flight'
      ? 'flight_out'
      : item.kind === 'lodging'
        ? 'lodging'
        : item.kind === 'ground'
          ? 'ground'
          : 'activity'
  return {
    id: o.externalId ?? o.id,
    externalId: o.externalId ?? o.id,
    kind,
    title: o.title,
    status: 'pending',
    optionType: o.type,
    entityKind: 'travelOption',
  }
}

type Row = { label: string; value: ReactNode }

function rowsFor(item: BoardItem): Row[] {
  const rows: Row[] = []
  const push = (label: string, value: ReactNode | undefined) => {
    if (value !== undefined && value !== null && value !== '') rows.push({ label, value })
  }
  if (item.kind === 'flight' || item.kind === 'ground') {
    if (item.kind === 'flight') {
      push('Vuelo', [item.flightNumber, item.provider].filter(Boolean).join(' · ') || undefined)
    } else {
      push('Proveedor', item.provider)
    }
    const where = (raw?: string) =>
      raw ? (item.kind === 'flight' ? airportLabel(raw) : placeLabel(raw)) : undefined
    push(
      'Sale',
      item.startAt || item.origin
        ? [formatWhenEs(item.startAt), where(item.origin)].filter(Boolean).join(' — ')
        : undefined,
    )
    const span = minutesBetween(item.startAt, item.endAt)
    if (span !== undefined && span > 48 * 60) {
      // One record for a whole round trip: endAt is the end of the return, not this arrival.
      push('Destino', where(item.destination))
      push('Termina', formatWhenEs(item.endAt) ? `${formatWhenEs(item.endAt)} (fin del viaje redondo)` : undefined)
    } else {
      push(
        'Llega',
        item.endAt || item.destination
          ? [formatWhenEs(item.endAt), where(item.destination)].filter(Boolean).join(' — ')
          : undefined,
      )
      push('Duración', formatDuration(span))
    }
    push('Equipaje', item.baggage)
  } else if (item.kind === 'lodging') {
    push('Hotel', item.provider)
    push(
      'Dirección',
      item.address ? (
        <a
          href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(item.address)}`}
          target="_blank"
          rel="noreferrer"
        >
          {item.address}
        </a>
      ) : undefined,
    )
    push('Teléfono', item.phone ? <a href={`tel:${item.phone}`}>{item.phone}</a> : undefined)
    push('Check-in', formatWhenEs(item.startAt))
    push('Check-out', formatWhenEs(item.endAt))
    const nights = daysBetween(localDate(item.startAt), localDate(item.endAt))
    push('Noches', nights !== undefined && nights > 0 ? String(nights) : undefined)
  } else {
    push('Cuándo', formatWhenEs(item.startAt))
    if (item.origin && item.destination) {
      push('Tramo', `${placeLabel(item.origin)} → ${placeLabel(item.destination)}`)
    } else {
      push('Dónde', item.address ?? item.destination)
    }
  }

  if (item.includedWith) {
    push('Precio', `Incluido en el boleto de ${item.includedWith} (ida y vuelta, se cuenta una vez)`)
  } else {
    push(
      'Precio',
      item.price !== undefined
        ? `${money(item.price, item.currency)}${item.includes?.length ? ` · boleto ida y vuelta, incluye ${item.includes.join(', ')}` : ''}`
        : 'Sin cotizar',
    )
  }
  if (item.checkedAt && item.price !== undefined && !item.includedWith) {
    push(
      'Consultado',
      `${formatWhenEs(item.checkedAt)}${item.status === 'booked' ? '' : ' · el precio puede haber cambiado'}`,
    )
  }
  push('Reserva', item.status === 'booked' ? `Reservado${item.confirmation ? ` · ${item.confirmation}` : ''}` : 'Sin reservar')
  if (!item.includedWith && (item.price !== undefined || item.status === 'booked')) {
    const state = payState(item)
    push(
      'Pagado',
      state === 'unpaid'
        ? 'Nada pagado'
        : `${money(item.paid, item.currency)}${state === 'partial' && item.price !== undefined ? ` de ${money(item.price, item.currency)}` : ''}`,
    )
  }
  push('Asiento', item.seat)
  push('Terminal', item.terminal)
  push('Puerta', item.gate)
  push('Siguiente paso', item.nextAction)
  return rows
}

export function ItemBlock({
  item,
  onChanged,
  getActionProps,
  extraActions,
  compact = false,
}: {
  item: BoardItem
  onChanged: () => void
  getActionProps?: GetActionProps
  extraActions?: ReactNode
  compact?: boolean
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'book'>('view')
  const card = agentCard(item)
  const pay = payState(item)
  const showPay = !item.includedWith && (item.price !== undefined || item.status === 'booked')
  const notes = item.notes ? splitLinks(item.notes) : undefined
  const links = [item.url, ...(notes?.urls ?? [])].filter(
    (u, i, all): u is string => Boolean(u) && all.indexOf(u) === i,
  )

  const done = () => {
    setMode('view')
    onChanged()
  }

  return (
    <article className={`tb-item tb-item-${item.status} tb-role-${item.role}`}>
      <header className="tb-item-head">
        <div>
          <p className="tb-item-type">
            {TYPE_LABEL[item.type] ?? item.type}
            {item.role !== 'chosen' && <span className="tb-item-role"> · {ROLE_LABEL[item.role]}</span>}
          </p>
          <h4>{item.title}</h4>
        </div>
        <span className="tb-pills">
          <span className={`tb-pill tb-pill-${item.status}`}>{ITEM_STATUS_LABEL[item.status]}</span>
          {showPay && (
            <span className={`tb-pill tb-pay-${pay}`}>{PAY_LABEL[pay]}</span>
          )}
        </span>
      </header>

      {mode === 'edit' && (
        <ItemEditForm item={item} onDone={done} onCancel={() => setMode('view')} />
      )}
      {mode === 'book' && (
        <BookForm item={item} onDone={done} onCancel={() => setMode('view')} />
      )}

      {mode === 'view' && (
        <>
          <dl className="tb-fields">
            {rowsFor(item)
              .filter((r) => !compact || ['Vuelo', 'Proveedor', 'Hotel', 'Sale', 'Llega', 'Destino', 'Precio', 'Check-in', 'Check-out'].includes(r.label))
              .map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
          </dl>
          {notes && notes.text.trim() && !compact && (
            <details className="tb-notes">
              <summary>Notas</summary>
              <p>{notes.text}</p>
            </details>
          )}
          <div className="tb-item-actions">
            {links.map((url, i) => (
              <a
                key={url}
                className="tb-btn-link"
                href={url}
                target="_blank"
                rel="noreferrer"
                title={url}
              >
                {i === 0 && url === item.url
                  ? item.status === 'booked'
                    ? 'Ver reserva'
                    : 'Ver oferta'
                  : 'Ver fuente'}
                {hostOf(url) ? <small> · {hostOf(url)}</small> : null}
              </a>
            ))}
            {extraActions}
            {(item.option || item.booking) && (
              <button type="button" className="tb-btn-quiet" data-write onClick={() => setMode('edit')}>
                Editar
              </button>
            )}
            {item.option && item.status !== 'booked' && (
              <button type="button" className="tb-btn-quiet" data-write onClick={() => setMode('book')}>
                Marcar reservado
              </button>
            )}
            {card && getActionProps && (
              <ComponentActionControls card={card} {...getActionProps(card)} />
            )}
          </div>
        </>
      )}
    </article>
  )
}
