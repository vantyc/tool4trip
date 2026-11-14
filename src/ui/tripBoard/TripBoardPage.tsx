import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { services } from '../../application'
import {
  buildTripBoard,
  stopTitle,
  type BoardTask,
  type BoardTicket,
  type TaskGroup,
  type TripBoard,
} from '../../application/tripBoard/buildTripBoard'
import { resolvePlace } from '../../application/tripBoard/places'
import {
  formatDayEs,
  isoOffset,
  localClock,
  localDate,
} from '../../application/tripBoard/time'
import type { Trip } from '../../domain/types'
import { PLAN_CHANGED_EVENT } from '../BudgetBar'
import { useCardActions } from '../tripPanel/useCardActions'
import { useCloudQuery } from '../useCloudQuery'
import { useOnline } from '../useOnline'
import { AddStayForm, type StaySlotChoice } from './BoardForms'
import { BoardSheet } from './BoardSheet'
import { BoardTrack } from './BoardTrack'
import {
  ITEM_STATUS_LABEL,
  legGlyph,
  money,
  PAY_LABEL,
  payState,
  TASK_GROUP_TITLE,
} from './boardFormat'
import { Glyph } from './Glyph'
import { ItemBlock } from './ItemBlock'
import { LegDetail } from './LegDetail'
import { MiniCalendar } from './MiniCalendar'
import { usePlaceMedia } from './placeMedia'
import { StopDetail } from './StopDetail'
import './tripBoard.css'

const TripMap = lazy(() => import('./TripMap'))

type Selection =
  | { type: 'stop'; id: string }
  | { type: 'leg'; id: string }
  | { type: 'add-stay' }
  | { type: 'cost' }
  | { type: 'other' }

const TASK_ORDER: TaskGroup[] = ['dates', 'quote', 'choose', 'hotels', 'book']

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

/** Dated stays an undated one can follow, with the span it would share. */
function stayChoices(board: TripBoard): StaySlotChoice[] {
  const out: StaySlotChoice[] = []
  for (const stop of board.stops) {
    if (stop.kind !== 'stay' || !stop.checkIn || stop.datesPending) continue
    const next = board.stops[stop.index + 1]
    const leg = board.legs.find((l) => l.id === stop.departureLegId)
    const from = localDate(stop.checkIn)!
    const to =
      localDate(next?.checkIn) ?? localDate(next?.arriveAt) ?? leg?.dateHint ?? localDate(stop.checkOut)
    if (!to || to <= from) continue
    out.push({ id: stop.id, title: stopTitle(stop), from, to })
  }
  return out
}

function isInternational(t: BoardTicket): boolean {
  const first = t.items[0]
  const a = resolvePlace(first?.origin)?.country
  const b = resolvePlace(first?.destination)?.country
  return Boolean(a && b && a !== b)
}

