import { useState } from 'react'
import { Link } from 'react-router-dom'
import { services } from '../../application'
import { DEMO_TRIP_ID, seedDemoTrip } from '../../seed/demoSanMiguel'
import {
  FILIPINAS_TRIP_ID,
  seedFilipinasTrip,
} from '../../seed/filipinasNov2026'
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

  async function handleFilipinas() {
    setBusy(true)
    setMessage(null)
    try {
      await seedFilipinasTrip(services)
      reload()
      setMessage('Seed Filipinas noviembre 2026 cargado.')
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
        <button
          type="button"
          data-write
          onClick={() => void handleFilipinas()}
          disabled={busy || !online}
          style={{ marginTop: '8px' }}
        >
          {busy ? 'Cargando…' : 'Cargar Filipinas nov 2026'}
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
          <p>{deletion.pending.title}</p>
          <div className="ask-actions">
            <button
              type="button"
              disabled={deletion.deleting}
              onClick={() => void handleDeleteConfirmed()}
            >
              {deletion.deleting ? 'Eliminando…' : 'Sí, eliminar'}
            </button>
            <button
              type="button"
              disabled={deletion.deleting}
              onClick={() => setDeletion(cancelTripDeletion(deletion))}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {loading && <p>Cargando viajes…</p>}
      {trips.length === 0 && !loading && (
        <p className="not-found">
          No hay viajes en la nube. Usa Nuevo viaje o importa investigación.
        </p>
      )}
      {trips.length > 0 && (
        <ul className="trip-list">
          {trips.map((t) => (
            <li
              key={t.id}
              className={
                t.id === deletion.pending?.id ? 'trip-list-item pending' : ''
              }
            >
              <Link to={`/${t.id}`} className="trip-link">
                <strong>{t.title}</strong>
                <span className="trip-dates">
                  {t.startDate} – {t.endDate}
                </span>
              </Link>
              {t.id !== DEMO_TRIP_ID && t.id !== FILIPINAS_TRIP_ID && (
                <button
                  type="button"
                  className="trip-delete-trigger"
                  aria-label={`Eliminar ${t.title}`}
                  disabled={deletion.pending !== null}
                  onClick={() =>
                    setDeletion(requestTripDeletion(deletion, t))
                  }
                >
                  Eliminar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
