import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { services } from '../../application'
import type { Trip } from '../../domain/types'

export function TripLayout() {
  const { tripId } = useParams<{ tripId: string }>()
  const [trip, setTrip] = useState<Trip | null | undefined>(undefined)

  useEffect(() => {
    if (!tripId) return
    let cancelled = false
    void services.trips.get(tripId).then((t) => {
      if (!cancelled) setTrip(t ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [tripId])

  if (trip === undefined) {
    return <p className="muted">Cargando viaje…</p>
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
          ← Viajes
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
