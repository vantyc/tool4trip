import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { services } from '../../application'
import {
  buildTripBoard,
  stopTitle,
  type TripBoard,
} from '../../application/tripBoard/buildTripBoard'
import { formatDayEs, isoOffset, localDate } from '../../application/tripBoard/time'
import type { Trip } from '../../domain/types'
import { useCardActions } from '../tripPanel/useCardActions'
import { useCloudQuery } from '../useCloudQuery'
import { useOnline } from '../useOnline'
import { AddStayForm } from './BoardForms'
import { BoardSheet } from './BoardSheet'
import { BoardTrack } from './BoardTrack'
import { legGlyph, money } from './boardFormat'
import { Glyph } from './Glyph'
import { ItemBlock } from './ItemBlock'
import { LegDetail } from './LegDetail'
import { usePlaceMedia } from './placeMedia'
import { StopDetail } from './StopDetail'
import './tripBoard.css'

const TripMap = lazy(() => import('./TripMap'))

type Selection =
  | { type: 'stop'; id: string }
  | { type: 'leg'; id: string }
  | { type: 'add-stay' }
  | { type: 'list'; list: 'toQuote' | 'toDecide' | 'toBook' | 'other' }

/** Offset of the event nearest before `date`, for places without a known zone. */
function offsetNear(board: TripBoard, date: string): string | undefined {
  const stamps = [
    ...board.legs.flatMap((l) => [l.departAt, l.arriveAt]),
    ...board.stops.flatMap((s) => [s.checkIn, s.checkOut]),
  ].filter((x): x is string => Boolean(x && isoOffset(x)))
  stamps.sort()
  const before = stamps.filter((s) => (localDate(s) ?? '') <= date)
  return isoOffset(before.at(-1) ?? stamps[0])
}

const LIST_TITLE = {
  toQuote: 'Por cotizar',
  toDecide: 'Por decidir',
  toBook: 'Por reservar',
  other: 'Otras opciones guardadas',
} as const

