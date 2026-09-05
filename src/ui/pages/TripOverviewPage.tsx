import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useOutletContext } from 'react-router-dom'
import { services } from '../../application'
import {
  formatClockHm,
  formatShortDate,
  formatTimeUntil,
} from '../../application/summary'
import type { ChecklistItem, DocumentMeta, Trip } from '../../domain/types'
import { DEMO_TRIP_ID } from '../../seed/demoSanMiguel'
import { useDocumentViewer } from '../documents/useDocumentViewer'

const DEMO_DEFAULT_NOW = '2026-09-20T10:00:00-06:00'

const DEMO_PRESETS = [
  { label: '20 sep 06:00 (antes del vuelo)', value: '2026-09-20T06:00:00-06:00' },
  { label: '20 sep 10:00 (siguiente: bus)', value: '2026-09-20T10:00:00-06:00' },
  { label: '20 sep 12:00 (en el bus)', value: '2026-09-20T12:00:00-06:00' },
  { label: '20 sep 18:30 (caminata)', value: '2026-09-20T18:30:00-06:00' },
  { label: '21 sep 18:00 (antes evento)', value: '2026-09-21T18:00:00-06:00' },
  { label: 'Hora real del dispositivo', value: 'real' },
] as const

function mark(importance: string): string {
  if (importance === 'crucial') return '★'
  if (importance === 'recommended') return '●'
  return '○'
}

export function TripOverviewPage() {
  const { trip } = useOutletContext<{ trip: Trip }>()
  const { open, Viewer } = useDocumentViewer()
  const isDemo = trip.id === DEMO_TRIP_ID
  const [clockPreset, setClockPreset] = useState<string>(
    isDemo ? DEMO_DEFAULT_NOW : 'real',
  )
  const [nowIso, setNowIso] = useState(() =>
    isDemo ? DEMO_DEFAULT_NOW : new Date().toISOString(),
  )

  function applyClock(preset: string) {
    setClockPreset(preset)
    if (preset === 'real') {
      setNowIso(new Date().toISOString())
    } else {
      setNowIso(preset)
    }
  }

  const now = new Date(nowIso)

  const summary = useLiveQuery(
    () => services.summary.getTripSummary(trip.id, new Date(nowIso)),
    [trip.id, nowIso],
  )

  const nextDocs =
    useLiveQuery(async () => {
      if (!summary?.next?.booking?.id) return [] as DocumentMeta[]
      return services.documents.listByBooking(summary.next.booking.id)
    }, [summary?.next?.booking?.id]) ?? []

  async function toggleCheck(item: ChecklistItem) {
    await services.checklist.save({
      ...item,
      status: item.status === 'open' ? 'done' : 'open',
    })
  }

  if (summary === undefined) {
    return <p className="muted">Cargando resumen…</p>
  }
  if (summary === null) {
    return <p className="status-bad">No se pudo cargar el resumen.</p>
  }

  const {
    current,
    next,
    today,
    crucial,
    openChecklist,
    nextReminders,
    todayLabel,
  } = summary

  return (
    <section className="page summary-page">
      {isDemo && (
        <div className="demo-clock">
          <label htmlFor="demo-clock">
            Reloj DEMO <span className="badge">FICTICIO</span>
          </label>
          <select
            id="demo-clock"
            value={clockPreset}
            onChange={(e) => applyClock(e.target.value)}
          >
            {DEMO_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {current && (
        <section className="sum-block" aria-labelledby="sum-now">
          <h2 id="sum-now" className="sum-label">
            Ahora
          </h2>
          <Link
            className="sum-card sum-card-now"
            to={`/trips/${trip.id}/items/${current.item.id}`}
          >
            <div className="sum-card-title">{current.title}</div>
            <div className="sum-card-meta">
              {formatClockHm(current.startAt)}
              {current.endAt ? `–${formatClockHm(current.endAt)}` : ''}
              {current.place ? ` · ${current.place}` : ''}
            </div>
          </Link>
        </section>
      )}

      <section className="sum-block sum-next-block" aria-labelledby="sum-next">
        <h2 id="sum-next" className="sum-label">
          Siguiente
        </h2>
        {next ? (
          <div className="sum-card sum-card-next">
            <Link
              className="sum-next-main"
              to={`/trips/${trip.id}/items/${next.item.id}`}
            >
              <div className="sum-next-time">
                <span className="sum-mark">{mark(next.importance)}</span>
                <span className="sum-hm">{formatClockHm(next.startAt)}</span>
              </div>
              <div className="sum-card-title">{next.title}</div>
              {next.startAt && (
                <div className="sum-countdown">
                  {formatTimeUntil(next.startAt, now)}
                </div>
              )}
              {next.place && (
                <div className="sum-card-meta">{next.place}</div>
              )}
            </Link>

            {nextReminders[0] && (
              <p className="sum-reminder">
                🔔{' '}
                {nextReminders[0].reminder.label.replace(
                  /^\[FICTICIO\]\s*/,
                  '',
                )}
              </p>
            )}

            <div className="sum-actions">
              {next.place && (
                <a
                  className="sum-action"
                  href={`https://maps.google.com/?q=${encodeURIComponent(next.place)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Ubicación
                </a>
              )}
              {next.booking?.phone && (
                <a className="sum-action" href={`tel:${next.booking.phone}`}>
                  Teléfono
                </a>
              )}
              {nextDocs[0] && (
                <button
                  type="button"
                  className="sum-action"
                  onClick={() => open(nextDocs[0]!.id)}
                >
                  Documento
                </button>
              )}
              <Link
                className="sum-action"
                to={`/trips/${trip.id}/items/${next.item.id}`}
              >
                Detalles
              </Link>
            </div>
          </div>
        ) : (
          <p className="muted sum-empty">No hay nada próximo.</p>
        )}
      </section>

      <section className="sum-block" aria-labelledby="sum-today">
        <h2 id="sum-today" className="sum-label">
          Hoy — {formatShortDate(todayLabel)}
        </h2>
        {today.length === 0 ? (
          <p className="muted sum-empty">Sin actividades hoy.</p>
        ) : (
          <ul className="sum-today-list">
            {today.map((item) => (
              <li key={item.item.id}>
                <Link to={`/trips/${trip.id}/items/${item.item.id}`}>
                  <span className="sum-mark">{mark(item.importance)}</span>
                  <span className="sum-hm">{formatClockHm(item.startAt)}</span>
                  <span className="sum-today-title">{item.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {crucial.length > 0 && (
        <section className="sum-block" aria-labelledby="sum-crucial">
          <h2 id="sum-crucial" className="sum-label">
            Crucial
          </h2>
          <ul className="sum-crucial-list">
            {crucial.map((item) => (
              <li key={item.item.id}>
                <Link to={`/trips/${trip.id}/items/${item.item.id}`}>
                  <span className="sum-mark">★</span>
                  <span>
                    {item.startAt
                      ? formatShortDate(item.startAt.slice(0, 10))
                      : '—'}{' '}
                    — {item.title}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sum-block" aria-labelledby="sum-missing">
        <h2 id="sum-missing" className="sum-label">
          Qué me falta
        </h2>
        {openChecklist.length === 0 ? (
          <p className="muted sum-empty">Nada pendiente.</p>
        ) : (
          <ul className="check-list sum-check">
            {openChecklist.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => void toggleCheck(item)}
                  />
                  <span>{item.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </section>

      {Viewer}
    </section>
  )
}