function quotedText(board: TripBoard): string {
  const hotels = board.stops
    .flatMap((st) => st.lodging)
    .filter((l) => l.role === 'chosen' && l.price !== undefined).length
  const parts = [
    board.summary.tickets.length ? ticketsText(board.summary.tickets) : undefined,
    hotels ? `${hotels} ${hotels === 1 ? 'hotel' : 'hoteles'}` : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(' + ') : 'Nada cotizado todavía'
}

function ticketsText(tickets: BoardTicket[]): string {
  const n = tickets.length
  const round = tickets.every((t) => t.roundTrip)
  const intl = tickets.every(isInternational)
  const bags = tickets.every((t) => t.withBaggage)
  return `${n} ${n === 1 ? 'boleto' : 'boletos'}${round ? (n === 1 ? ' redondo' : ' redondos') : ''}${intl ? (n === 1 ? ' internacional' : ' internacionales') : ''}${bags ? ', con equipaje' : ''}`
}

function missingText(board: TripBoard): string | undefined {
  const { hotels, legs, legsAreFlights } = board.summary.missing
  const parts = [
    hotels > 0 ? `${hotels} ${hotels === 1 ? 'hotel' : 'hoteles'}` : undefined,
    legs > 0
      ? `${legs} ${legsAreFlights ? (legs === 1 ? 'vuelo interno' : 'vuelos internos') : legs === 1 ? 'traslado' : 'traslados'}`
      : undefined,
  ].filter(Boolean)
  return parts.length ? `Faltan ${parts.join(' y ')}` : undefined
}

function TaskList({
  tasks,
  quoteIsFlights,
  onOpen,
}: {
  tasks: BoardTask[]
  quoteIsFlights: boolean
  onOpen: (t: BoardTask) => void
}) {
  const groups = TASK_ORDER.map((g) => [g, tasks.filter((t) => t.group === g)] as const).filter(
    ([, list]) => list.length > 0,
  )
  if (groups.length === 0) {
    return <p className="tb-tasks-done">Nada pendiente: todo está elegido y reservado.</p>
  }
  return (
    <div className="tb-task-groups">
      {groups.map(([g, list]) => (
        <section key={g} className={`tb-task-group tb-task-${g}`}>
          <h3>
            {g === 'quote' && !quoteIsFlights ? 'Cotizar traslados' : TASK_GROUP_TITLE[g]}{' '}
            <span className="tb-task-count">{list.length}</span>
          </h3>
          <ul>
            {list.map((t) => (
              <li key={t.id}>
                <button type="button" className="tb-task" onClick={() => onOpen(t)}>
                  <span className="tb-task-text">{t.text}</span>
                  {t.detail && <span className="tb-task-detail">{t.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function CostDetail({
  board,
  onOpenStop,
  onOpenLeg,
}: {
  board: TripBoard
  onOpenStop: (id: string) => void
  onOpenLeg: (id: string) => void
}) {
  const s = board.summary
  const hotelsOpen = board.tasks.filter((t) => t.group === 'hotels')
  const legsOpen = board.tasks.filter((t) => t.group === 'quote' || t.group === 'choose')
  return (
    <div className="tb-detail">
      <p className="tb-cost-total">
        Subtotal cotizado: <strong>{money(s.quoted, s.currency)}</strong>
        <br />
        <small>
          Solo lo elegido con precio. Las alternativas no se suman. No es el costo final: {missingText(board)?.toLowerCase() ?? 'no falta nada por cotizar'}.
        </small>
      </p>

      <section className="tb-sec">
        <h3>Boletos ({s.tickets.length})</h3>
        {s.tickets.map((t) => {
          const pay = payState(t)
          return (
            <button key={t.id} type="button" className="tb-cost-row" onClick={() => onOpenLeg(t.legIds[0]!)}>
              <span>
                <strong>{t.label}</strong>
                <small>
                  {t.roundTrip ? 'Ida y vuelta en un boleto, se suma una vez' : 'Un tramo'}
                  {t.withBaggage ? ' · equipaje incluido en la cotización' : ''}
                </small>
              </span>
              <span className="tb-cost-amount">
                {money(t.price, t.currency) ?? 'Sin cotizar'}
                <small>
                  {ITEM_STATUS_LABEL[t.status]}
                  {t.checkedAt ? ` · consultado ${formatDayEs(t.checkedAt, false)}` : ''} · {PAY_LABEL[pay].toLowerCase()}
                </small>
              </span>
            </button>
          )
        })}
      </section>

      <section className="tb-sec">
        <h3>Hoteles</h3>
        <p>
          Cotizado: <strong>{money(s.quotedLodging, s.currency)}</strong>
        </p>
        {board.stops.flatMap((st) =>
          st.lodging
            .filter((l) => l.role === 'chosen')
            .map((l) => (
              <button key={l.id} type="button" className="tb-cost-row" onClick={() => onOpenStop(st.id)}>
                <span>
                  <strong>
                    {l.provider ?? l.title} · {stopTitle(st)}
                  </strong>
                  <small>{st.nights !== undefined ? `${st.nights} noches` : 'noches por definir'}</small>
                </span>
                <span className="tb-cost-amount">
                  {money(l.price, l.currency) ?? 'Sin cotizar'}
                  <small>
                    {ITEM_STATUS_LABEL[l.status]}
                    {l.checkedAt ? ` · consultado ${formatDayEs(l.checkedAt, false)}` : ''} ·{' '}
                    {PAY_LABEL[payState(l)].toLowerCase()}
                  </small>
                </span>
              </button>
            )),
        )}
        {hotelsOpen.map((t) => (
          <button key={t.id} type="button" className="tb-cost-row" onClick={() => t.stopId && onOpenStop(t.stopId)}>
            <span>
              <strong>{t.text}</strong>
              <small>{t.detail}</small>
            </span>
            <span className="tb-cost-amount tb-pending-line">Sin elegir</span>
          </button>
        ))}
      </section>

      <section className="tb-sec">
        <h3>Vuelos y traslados internos</h3>
        {legsOpen.length === 0 && <p>Todos elegidos.</p>}
        {legsOpen.map((t) => (
          <button key={t.id} type="button" className="tb-cost-row" onClick={() => t.legId && onOpenLeg(t.legId)}>
            <span>
              <strong>{t.text}</strong>
              <small>{t.detail}</small>
            </span>
            <span className="tb-cost-amount tb-pending-line">{t.group === 'quote' ? 'Sin cotizar' : 'Sin elegir'}</span>
          </button>
        ))}
      </section>

      <section className="tb-sec">
        <h3>Pagos</h3>
        <p>
          Pagado: <strong>{money(s.paid, s.currency)}</strong> · por pagar de lo cotizado:{' '}
          <strong>{money(s.toPay, s.currency)}</strong>
        </p>
      </section>
    </div>
  )
}

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

  const firstData = useRef(true)
  useEffect(() => {
    if (!data) return
    if (firstData.current) {
      firstData.current = false
      return
    }
    window.dispatchEvent(new Event(PLAN_CHANGED_EVENT))
  }, [data])

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
  const openTask = useCallback(
    (t: BoardTask) => setSelection(t.legId ? { type: 'leg', id: t.legId } : { type: 'stop', id: t.stopId! }),
    [],
  )

  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    const appTitle = document.title
    const before = () => {
      document.title = trip.title
    }
    const after = () => {
      document.title = appTitle
      setPrinting(false)
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [trip.title])

  const printBoard = useCallback(async () => {
    setPrinting(true)
    setSelection(null)
    const photos = [...document.querySelectorAll<HTMLImageElement>('.tb-page img')]
    for (const img of photos) img.loading = 'eager'
    const loaded = Promise.all(
      photos.map((img) =>
        img.complete
          ? undefined
          : new Promise((resolve) => {
              img.addEventListener('load', resolve, { once: true })
              img.addEventListener('error', resolve, { once: true })
            }),
      ),
    )
    await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 6000))])
    const request = new CustomEvent('tb-print-request', { detail: { handled: false } })
    window.dispatchEvent(request)
    if (!request.detail.handled) window.print()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        void printBoard()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [printBoard])

  if (loading && !data) return <p className="muted">Cargando tablero…</p>
  if (error && !data) return <p className="status-bad">{error.message}</p>
  if (!board) return null

  const s = board.summary
  const fallbackOffset = (date: string) => offsetNear(board, date)
  const selectedStop = selection?.type === 'stop' ? board.stops.find((x) => x.id === selection.id) : undefined
  const selectedLeg = selection?.type === 'leg' ? board.legs.find((x) => x.id === selection.id) : undefined
  const missing = missingText(board)
  const chosenCount = s.booked + s.toBookCount
  const limitAfterEnd = s.returnLimit && s.endDate && s.returnLimit > s.endDate
  const tripStart = s.startDate ?? trip.startDate
  const tripEnd = s.endDate ?? trip.endDate
  const tripSpan = tripStart && tripEnd ? { from: tripStart, to: tripEnd } : undefined

  return (
    <section className="page tb-page">
      <div className="tb-summary" role="list">
        <div className="tb-tile tb-tile-dates" role="listitem">
          <span className="tb-tile-label">Fechas</span>
          <strong>
            {formatDayEs(s.startDate ?? trip.startDate, false)} → {formatDayEs(s.endDate ?? trip.endDate, false)}
          </strong>
          <span>
            {s.startsAt ? `sale ${localClock(s.startsAt)}` : ''}
            {s.endsAt ? ` · llega ${localClock(s.endsAt)}` : ''}
            {s.nights !== undefined ? ` · ${s.nights} noches` : ''}
          </span>
          {limitAfterEnd && (
            <span className="tb-tile-note">Regreso a más tardar el {formatDayEs(s.returnLimit, false)}</span>
          )}
        </div>
        {tripSpan && (
          <div className="tb-tile tb-tile-cal" role="listitem">
            <span className="tb-tile-label">Calendario</span>
            <MiniCalendar
              bare
              mark={tripSpan}
              limit={limitAfterEnd ? s.returnLimit : undefined}
              markLabel="viaje"
            />
          </div>
        )}
        <button
          type="button"
          role="listitem"
          className="tb-tile tb-tile-btn tb-tile-money"
          onClick={() => setSelection({ type: 'cost' })}
        >
          <span className="tb-tile-label">Financiero</span>
          <strong>{money(s.quoted, s.currency) ?? '—'}</strong>
          <span>Subtotal cotizado: {quotedText(board)}</span>
          {missing && <span className="tb-tile-note tb-tile-warn">{missing}</span>}
        </button>
        <div className="tb-tile tb-tile-booked" role="listitem">
          <span className="tb-tile-label">Reservaciones</span>
          <strong>
            {s.booked} de {chosenCount}
          </strong>
          <span>{s.booked === 0 ? 'Nada reservado todavía' : 'reservas registradas'}</span>
        </div>
        <div className="tb-tile tb-tile-paid" role="listitem">
          <span className="tb-tile-label">Pagado</span>
          <strong>{money(s.paid, s.currency)}</strong>
          <span>por pagar {money(s.toPay, s.currency)} de lo cotizado</span>
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
        <h2>Recorrido elegido</h2>
        <button type="button" data-write onClick={() => setSelection({ type: 'add-stay' })}>
          Agregar estancia
        </button>
        {board.unplaced.length > 0 && (
          <button type="button" className="tb-btn-quiet" onClick={() => setSelection({ type: 'other' })}>
            Otras opciones ({board.unplaced.length})
          </button>
        )}
        <button type="button" className="tb-btn-quiet" disabled={printing} onClick={() => void printBoard()}>
          {printing ? 'Preparando…' : 'Imprimir'}
        </button>
        <span className="tb-legend">
          <span><span className="tb-dot tb-dot-booked" /> reservado</span>
          <span><span className="tb-dot tb-dot-quoted" /> cotizado, sin reservar</span>
          <span><span className="tb-dot tb-dot-pending" /> pendiente</span>
          <span><span className="tb-legend-dash" /> tramo por elegir</span>
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
            <ol className="tb-map-key">
              {board.stops.map((st) => (
                <li key={st.id}>
                  <button type="button" className="tb-linkish" onClick={() => openStop(st.id)}>
                    <span className="tb-map-num">{st.index + 1}</span> {stopTitle(st)}
                  </button>
                </li>
              ))}
            </ol>
            <p className="tb-credits">
              Fotos de Wikipedia (crédito en cada parada). Mapa © colaboradores de OpenStreetMap.
            </p>
          </aside>
        </div>
      )}

      <section className="tb-tasks" aria-label="Pendientes">
        <h2>Pendientes</h2>
        <TaskList tasks={board.tasks} quoteIsFlights={s.missing.legsAreFlights} onOpen={openTask} />
      </section>

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
            after={stayChoices(board)}
            fallbackOffset={fallbackOffset}
            onCancel={close}
            onDone={() => {
              close()
              reload()
            }}
          />
        </BoardSheet>
      )}
      {selection?.type === 'cost' && (
        <BoardSheet title="Subtotal cotizado" onClose={close}>
          <CostDetail board={board} onOpenStop={openStop} onOpenLeg={openLeg} />
        </BoardSheet>
      )}
      {selection?.type === 'other' && (
        <BoardSheet title="Otras opciones guardadas" onClose={close}>
          <div className="tb-detail">
            <p className="tb-form-note">
              Opciones que no forman parte del recorrido elegido (otra ciudad de conexión u otra ruta).
              No se suman al subtotal.
            </p>
            {board.unplaced.map((i) => (
              <ItemBlock key={i.id} item={i} onChanged={reload} getActionProps={getActionProps} />
            ))}
          </div>
        </BoardSheet>
      )}
    </section>
  )
}
