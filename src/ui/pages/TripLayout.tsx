import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom'
import { services } from '../../application'
import { tripControlSheet, type TripControlSheet } from '../../../shared/quoteLedger'
import type { Trip } from '../../domain/types'
import {
  FILIPINAS_TRIP_ID,
  ensureFilipinasEtravelQr,
} from '../../seed/filipinasNov2026'
import { BudgetBar } from '../BudgetBar'
import { TripControlDock } from '../TripControlDock'
import { useCloudQuery } from '../useCloudQuery'
import { useOnline } from '../useOnline'

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

type Ymd = { y: number; m: number; d: number }

function ymd(dateOrIso?: string): Ymd | undefined {
  const m = dateOrIso?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : undefined
}

function day(v: Ymd, withYear = true): string {
  return `${v.d} ${MONTHS[v.m - 1]}${withYear ? ` ${v.y}` : ''}`
}

/** Dates of the chosen itinerary; the saved end date reads as the return limit. */
function routeDates(sheet: TripControlSheet, trip: Trip): { range?: string; nights?: number; limit?: string } {
  const start = ymd(sheet.departure) ?? ymd(trip.startDate)
  const end = ymd(sheet.returnAt) ?? ymd(trip.endDate)
  if (!start || !end) return {}
  const range =
    start.y === end.y && start.m === end.m
      ? `${start.d} → ${day(end)}`
      : start.y === end.y
        ? `${day(start, false)} → ${day(end)}`
        : `${day(start)} → ${day(end)}`
  const nights = Math.round(
    (Date.UTC(end.y, end.m - 1, end.d) - Date.UTC(start.y, start.m - 1, start.d)) / 86_400_000,
  )
  const limitDate = ymd(trip.endDate)
  const limit =
    sheet.returnAt && limitDate && trip.endDate !== sheet.returnAt.slice(0, 10)
      ? `Regreso a más tardar el ${day(limitDate, false)}`
      : undefined
  return { range, nights: nights > 0 ? nights : undefined, limit }
}

const MORE_TABS = [
  { path: 'checklist', label: 'Checklist' },
  { path: 'notes', label: 'Notas' },
  { path: 'docs', label: 'Docs' },
] as const

export function TripLayout() {
  const { tripId } = useParams<{ tripId: string }>()
  const location = useLocation()
  const [trip, setTrip] = useState<Trip | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const online = useOnline()

  useEffect(() => {
    if (!tripId) return
    if (!online) {
      setError('Se requiere conexión para abrir este viaje.')
      setTrip(null)
      return
    }
    let cancelled = false
    setError(null)
    setTrip(undefined)
    void services.trips
      .get(tripId)
      .then((t) => {
        if (!cancelled) setTrip(t ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Error al cargar')
          setTrip(null)
        }
      })

    function onVis() {
      if (document.visibilityState !== 'visible' || !tripId) return
      void services.trips.get(tripId).then((t) => {
        if (!cancelled) setTrip(t ?? null)
      })
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [tripId, online])

  useEffect(() => {
    function closeMore(e: MouseEvent) {
      const open = document.querySelector<HTMLDetailsElement>('.trip-tab-more[open]')
      if (open && !open.contains(e.target as Node)) open.open = false
    }
    document.addEventListener('click', closeMore)
    return () => document.removeEventListener('click', closeMore)
  }, [])

  useEffect(() => {
    if (tripId !== FILIPINAS_TRIP_ID || !online) return
    void ensureFilipinasEtravelQr(services.documents).catch(() => {
      /* QR is best-effort until Docs refresh; calendar/API still load. */
    })
  }, [tripId, online])

  const { data: options = [] } = useCloudQuery(
    tripId ? `trip-control:${tripId}:${location.pathname}` : null,
    () => services.travelOptions.listByTrip(tripId!),
  )
  const onBoard = Boolean(tripId) && location.pathname.replace(/\/+$/, '') === `/trips/${tripId}`

  if (!online && !trip) {
    return (
      <section className="page">
        <p className="offline-note">
          Sin conexión — se requiere red para ver viajes en la nube.
        </p>
        <Link to="/">Volver</Link>
      </section>
    )
  }

  if (trip === undefined) {
    return <p className="muted">Cargando viaje…</p>
  }
  if (error) {
    return (
      <section className="page">
        <p className="status-bad">{error}</p>
        <Link to="/">Volver</Link>
      </section>
    )
  }
  if (!trip || !tripId) {
    return (
      <section className="page">
        <p>Viaje no encontrado.</p>
        <Link to="/">Volver</Link>
      </section>
    )
  }

  const sheet = tripControlSheet({
    startDate: trip.startDate,
    endDate: trip.endDate,
    options,
  })

  const dates = routeDates(sheet, trip)
  const activeMore = MORE_TABS.find((t) => location.pathname.startsWith(`/trips/${tripId}/${t.path}`))

  return (
    <div className="trip-layout">
      <header className="trip-header">
        <div className="trip-header-main">
          <Link to="/" className="trip-back">
            Mis viajes
          </Link>
          <h1>{trip.title}</h1>
          <ul className="trip-chips" aria-label="Datos del viaje">
            {dates.range && (
              <li className="trip-chip trip-chip-strong">
                {dates.range}
                {dates.nights !== undefined && <span> · {dates.nights} noches</span>}
              </li>
            )}
            {dates.limit && <li className="trip-chip">{dates.limit}</li>}
            {trip.destination && <li className="trip-chip">{trip.destination}</li>}
          </ul>
          <BudgetBar key={trip.id} trip={trip} refreshKey={location.pathname} onSaved={setTrip} />
        </div>

        <nav className="trip-tabs" aria-label="Secciones del viaje">
          <NavLink end to={`/trips/${tripId}`}>
            Tablero
          </NavLink>
          <NavLink to={`/trips/${tripId}/options`}>Opciones</NavLink>
          <NavLink to={`/ask?tripId=${tripId}`} data-write>
            Ask Travel
          </NavLink>
          <NavLink to={`/trips/${tripId}/bookings`}>Reservas</NavLink>
          <NavLink to={`/trips/${tripId}/itinerary`}>Itinerario</NavLink>
          <details key={location.pathname} className={`trip-tab-more${activeMore ? ' active' : ''}`}>
            <summary>{activeMore?.label ?? 'Más'}</summary>
            <div className="trip-tab-menu">
              {MORE_TABS.map((t) => (
                <NavLink key={t.path} to={`/trips/${tripId}/${t.path}`}>
                  {t.label}
                </NavLink>
              ))}
            </div>
          </details>
          {MORE_TABS.map((t) => (
            <NavLink key={t.path} to={`/trips/${tripId}/${t.path}`} className="trip-tab-inline">
              {t.label}
            </NavLink>
          ))}
          <NavLink to={`/trips/${tripId}/detalle`} className="trip-tab-appendix">
            Detalle e investigación
          </NavLink>
        </nav>
      </header>

      {!onBoard && <TripControlDock title={trip.title} sheet={sheet} />}

      <Outlet context={{ trip }} />
    </div>
  )
}
