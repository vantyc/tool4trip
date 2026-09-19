import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { services } from '../../application'
import type { Trip } from '../../domain/types'
import { useOnline } from '../useOnline'

export function TripLayout() {
  const { tripId } = useParams<{ tripId: string }>()
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

  return (
    <div className="trip-layout">
      <header className="trip-header">
        <Link to="/" className="back">
          ← Tool4Trip
        </Link>
        <h1>{trip.title}</h1>
        <p className="muted">
          {trip.destination ?? '—'} · {trip.startDate} → {trip.endDate}
        </p>
        {trip.goals.length > 0 && (
          <ul className="goal-list">
            {trip.goals.map((g) => (
              <li key={g.id}>{g.label}</li>
            ))}
          </ul>
        )}
      </header>

      <nav className="trip-tabs" aria-label="Secciones del viaje">
        <NavLink end to={`/trips/${tripId}`}>
          Resumen
        </NavLink>
        <NavLink to={`/trips/${tripId}/options`}>Opciones</NavLink>
        <NavLink to={`/ask?tripId=${tripId}`}>Ask Travel</NavLink>
        <NavLink to={`/trips/${tripId}/bookings`}>Reservas</NavLink>
        <NavLink to={`/trips/${tripId}/itinerary`}>Itinerario</NavLink>
        <NavLink to={`/trips/${tripId}/checklist`}>Checklist</NavLink>
        <NavLink to={`/trips/${tripId}/notes`}>Notas</NavLink>
        <NavLink to={`/trips/${tripId}/docs`}>Docs</NavLink>
      </nav>

      <Outlet context={{ trip }} />
    </div>
  )
}
