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
import { money, ROLE_LABEL, STATUS_LABEL, TYPE_LABEL } from './boardFormat'

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
    push(
      'Llega',
      item.endAt || item.destination
        ? [formatWhenEs(item.endAt), where(item.destination)].filter(Boolean).join(' — ')
        : undefined,
    )
    push('Duración', formatDuration(minutesBetween(item.startAt, item.endAt)))
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

  push(
    'Precio',
    item.includedWith
      ? `Incluido en el boleto de ${item.includedWith}${item.price !== undefined ? ` (${money(item.price, item.currency)})` : ''}`
      : (money(item.price, item.currency) ?? 'Por cotizar'),
  )
  if (item.paid !== undefined || item.status === 'booked') {
    push('Pagado', money(item.paid ?? 0, item.currency))
  }
  push('Confirmación', item.confirmation)
  push('Asiento', item.seat)
  push('Terminal', item.terminal)
  push('Puerta', item.gate)
  push('Consultado', item.checkedAt ? formatWhenEs(item.checkedAt) : undefined)
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
        <span className={`tb-pill tb-pill-${item.status}`}>{STATUS_LABEL[item.status]}</span>
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
              .filter((r) => !compact || ['Vuelo', 'Proveedor', 'Hotel', 'Sale', 'Llega', 'Precio', 'Check-in', 'Check-out'].includes(r.label))
              .map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
          </dl>
          {item.notes && !compact && (
            <details className="tb-notes">
              <summary>Notas</summary>
              <p>{item.notes}</p>
            </details>
          )}
          <div className="tb-item-actions">
            {item.url && (
              <a className="tb-btn-link" href={item.url} target="_blank" rel="noreferrer">
                {item.status === 'booked'
                  ? 'Ver reserva'
                  : item.kind === 'lodging'
                    ? 'Ver hotel / reservar'
                    : 'Ver tarifa / comprar'}
              </a>
            )}
            {extraActions}
            {(item.option || item.booking) && (
              <button type="button" className="tb-btn-quiet" onClick={() => setMode('edit')}>
                Editar
              </button>
            )}
            {item.option && item.status !== 'booked' && (
              <button type="button" className="tb-btn-quiet" onClick={() => setMode('book')}>
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