export function TripBoardPage() {
  const { trip } = useOutletContext<{ trip: Trip }>()
  const online = useOnline()
  const [selection, setSelection] = useState<Selection | null>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const { data, loading, error, reload } = useCloudQuery(`trip-board:${trip.id}`, async () => {
    const [options, bookings, checklist] = await Promise.all([
      services.travelOptions.listByTrip(trip.id),
      services.bookings.listByTrip(trip.id),
      services.checklist.listByTrip(trip.id),
    ])
    return { options, bookings, checklist }
  })

  const board = useMemo(
    () =>
      data
        ? buildTripBoard({
            trip,
            options: data.options,
            bookings: data.bookings,
            checklist: data.checklist,
            now,
          })
        : undefined,
    [data, trip, now],
  )
  const media = usePlaceMedia(board?.stops ?? [])
  const { actionError, getActionProps } = useCardActions(trip, reload)
  const close = useCallback(() => setSelection(null), [])
  const openStop = useCallback((id: string) => setSelection({ type: 'stop', id }), [])
  const openLeg = useCallback((id: string) => setSelection({ type: 'leg', id }), [])

  if (loading && !data) return <p className="muted">Cargando tablero…</p>
  if (error && !data) return <p className="status-bad">{error.message}</p>
  if (!board) return null

  const s = board.summary
  const fallbackOffset = (date: string) => offsetNear(board, date)
  const selectedStop = selection?.type === 'stop' ? board.stops.find((x) => x.id === selection.id) : undefined
  const selectedLeg = selection?.type === 'leg' ? board.legs.find((x) => x.id === selection.id) : undefined
  const stays = board.stops.filter((x) => x.kind === 'stay').length
  const layovers = board.stops.filter((x) => x.kind === 'layover').length

  return (
    <section className="page tb-page">
      <div className="tb-summary" role="list">
        <div className="tb-tile" role="listitem">
          <span className="tb-tile-label">Fechas</span>
          <strong>
            {s.startDate ? formatDayEs(s.startDate, false) : formatDayEs(trip.startDate, false)} →{' '}
            {s.endDate ? formatDayEs(s.endDate, false) : formatDayEs(trip.endDate, false)}
          </strong>
          <span>{s.nights !== undefined ? `${s.nights} noches` : 'por definir'}</span>
        </div>
        <div className="tb-tile" role="listitem">
          <span className="tb-tile-label">Costo cotizado</span>
          <strong>{money(s.quoted, s.currency) ?? '—'}</strong>
          <span>sólo lo elegido</span>
        </div>
        <div className="tb-tile" role="listitem">
          <span className="tb-tile-label">Pagado</span>
          <strong>{money(s.paid, s.currency)}</strong>
          <span>por pagar {money(s.toPay, s.currency)}</span>
        </div>
        {(['toQuote', 'toDecide', 'toBook'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="listitem"
            className={`tb-tile tb-tile-btn tb-tile-${k}`}
            onClick={() => setSelection({ type: 'list', list: k })}
            disabled={s[k].length === 0}
          >
            <span className="tb-tile-label">{LIST_TITLE[k]}</span>
            <strong>{s[k].length}</strong>
            <span className="tb-tile-sub">{s[k][0] ?? 'nada'}</span>
          </button>
        ))}
        <div className="tb-tile" role="listitem">
          <span className="tb-tile-label">Paradas</span>
          <strong>{board.stops.length}</strong>
          <span>
            {layovers} {layovers === 1 ? 'escala' : 'escalas'} · {stays} {stays === 1 ? 'estancia' : 'estancias'}
          </span>
        </div>
      </div>

      {board.alerts.length > 0 && (
        <ul className="tb-alerts">
          {board.alerts.map((a) => (
            <li key={a.id} className={`tb-alert tb-alert-${a.level}`}>
              <button
                type="button"
                className="tb-linkish"
                onClick={() => (a.stopId ? openStop(a.stopId) : a.legId ? openLeg(a.legId) : undefined)}
              >
                {a.level === 'warn' ? '⚠ ' : 'ℹ '}
                {a.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      {actionError && <p className="status-bad">{actionError}</p>}

      <div className="tb-toolbar">
        <button type="button" onClick={() => setSelection({ type: 'add-stay' })}>
          Agregar estancia
        </button>
        {board.unplaced.length > 0 && (
          <button type="button" className="tb-btn-quiet" onClick={() => setSelection({ type: 'list', list: 'other' })}>
            Otras opciones ({board.unplaced.length})
          </button>
        )}
        <span className="tb-legend">
          <span className="tb-dot tb-dot-booked" /> reservado
          <span className="tb-dot tb-dot-quoted" /> cotizado
          <span className="tb-dot tb-dot-pending" /> pendiente
          <span className="tb-legend-dash" /> tramo por elegir
        </span>
      </div>

      {board.stops.length === 0 ? (
        <div className="tb-empty">
          <p>
            Todavía no hay vuelos ni hoteles con fechas en este viaje. Agrega una estancia o
            guarda opciones desde Ask Travel y aparecerán aquí.
          </p>
        </div>
      ) : (
        <div className="tb-main">
          <BoardTrack board={board} media={media} onOpenStop={openStop} onOpenLeg={openLeg} />
          <aside className="tb-aside">
            {online ? (
              <Suspense fallback={<div className="tb-map tb-map-loading">Cargando mapa…</div>}>
                <TripMap board={board} media={media} onSelectStop={openStop} onSelectLeg={openLeg} />
              </Suspense>
            ) : (
              <div className="tb-map tb-map-loading">El mapa necesita conexión.</div>
            )}
            <p className="tb-credits">
              Fotos de Wikipedia (crédito en cada parada). Mapa © colaboradores de OpenStreetMap.
            </p>
          </aside>
        </div>
      )}

      {selectedStop && (
        <BoardSheet title={stopTitle(selectedStop)} onClose={close}>
          <StopDetail
            stop={selectedStop}
            board={board}
            media={media.get(selectedStop.key)}
            tripId={trip.id}
            onChanged={reload}
            onOpenLeg={openLeg}
            getActionProps={getActionProps}
            fallbackOffset={fallbackOffset}
          />
        </BoardSheet>
      )}
      {selectedLeg && (
        <BoardSheet
          title={
            <>
              <Glyph name={legGlyph(selectedLeg.mode)} rotate={legGlyph(selectedLeg.mode) === 'plane' ? 90 : 0} />{' '}
              {selectedLeg.fromLabel} → {selectedLeg.toLabel}
            </>
          }
          onClose={close}
        >
          <LegDetail
            leg={selectedLeg}
            board={board}
            tripId={trip.id}
            onChanged={reload}
            onOpenStop={openStop}
            getActionProps={getActionProps}
          />
        </BoardSheet>
      )}
      {selection?.type === 'add-stay' && (
        <BoardSheet title="Agregar estancia" onClose={close}>
          <AddStayForm
            tripId={trip.id}
            places={[...new Set(board.stops.map((x) => x.label))]}
            fallbackOffset={fallbackOffset}
            onCancel={close}
            onDone={() => {
              close()
              reload()
            }}
          />
        </BoardSheet>
      )}
      {selection?.type === 'list' && (
        <BoardSheet title={LIST_TITLE[selection.list]} onClose={close}>
          {selection.list === 'other' ? (
            <div className="tb-detail">
              <p className="tb-form-note">
                Opciones guardadas que no encajan en la ruta actual (por ejemplo, otra ciudad de conexión).
              </p>
              {board.unplaced.map((i) => (
                <ItemBlock key={i.id} item={i} onChanged={reload} getActionProps={getActionProps} />
              ))}
            </div>
          ) : (
            <ul className="tb-checks">
              {s[selection.list].map((t) => (
                <li key={t} className="tb-check-todo">○ {t}</li>
              ))}
            </ul>
          )}
        </BoardSheet>
      )}
    </section>
  )
}
