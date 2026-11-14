import { useState } from 'react'
import { services } from '../../application'
import {
  stopTitle,
  type BoardLeg,
  type BoardStop,
  type TripBoard,
} from '../../application/tripBoard/buildTripBoard'
import { applyPlan, chooseLodgingPlan } from '../../application/tripBoard/boardEdits'
import { airportLabel } from '../../application/tripBoard/places'
import {
  formatDayEs,
  formatDuration,
  formatWhenEs,
  localDate,
} from '../../application/tripBoard/time'
import { AddStayForm, ItemEditForm } from './BoardForms'
import { kindLabel, STATUS_LABEL } from './boardFormat'
import { ItemBlock, type GetActionProps } from './ItemBlock'
import { MiniCalendar, type DayRange } from './MiniCalendar'
import { PlaceImage } from './PlaceImage'
import type { PlaceMedia } from './placeMedia'
import { StayDates } from './StayDates'

function legLine(leg: BoardLeg, end: 'arrive' | 'depart'): string {
  const seg = end === 'arrive' ? leg.segments.at(-1) : leg.segments[0]
  if (!seg) return ''
  const name = [seg.flightNumber, seg.provider].filter(Boolean).join(' · ') || seg.title
  return name
}

function ArrivalDeparture({
  leg,
  end,
  otherLabel,
  onOpenLeg,
  onChanged,
}: {
  leg?: BoardLeg
  end: 'arrive' | 'depart'
  otherLabel?: string
  onOpenLeg: (id: string) => void
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  if (!leg) return null
  const title = end === 'arrive' ? 'Llegada' : 'Salida'
  if (leg.segments.length === 0) {
    return (
      <section className="tb-sec">
        <h3>{title}</h3>
        <p className="tb-pending-line">
          {end === 'arrive' ? `Desde ${leg.fromLabel}` : `Hacia ${leg.toLabel}`}
          {leg.dateHint ? ` · ${formatDayEs(leg.dateHint)}` : ''} — tramo por elegir
          {leg.routes.length > 0
            ? ` (${leg.routes.length} ${leg.routes.length === 1 ? 'opción' : 'opciones'})`
            : leg.related.length > 0
              ? ` (${leg.related.length} ${leg.related.length === 1 ? 'opción relacionada' : 'opciones relacionadas'})`
              : ' (sin opciones guardadas)'}
        </p>
        <button type="button" className="tb-btn-quiet" onClick={() => onOpenLeg(leg.id)}>
          {end === 'arrive' ? 'Elegir cómo llegar' : 'Elegir cómo salir'}
        </button>
      </section>
    )
  }
  const seg = end === 'arrive' ? leg.segments.at(-1)! : leg.segments[0]!
  const when = end === 'arrive' ? seg.endAt : seg.startAt
  const airport = end === 'arrive' ? seg.destination : seg.origin
  return (
    <section className="tb-sec">
      <h3>{title}</h3>
      <dl className="tb-fields">
        <div>
          <dt>{end === 'arrive' ? 'Llega' : 'Sale'}</dt>
          <dd>{formatWhenEs(when) ?? 'Horario por confirmar'} <small>(hora local)</small></dd>
        </div>
        <div>
          <dt>{seg.kind === 'flight' ? 'Vuelo' : 'Transporte'}</dt>
          <dd>{legLine(leg, end)}</dd>
        </div>
        {airport && (
          <div>
            <dt>{seg.kind === 'flight' ? 'Aeropuerto' : 'Lugar'}</dt>
            <dd>{airportLabel(airport)}</dd>
          </div>
        )}
        <div>
          <dt>{end === 'arrive' ? 'Desde' : 'Hacia'}</dt>
          <dd>{otherLabel}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>
            <span className={`tb-pill tb-pill-${leg.status}`}>{STATUS_LABEL[leg.status]}</span>
          </dd>
        </div>
      </dl>
      {editing ? (
        <ItemEditForm
          item={seg}
          onCancel={() => setEditing(false)}
          onDone={() => {
            setEditing(false)
            onChanged()
          }}
        />
      ) : (
        <div className="tb-item-actions">
          <button type="button" className="tb-btn-quiet" onClick={() => onOpenLeg(leg.id)}>
            Ver {seg.kind === 'flight' ? 'vuelo' : 'tramo'} y alternativas
          </button>
          {(seg.option || seg.booking) && (
            <button type="button" className="tb-btn-quiet" data-write onClick={() => setEditing(true)}>
              Editar horario
            </button>
          )}
        </div>
      )}
    </section>
  )
}

export function StopDetail({
  stop,
  board,
  media,
  tripId,
  onChanged,
  onOpenLeg,
  getActionProps,
  fallbackOffset,
}: {
  stop: BoardStop
  board: TripBoard
  media?: PlaceMedia
  tripId: string
  onChanged: () => void
  onOpenLeg: (id: string) => void
  getActionProps: GetActionProps
  fallbackOffset: (date: string) => string | undefined
}) {
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const arrival = board.legs.find((l) => l.id === stop.arrivalLegId)
  const departure = board.legs.find((l) => l.id === stop.departureLegId)

  async function choose(itemId: string) {
    setBusy(true)
    setError(null)
    try {
      await applyPlan(services.travelOptions, chooseLodgingPlan(stop, itemId))
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar')
    } finally {
      setBusy(false)
    }
  }

  const stayFrom = localDate(stop.checkIn) ?? localDate(stop.arriveAt) ?? arrival?.dateHint
  const stayTo = localDate(stop.checkOut) ?? localDate(stop.departAt) ?? departure?.dateHint

  const span = (from?: string, to?: string): DayRange | undefined =>
    from ? { from, to: to && to > from ? to : from } : undefined
  let mark: DayRange | undefined
  let maybe: DayRange | undefined
  if (stop.kind === 'origin') mark = span(localDate(stop.departAt))
  else if (stop.kind === 'end') mark = span(localDate(stop.arriveAt))
  else if (stop.kind === 'layover') mark = span(localDate(stop.arriveAt), localDate(stop.departAt))
  else if (stop.datesPending) {
    mark = span(localDate(stop.checkIn))
    maybe = stop.window ?? span(stayFrom, stayTo)
  } else mark = span(stayFrom, stayTo)
  const { startDate, endDate, returnLimit } = board.summary
  const tripSpan = span(startDate, endDate)
  const limit = returnLimit && endDate && returnLimit > endDate ? returnLimit : undefined
  const markLabel =
    stop.kind === 'origin' ? 'salida' : stop.kind === 'end' ? 'regreso' : stop.kind === 'layover' ? 'escala' : 'estancia'

  const done: string[] = []
  const todo: string[] = []
  if (arrival) {
    if (arrival.status === 'booked') done.push(`Llegada (${legLine(arrival, 'arrive')})`)
    else if (arrival.segments.length === 0) todo.push(`Elegir cómo llegar desde ${arrival.fromLabel}`)
    else todo.push(`Reservar llegada (${legLine(arrival, 'arrive')})`)
  }
  for (const l of stop.lodging.filter((x) => x.role === 'chosen')) {
    if (l.status === 'booked') done.push(`Hotel ${l.provider ?? l.title}`)
  }
  for (const p of stop.pending) if (!/llegar|salir/.test(p)) todo.push(p)
  if (departure) {
    if (departure.status === 'booked') done.push(`Salida (${legLine(departure, 'depart')})`)
    else if (departure.segments.length === 0) todo.push(`Elegir cómo ir a ${departure.toLabel}`)
    else todo.push(`Reservar salida (${legLine(departure, 'depart')})`)
  }

  return (
    <div className="tb-detail">
      <PlaceImage label={stop.label} media={media} showCredit />
      <p className="tb-detail-sub">
        <span className={`tb-kind tb-kind-${stop.kind}`}>{kindLabel(stop)}</span>{' '}
        {stopTitle(stop)}
        {stop.isNow && <span className="tb-now"> Ahora</span>}
      </p>

      <ArrivalDeparture
        leg={arrival}
        end="arrive"
        otherLabel={arrival?.fromLabel}
        onOpenLeg={onOpenLeg}
        onChanged={onChanged}
      />

      <section className="tb-sec">
        <h3>{stop.kind === 'layover' ? 'Escala' : stop.kind === 'stay' ? 'Estancia' : stop.kind === 'origin' ? 'Inicio' : 'Fin del viaje'}</h3>
        <div className="tb-when">
          <div className="tb-when-text">
            {stop.kind === 'layover' && (
              <p>
                Conexión de <strong>{formatDuration(stop.layoverMinutes)}</strong> en {stop.place?.airport ?? stop.label}. Sin hotel.
              </p>
            )}
            {stop.kind === 'stay' && (
              <StayDates stop={stop} board={board} onChanged={onChanged} fallbackOffset={fallbackOffset} />
            )}
            {stop.kind === 'origin' && <p>Sales el {formatWhenEs(stop.departAt)}.</p>}
            {stop.kind === 'end' && <p>Llegas el {formatWhenEs(stop.arriveAt)}.</p>}
          </div>
          <MiniCalendar mark={mark} maybe={maybe} trip={tripSpan} limit={limit} markLabel={markLabel} />
        </div>
      </section>

      {stop.kind === 'stay' && (
        <section className="tb-sec">
          <h3>Hospedaje</h3>
          {stop.lodging.length === 0 && <p className="tb-pending-line">Sin hotel guardado.</p>}
          {stop.lodging.map((l) => (
            <ItemBlock
              key={l.id}
              item={l}
              onChanged={onChanged}
              getActionProps={getActionProps}
              extraActions={
                l.role !== 'chosen' && l.option ? (
                  <button type="button" data-write disabled={busy} onClick={() => void choose(l.id)}>
                    Elegir este hotel
                  </button>
                ) : undefined
              }
            />
          ))}
          {stop.lodgingAlternatives.length > 0 && (
            <details className="tb-more">
              <summary>Otras opciones de hotel ({stop.lodgingAlternatives.length})</summary>
              {stop.lodgingAlternatives.map((l) => (
                <ItemBlock
                  key={l.id}
                  item={l}
                  compact
                  onChanged={onChanged}
                  getActionProps={getActionProps}
                  extraActions={
                    l.option ? (
                      <button type="button" data-write disabled={busy} onClick={() => void choose(l.id)}>
                        Elegir este hotel
                      </button>
                    ) : undefined
                  }
                />
              ))}
            </details>
          )}
          {error && <p className="status-bad">{error}</p>}
          {adding ? (
            <AddStayForm
              tripId={tripId}
              initial={{ place: stop.label, checkIn: stayFrom, checkOut: stayTo }}
              places={[...new Set(board.stops.map((s) => s.label))]}
              fallbackOffset={fallbackOffset}
              onCancel={() => setAdding(false)}
              onDone={() => {
                setAdding(false)
                onChanged()
              }}
            />
          ) : (
            <button type="button" className="tb-btn-quiet" data-write onClick={() => setAdding(true)}>
              Agregar otro hotel para estas fechas
            </button>
          )}
        </section>
      )}

      <ArrivalDeparture
        leg={departure}
        end="depart"
        otherLabel={departure?.toLabel}
        onOpenLeg={onOpenLeg}
        onChanged={onChanged}
      />

      {stop.extras.length > 0 && (
        <section className="tb-sec">
          <h3>También aquí</h3>
          {stop.extras.map((x) => (
            <ItemBlock key={x.id} item={x} onChanged={onChanged} getActionProps={getActionProps} />
          ))}
        </section>
      )}

      <section className="tb-sec">
        <h3>Reservado y pendiente</h3>
        <ul className="tb-checks">
          {done.map((d) => (
            <li key={`d-${d}`} className="tb-check-done">✓ {d}</li>
          ))}
          {todo.map((t) => (
            <li key={`t-${t}`} className="tb-check-todo">○ {t}</li>
          ))}
          {done.length + todo.length === 0 && <li className="muted">Nada que registrar aquí.</li>}
        </ul>
      </section>
    </div>
  )
}
