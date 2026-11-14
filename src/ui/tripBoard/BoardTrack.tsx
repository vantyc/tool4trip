import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  stopTitle,
  type BoardLeg,
  type BoardStop,
  type TripBoard,
} from '../../application/tripBoard/buildTripBoard'
import {
  formatDayEs,
  formatDuration,
  localClock,
  localDate,
} from '../../application/tripBoard/time'
import { ITEM_STATUS_LABEL, kindLabel, legGlyph, STATUS_LABEL } from './boardFormat'
import { Glyph } from './Glyph'
import { PlaceImage } from './PlaceImage'
import type { PlaceMedia } from './placeMedia'

const CARD_MIN = 190
const CONNECTOR = 84

function stopLines(stop: BoardStop, board: TripBoard): [string, string] {
  const arrival = board.legs.find((l) => l.id === stop.arrivalLegId)
  const departure = board.legs.find((l) => l.id === stop.departureLegId)
  if (stop.kind === 'origin') {
    return [`${formatDayEs(stop.departAt) ?? ''} · sale ${localClock(stop.departAt) ?? '¿?'}`, stop.place?.code ? `${stop.place.code} · ${stop.place.airport}` : '']
  }
  if (stop.kind === 'end') {
    return [`${formatDayEs(stop.arriveAt) ?? ''} · llega ${localClock(stop.arriveAt) ?? '¿?'}`, stop.place?.code ? `${stop.place.code} · ${stop.place.airport}` : '']
  }
  if (stop.kind === 'layover') {
    return [
      `${formatDayEs(stop.arriveAt, false) ?? ''} · ${localClock(stop.arriveAt) ?? '¿?'} → ${localClock(stop.departAt) ?? '¿?'}`,
      `${formatDuration(stop.layoverMinutes)} de conexión`,
    ]
  }
  const chosen = stop.lodging.find((l) => l.role === 'chosen')
  const hotel = chosen
    ? `${chosen.provider ?? 'Hotel'} · ${ITEM_STATUS_LABEL[chosen.status].toLowerCase()}`
    : stop.lodging.length > 0
      ? 'Hotel por decidir'
      : 'Sin hotel'
  const split = board.splits.find(
    (s) => s.firstNights === undefined && (s.firstStopId === stop.id || s.secondStopId === stop.id),
  )
  if (split && split.firstStopId === stop.id) {
    return [`${formatDayEs(stop.checkIn, false) ?? '¿?'} → fechas por definir`, hotel]
  }
  if (stop.window && !stop.checkIn) {
    return [`Fechas por definir · hasta ${formatDayEs(stop.window.to, false)}`, hotel]
  }
  const from = localDate(stop.checkIn) ?? localDate(stop.arriveAt) ?? arrival?.dateHint
  const to = localDate(stop.checkOut) ?? localDate(stop.departAt) ?? departure?.dateHint
  const nights = stop.nights !== undefined ? ` · ${stop.nights} ${stop.nights === 1 ? 'noche' : 'noches'}` : ''
  return [`${formatDayEs(from, false) ?? '¿?'} → ${formatDayEs(to, false) ?? '¿?'}${nights}`, hotel]
}

function StopCard({
  stop,
  board,
  media,
  onOpen,
}: {
  stop: BoardStop
  board: TripBoard
  media?: PlaceMedia
  onOpen: (id: string) => void
}) {
  const [line1, line2] = stopLines(stop, board)
  return (
    <button
      type="button"
      className={`tb-card tb-card-${stop.kind} tb-status-${stop.status}${stop.isNow ? ' tb-card-now' : ''}`}
      onClick={() => onOpen(stop.id)}
      aria-label={`${kindLabel(stop)}: ${stopTitle(stop)}. ${line1}. ${line2}. ${STATUS_LABEL[stop.status]}.`}
    >
      <span className="tb-card-media">
        <PlaceImage label={stop.label} media={media} />
        <span className={`tb-kind tb-kind-${stop.kind}`}>{kindLabel(stop)}</span>
        <span className={`tb-dot tb-dot-${stop.status}`} title={STATUS_LABEL[stop.status]} />
        {stop.isNow && <span className="tb-now">Ahora</span>}
      </span>
      <span className="tb-card-body">
        <span className="tb-card-title">{stopTitle(stop)}</span>
        <span className="tb-card-line">{line1}</span>
        {line2 && <span className="tb-card-line tb-card-line2">{line2}</span>}
        {stop.pending.length > 0 && (
          <span className="tb-card-pending">
            {stop.pending[0]}
            {stop.pending.length > 1 && ` · +${stop.pending.length - 1}`}
          </span>
        )}
      </span>
    </button>
  )
}

