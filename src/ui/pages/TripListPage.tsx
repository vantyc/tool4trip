import { useState } from 'react'
import { Link } from 'react-router-dom'
import { services } from '../../application'
import { DEMO_TRIP_ID, seedDemoTrip } from '../../seed/demoSanMiguel'
import { migrateLocalTripsToCloud } from '../../application/migrateLocalTrips'
import { useOnline } from '../useOnline'
import { useCloudQuery } from '../useCloudQuery'

export function TripListPage() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const online = useOnline()

  const { data: trips = [], loading, error, reload } = useCloudQuery(
    online ? 'trips' : null,
    async () => {
      const list = await services.trips.list()
      return list.sort((a, b) => a.startDate.localeCompare(b.startDate))
    },
  )

  async function handleSeed() {
    setBusy(true)
    setMessage(null)
    try {
      await seedDemoTrip(services)
      reload()
      setMessage('Seed FICTICIO / DEMO cargado en la nube.')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Error al cargar seed')
    } finally {
      setBusy(false)
    }
  }

  async function handleMigrate() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await migrateLocalTripsToCloud()
      reload()
      if (result.count === 0) {
        setMessage('No hay viajes locales en este dispositivo para subir.')
      } else {
        setMessage(
          `Subidos ${result.count} viaje(s) de este dispositivo a la nube.`,
        )
      }
    } catch (err) {
      setMessage(
        err instanceof Error ? err.message : 'Error al migrar viajes locales',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page">
      <h1>Tool4Trip</h1>
      <p className="muted">
        Organiza un viaje como fuente operativa. Los datos viven en la nube
        (misma cuenta en todos tus dispositivos).
      </p>
      {!online && (
        <p className="offline-note">
          Sin conexión — se requiere red para listar o editar viajes.
        </p>
      )}
      {error && <p className="status-bad">{error.message}</p>}

      <div className="actions">
        <Link to="/new" className="sum-action sum-action-primary">
          Nuevo viaje
        </Link>
        <Link to="/ask" className="sum-action">
          Ask Travel
        </Link>
        <Link to="/import" className="sum-action">
          Importar investigación
        </Link>
        <button
          type="button"
          onClick={() => void handleMigrate()}
          disabled={busy || !online}
        >
          Subir viajes de este dispositivo
        </button>
        <button
          type="button"
          onClick={() => void handleSeed()}
          disabled={busy || !online}
        >
          {busy ? 'Cargando…' : 'Cargar seed San Miguel (FICTICIO)'}
        </button>
      </div>

      {message && <p className="flash">{message}</p>}

      {loading ? (
        <p className="muted">Cargando viajes…</p>
      ) : trips.length === 0 ? (
        <p className="muted">
          No hay viajes en la nube. Usa Nuevo viaje, importa investigación o
          sube viajes locales de este dispositivo.
        </p>
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
