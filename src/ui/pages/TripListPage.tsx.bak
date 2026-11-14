import { useState } from 'react'
import { Link } from 'react-router-dom'
import { services } from '../../application'
import { DEMO_TRIP_ID, seedDemoTrip } from '../../seed/demoSanMiguel'
import {
  cancelTripDeletion,
  confirmTripDeletion,
  initialTripDeletion,
  requestTripDeletion,
  visibleTrips,
} from '../../application/tripDeletion'
import { useOnline } from '../useOnline'
import { useCloudQuery } from '../useCloudQuery'

export function TripListPage() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [deletion, setDeletion] = useState(initialTripDeletion)
  const online = useOnline()

  const { data: allTrips = [], loading, error, reload } = useCloudQuery(
    online ? 'trips' : null,
    async () => {
      const list = await services.trips.list()
      return list.sort((a, b) => a.startDate.localeCompare(b.startDate))
    },
  )
  const trips = visibleTrips(allTrips, deletion)

  async function handleDeleteConfirmed() {
    setDeletion((s) => ({ ...s, deleting: true }))
    const next = await confirmTripDeletion(deletion, (id) =>
      services.trips.remove(id),
    )
    setDeletion(next)
  }

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
        <Link to="/new" className="sum-action sum-action-primary" data-write>
          Nuevo viaje
        </Link>
        <Link to="/ask" className="sum-action" data-write>
          Ask Travel
        </Link>
        <Link to="/import" className="sum-action" data-write>
          Importar investigación
        </Link>
        <button
          type="button"
          data-write
          onClick={() => void handleSeed()}
          disabled={busy || !online}
        >
          {busy ? 'Cargando…' : 'Cargar seed San Miguel (FICTICIO)'}
        </button>
      </div>

      {message && <p className="flash">{message}</p>}
      {deletion.error && (
        <p className="status-bad" role="alert">
          {deletion.error}
        </p>
      )}

      {deletion.pending && (
        <div
          className="ask-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="trip-delete-title"
        >
          <h3 id="trip-delete-title">¿Eliminar este viaje?</h3>
          <p>
            <strong>{deletion.pending.title}</strong>
          </p>
          <p className="muted">Esta acción no se puede deshacer.</p>
          <div className="actions">
            <button
              type="button"
              onClick={() => setDeletion((s) => cancelTripDeletion(s))}
              disabled={deletion.deleting}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void handleDeleteConfirmed()}
              disabled={deletion.deleting || !online}
            >
              {deletion.deleting ? 'Eliminando…' : 'Eliminar'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="muted">Cargando viajes…</p>
      ) : trips.length === 0 ? (
        <p className="muted">
          No hay viajes en la nube. Usa Nuevo viaje o importa investigación.
        </p>
      ) : (
        <ul className="trip-list">
          {trips.map((trip) => (
            <li key={trip.id} className="trip-row">
              <Link to={`/trips/${trip.id}`}>
                <strong>{trip.title}</strong>
                <span>
                  {trip.startDate} → {trip.endDate}
                </span>
                {trip.id === DEMO_TRIP_ID && (
                  <span className="badge">DEMO</span>
                )}
              </Link>
              <button
                type="button"
                className="trip-delete"
                data-write
                aria-label={`Eliminar ${trip.title}`}
                disabled={!online || deletion.deleting}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setDeletion((s) => requestTripDeletion(s, trip))
                }}
              >
                Eliminar
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