function legCaption(leg: BoardLeg): string {
  if (leg.segments.length > 0) {
    const names = leg.segments.map((s) => s.flightNumber ?? s.provider ?? s.title.split(' ')[0]).join('+')
    const d = formatDuration(leg.durationMinutes)
    return d ? `${names} · ${d}` : names
  }
  const day = formatDayEs(leg.dateHint, false)
  return `Por elegir · ${day ?? 'fecha por definir'}`
}

function LegButton({
  leg,
  heading,
  onOpen,
}: {
  leg: BoardLeg
  heading: 0 | 90 | 180
  onOpen: (id: string) => void
}) {
  const glyph = legGlyph(leg.mode)
  return (
    <button
      type="button"
      className={`tb-leg tb-leg-${leg.status}${leg.isNow ? ' tb-leg-now' : ''}`}
      onClick={() => onOpen(leg.id)}
      aria-label={`${leg.fromLabel} a ${leg.toLabel}: ${legCaption(leg)}. ${STATUS_LABEL[leg.status]}.`}
    >
      <span className="tb-leg-icon">
        <Glyph name={glyph} rotate={glyph === 'plane' ? heading + 90 : 0} />
      </span>
      <span className="tb-leg-caption">{legCaption(leg)}</span>
    </button>
  )
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

export function BoardTrack({
  board,
  media,
  onOpenStop,
  onOpenLeg,
}: {
  board: TripBoard
  media: Map<string, PlaceMedia>
  onOpenStop: (id: string) => void
  onOpenLeg: (id: string) => void
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const vertical = width > 0 && width < 560
  const perRow = Math.max(2, Math.min(5, Math.floor((width + CONNECTOR) / (CARD_MIN + CONNECTOR))))
  const legAfter = (stop: BoardStop) => board.legs.find((l) => l.id === stop.departureLegId)

  if (vertical) {
    return (
      <div ref={ref} className="tb-track">
        <div className="tb-vertical">
        {board.stops.map((stop) => {
          const leg = legAfter(stop)
          return (
            <div key={stop.id} className="tb-vstep">
              <StopCard stop={stop} board={board} media={media.get(stop.key)} onOpen={onOpenStop} />
              {leg && (
                <div className={`tb-vconn tb-conn-${leg.segments.length ? 'set' : 'open'} tb-conn-${leg.status}`}>
                  <LegButton leg={leg} heading={90} onOpen={onOpenLeg} />
                </div>
              )}
            </div>
          )
        })}
        </div>
      </div>
    )
  }

  const rows: BoardStop[][] = []
  for (let i = 0; i < board.stops.length; i += perRow) rows.push(board.stops.slice(i, i + perRow))
  const columns = `repeat(${perRow - 1}, minmax(0, 1fr) ${CONNECTOR}px) minmax(0, 1fr)`

  return (
    <div ref={ref} className="tb-track">
      <div className="tb-serpentine" style={{ '--tb-cols': columns } as CSSProperties}>
      {width > 0 &&
        rows.map((row, r) => {
          const reversed = r % 2 === 1
          const col = (j: number) => (reversed ? 2 * (perRow - 1 - j) + 1 : 2 * j + 1)
          const last = row.at(-1)!
          const turnLeg = r < rows.length - 1 ? legAfter(last) : undefined
          return (
            <div key={r} className="tb-row-wrap">
              <div className="tb-row">
                {row.map((stop, j) => {
                  const leg = j < row.length - 1 ? legAfter(stop) : undefined
                  return (
                    <div key={stop.id} style={{ display: 'contents' }}>
                      <div className="tb-cell" style={{ gridColumn: col(j) }}>
                        <StopCard stop={stop} board={board} media={media.get(stop.key)} onOpen={onOpenStop} />
                      </div>
                      {leg && (
                        <div
                          className={`tb-conn tb-conn-${leg.segments.length ? 'set' : 'open'} tb-conn-${leg.status}${reversed ? ' tb-conn-rev' : ''}`}
                          style={{ gridColumn: reversed ? col(j) - 1 : col(j) + 1 }}
                        >
                          <LegButton leg={leg} heading={reversed ? 180 : 0} onOpen={onOpenLeg} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              {turnLeg && (
                <div className="tb-row tb-turn-row">
                  <div
                    className={`tb-turn tb-conn-${turnLeg.segments.length ? 'set' : 'open'} tb-conn-${turnLeg.status}`}
                    style={{ gridColumn: col(perRow - 1) }}
                  >
                    <LegButton leg={turnLeg} heading={90} onOpen={onOpenLeg} />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
