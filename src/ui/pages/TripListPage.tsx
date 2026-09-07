import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { services } from '../../application'
import { DEMO_TRIP_ID, seedDemoTrip } from '../../seed/demoSanMiguel'
import { useOnline } from '../useOnline'

export function TripListPage() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const online = useOnline()

  const trips =
    useLiveQuery(async () => {
      const list = await services.trips.list()
      return list.sort((a, b) => a.startDate.localeCompare(b.startDate))
    }) ?? []

  async function handleSeed() {
    setBusy(true)
    setMessage(null)
    try {
      // Seed only — Node validators (fake-indexeddb / db.delete) must not run in the browser.
      await seedDemoTrip(services)
      setMessage('Seed FICTICIO / DEMO cargado.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Error al cargar seed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page">
      <h1>Tool4Trip</h1>
      <p className="muted">
        Organiza un viaje como fuente operativa. Los datos DEMO están marcados
        como FICTICIOS.
      </p>
      {!online && (
        <p className="offline-note">
          Sin conexión — puedes consultar viajes y documentos ya guardados.
        </p>
      )}

      <div className="actions">
        <button type="button" onClick={() => void handleSeed()} disabled={busy}>
          {busy ? 'Cargando…' : 'Cargar seed San Miguel (FICTICIO)'}
        </button>
        <Link to="/ask" className="sum-action">
          Ask Travel
        </Link>
        <Link to="/import" className="sum-action">
          Importar investigación
        </Link>
      </div>

      {message && <p className="flash">{message}</p>}

      {trips.length === 0 ? (
        <p className="muted">No hay viajes. Carga el seed demo para empezar.</p>
      ) : (
        <ul className="trip-list">
          {trips.map((trip) => (
            <li key={trip.id}>
              <Link to={`/trips/${trip.id}`}>
                <strong>{trip.title}</strong>
                <span>
                  {trip.startDate} → {trip.endDate}
                </span>
                {trip.id === DEMO_TRIP_ID && (
                  <span className="badge">DEMO</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
